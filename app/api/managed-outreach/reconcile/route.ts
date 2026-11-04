import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";
import { readManagedDispatchConfig } from "@/lib/managed-outreach/orchestrator";
import { inspectManagedStage } from "@/lib/managed-outreach/reconcile";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
async function inspect(request: Request, jobId: string) {
  const owner = await getManagedOwner(request);
  if (!owner) return { error: json({ error: "Unauthorized" }, 401) };
  if (!jobId || jobId.length > 100 || /[\s/?#]/.test(jobId)) return { error: json({ error: "Exact job ID required." }, 400) };
  const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
  if (!workspace) return { error: json({ error: "Owner workspace unavailable." }, 404) };
  const job = await prisma.managedOutreachJob.findFirst({ where: { workspaceId: workspace.id, id: jobId } });
  if (!job?.providerCampaignId) return { error: json({ error: "Known provider campaign not found for this owner job." }, 404) };
  const events = await prisma.managedOutreachEvent.findMany({ where: { workspaceId: workspace.id, jobId }, orderBy: { occurredAt: "asc" } });
  const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 8_000, maxPages: 20 });
  if (!client) return { error: json({ error: "Saved provider connection unavailable." }, 409) };
  const result = await inspectManagedStage(job, events, client, readManagedDispatchConfig());
  return { workspace, job, result };
}
export async function GET(request: Request) {
  try { const ctx = await inspect(request, new URL(request.url).searchParams.get("jobId") || ""); return ctx.error || json(ctx.result); }
  catch { return json({ error: "Stage evidence could not be completely read. No provider mutation was requested." }, 503); }
}
export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json") || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)) return json({ error: "Same-origin JSON required." }, 400);
    const raw = await request.text(); if (raw.length > 2000) return json({ error: "Request too large." }, 413);
    const body = JSON.parse(raw);
    if (!body || body.action !== "reconcile_stage" || typeof body.jobId !== "string" || !/^[a-f0-9]{64}$/.test(body.proofFingerprint) || Object.keys(body).some(key => !["action", "jobId", "proofFingerprint"].includes(key))) return json({ error: "Exact reviewed recovery proof required." }, 400);
    const ctx = await inspect(request, body.jobId); if (ctx.error) return ctx.error;
    if (!ctx.result.reconcilable || ctx.result.proofFingerprint !== body.proofFingerprint) return json({ error: "Stage recovery proof is not exact or no longer current.", ...ctx.result }, 409);
    const receiptId = `managed:staged:${ctx.job.id}:1`;
    await prisma.$transaction(async tx => {
      const changed = await tx.managedOutreachJob.updateMany({ where: { id: ctx.job.id, workspaceId: ctx.workspace.id, status: "uncertain", nextStep: 1,
        updatedAt: ctx.job.updatedAt, providerCampaignId: ctx.job.providerCampaignId, sequenceFingerprint: ctx.job.sequenceFingerprint, leaseToken: null, leaseUntil: null },
        data: { status: "staged", lastError: null, leaseToken: null, leaseUntil: null } });
      if (changed.count !== 1) throw new Error("Recovery state changed");
      await tx.managedOutreachEvent.create({ data: { id: receiptId, workspaceId: ctx.workspace.id, jobId: ctx.job.id,
        type: "staged", occurredAt: new Date(ctx.result.checkedAt), dataJson: JSON.stringify({ ...ctx.result.stageData, reconciliationProof: ctx.result.proofFingerprint }) } });
    });
    return json({ jobId: ctx.job.id, status: "staged", providerCampaignId: ctx.job.providerCampaignId, evidenceRecordId: receiptId, sendingConfirmed: false, providerMutations: 0 });
  } catch { return json({ error: "Stage recovery was not committed. No provider send, upload or campaign recreation was requested." }, 503); }
}
