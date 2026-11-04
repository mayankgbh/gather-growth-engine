import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";
import { ManagedInstantlyError, planInstantlySenderRemoval } from "@/lib/managed-outreach/instantly";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });

/** Exact configured mailbox only. Native account mappings avoid guessing from unrelated campaigns. */
async function context(request: Request) {
  const owner = await getManagedOwner(request);
  if (!owner) return { error: json({ error: "Unauthorized" }, 401) };
  const senderEmail = process.env.MANAGED_OUTREACH_SENDER_EMAIL?.trim().toLowerCase();
  if (!senderEmail || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(senderEmail)) return { error: json({ error: "An exact existing sender must be configured first." }, 409) };
  const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
  const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 8_000, maxPages: 20 });
  if (!workspace || !client) return { error: json({ error: "No saved owner workspace or provider connection." }, 409) };
  const [accounts, mappings] = await Promise.all([client.listAccounts(), client.listAccountCampaigns(senderEmail)]);
  if (!accounts.some(account => account.email.toLowerCase() === senderEmail)) return { error: json({ error: "Configured sender is not an existing account in this workspace." }, 409) };
  if (new Set(mappings.map(row => row.campaign_id)).size !== mappings.length) return { error: json({ error: "Ambiguous duplicate provider campaign mappings." }, 409) };
  return { owner, senderEmail, workspace, client, mappings };
}

export async function GET(request: Request) {
  try {
    const ctx = await context(request);
    if (ctx.error) return ctx.error;
    const campaignId = new URL(request.url).searchParams.get("campaignId");
    if (!campaignId) return json({ senderEmail: ctx.senderEmail, checkedAt: new Date().toISOString(), complete: true,
      mappings: ctx.mappings, reserved: ctx.mappings.length === 0, sendingEnabled: process.env.MANAGED_OUTREACH_SEND_ENABLED === "true" });
    if (!ctx.mappings.some(row => row.campaign_id === campaignId)) return json({ error: "Campaign is not currently mapped to the configured sender." }, 409);
    const campaign = await ctx.client.getCampaign(campaignId);
    if (campaign.id !== campaignId) return json({ error: "Unexpected provider campaign identity." }, 409);
    const managed = await prisma.managedOutreachJob.findFirst({ where: { workspaceId: ctx.workspace.id, providerCampaignId: campaignId }, select: { id: true } });
    if (managed) return json({ error: "Managed outreach campaigns are excluded from sender reservation." }, 409);
    return json({ ...planInstantlySenderRemoval(campaign, ctx.senderEmail), checkedAt: new Date().toISOString(),
      source: "https://developer.instantly.ai/api-reference/campaign/patch-campaign" });
  } catch (error) {
    return json({ error: error instanceof ManagedInstantlyError ? error.message : "Sender reservation evidence could not be completely checked.",
      outcomeUnknown: false }, error instanceof ManagedInstantlyError && error.code === "launch_blocked" ? 409 : 503);
  }
}

/** Removal changes ONLY this mailbox's direct assignment; other senders and settings stay intact. */
export async function POST(request: Request) {
  let auditId: string | null = null;
  let workspaceId: string | null = null;
  let providerOutcomeConfirmed = false;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")
      || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)) return json({ error: "Same-origin JSON is required." }, 400);
    const raw = await request.text();
    if (raw.length > 2000) return json({ error: "Request too large." }, 413);
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || body.action !== "remove_sender" || typeof body.campaignId !== "string" || typeof body.senderEmail !== "string"
      || !/^[a-f0-9]{64}$/.test(body.fingerprint) || Object.keys(body).some(key => !["action", "campaignId", "senderEmail", "fingerprint"].includes(key))) return json({ error: "An exact saved sender-removal plan is required." }, 400);
    const ctx = await context(request);
    if (ctx.error) return ctx.error;
    if (process.env.MANAGED_OUTREACH_SEND_ENABLED === "true") return json({ error: "Sender reservation is a setup action; managed sending must remain disabled." }, 409);
    if (body.senderEmail !== ctx.senderEmail) return json({ error: "Only the explicitly configured sender may be reserved." }, 400);
    if (!ctx.mappings.some(row => row.campaign_id === body.campaignId)) return json({ error: "Campaign is no longer mapped to this sender. Re-read reservation evidence; no mutation requested." }, 409);
    const managed = await prisma.managedOutreachJob.findFirst({ where: { workspaceId: ctx.workspace.id, providerCampaignId: body.campaignId }, select: { id: true } });
    if (managed) return json({ error: "Managed outreach campaigns cannot be changed by this setup action." }, 409);
    workspaceId = ctx.workspace.id;
    const key = createHash("sha256").update(JSON.stringify([workspaceId, ctx.senderEmail, body.campaignId, body.fingerprint])).digest("hex");
    const operationId = `managed:sender-removal:${key}`;
    const previous = await prisma.managedOutreachEvent.findUnique({ where: { id: `${operationId}:attempt` } });
    if (previous) return json({ error: "This removal was previously attempted. Inspect its saved evidence and current provider state before another mutation.", evidenceRecordId: previous.id, outcomeUnknown: true }, 409);
    const result = await ctx.client.removeSenderFromCampaign(body.campaignId, ctx.senderEmail, body.fingerprint, async plan => {
      await prisma.managedOutreachEvent.create({ data: { id: `${operationId}:attempt`, workspaceId: ctx.workspace.id,
        type: "sender_reservation_attempt", occurredAt: new Date(), dataJson: JSON.stringify({ ...plan,
          source: "Instantly API v2 account mapping + GET/PATCH campaign", mutationFields: ["email_list"], countsAsCampaignSend: false }) } });
      auditId = operationId;
    });
    providerOutcomeConfirmed = true;
    const receiptId = `${operationId}:confirmed`;
    await prisma.managedOutreachEvent.create({ data: { id: receiptId, workspaceId: ctx.workspace.id,
      type: "sender_reservation_confirmed", occurredAt: new Date(result.checkedAt),
      dataJson: JSON.stringify({ ...result, source: "Instantly GET campaign after PATCH", countsAsCampaignSend: false }) } });
    return json({ ...result, evidenceRecordId: receiptId, prospectEmailSent: false });
  } catch (error) {
    const outcomeUnknown = providerOutcomeConfirmed || (error instanceof ManagedInstantlyError ? error.outcomeUnknown : !!auditId);
    if (auditId && workspaceId) {
      try {
        await prisma.managedOutreachEvent.upsert({ where: { id: `${auditId}:failure` }, create: {
          id: `${auditId}:failure`, workspaceId, type: "sender_reservation_failure", occurredAt: new Date(),
          dataJson: JSON.stringify({ outcomeUnknown, providerOutcomeConfirmed, countsAsCampaignSend: false,
            error: error instanceof ManagedInstantlyError ? error.message : "Reservation result could not be durably confirmed." }),
        }, update: {} });
      } catch { /* The earlier attempt remains the durable reconciliation marker. */ }
    }
    return json({ error: error instanceof ManagedInstantlyError ? error.message : "Sender reservation was not confirmed. Inspect provider state before retrying.", outcomeUnknown,
      ...(auditId ? { evidenceRecordId: `${auditId}:attempt` } : {}) }, error instanceof ManagedInstantlyError && error.code === "launch_blocked" ? 409 : 503);
  }
}
