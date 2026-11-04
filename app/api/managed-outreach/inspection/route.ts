import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Read-only operational evidence. Credentials and unrelated email bodies never leave the server. */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const senderEmail = (new URL(request.url).searchParams.get("senderEmail") || process.env.MANAGED_OUTREACH_SENDER_EMAIL)?.trim().toLowerCase();
    let migrations: { migration_name: string; finished_at: Date | null }[] | null = null;
    try {
      migrations = await prisma.$queryRaw`SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY started_at`;
    } catch { /* An unbaselined database must be inspected before applying migrations. */ }
    const base = { checkedAt: new Date().toISOString(), migrations, sendingEnabled: process.env.MANAGED_OUTREACH_SEND_ENABLED === "true" };
    if (!senderEmail) {
      const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 5_000, maxPages: 8 });
      if (!client) return NextResponse.json({ ...base, candidates: [] }, { headers });
      const [accounts, campaigns] = await Promise.all([client.listAccounts(), client.listCampaigns()]);
      const active = campaigns.filter(c => c.status === 1);
      return NextResponse.json({ ...base, candidates: accounts.filter(a => a.status === 1 && !a.setup_pending && /^(?:mayank(?:[.]mehta)?|mayankmehta|mmehta|mehta)@/i.test(a.email)).map(a => ({ email: a.email, warmupScore: a.stat_warmup_score ?? null, dailyLimit: a.daily_limit ?? null, createdAt: a.timestamp_created ?? null, activeAssignments: active.filter(c => c.email_list?.some(e => e.toLowerCase() === a.email.toLowerCase())).map(c => ({ id: c.id, name: c.name, senderCount: c.email_list!.length })) })), unknownActiveAssignments: active.filter(c => !Array.isArray(c.email_list) || !c.email_list.length).length }, { headers });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) return NextResponse.json({ error: "Invalid exact sender." }, { status: 400, headers });
    const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 5_000, maxPages: 8 });
    if (!client) return NextResponse.json({ ...base, error: "No saved Instantly connection." }, { status: 409, headers });
    const accounts = await client.listAccounts();
    if (!accounts.some(a => a.email.toLowerCase() === senderEmail)) return NextResponse.json({ error: "Sender is not in this workspace's account inventory." }, { status: 404, headers });
    const endDate = new Date().toISOString().slice(0, 10);
    // Use a complete 31-day request window so low-volume mailboxes can provide
    // enough actual sending-day observations. Missing dates remain unknown.
    const startDate = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const results = await Promise.allSettled([
      client.getAccountHealth(senderEmail, { startDate, endDate }),
      client.listAccountCampaigns(senderEmail),
      client.listEmailsPage({ accountEmail: senderEmail, emailType: "received" }),
    ]);
    const health = results[0].status === "fulfilled" ? results[0].value : null;
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    const diagnostic = workspace ? await prisma.managedOutreachEvent.findFirst({ where: { workspaceId: workspace.id, type: "sender_dns_diagnostic" }, orderBy: { occurredAt: "desc" } }) : null;
    const diagnosticData = diagnostic ? JSON.parse(diagnostic.dataJson) : null;
    const dnsEvidence = diagnosticData?.email === senderEmail ? { checkedAt: diagnostic!.occurredAt.toISOString(), ...diagnosticData } : null;
    const campaigns = results[1].status === "fulfilled" ? results[1].value.map(c => ({ id: c.campaign_id, name: c.campaign_name, status: c.status })) : null;
    const replyPage = results[2].status === "fulfilled" && results[2].value.items.every(item => item.ue_type === 2 && item.eaccount.toLowerCase() === senderEmail) ? results[2].value : null;
    const replyCollection = replyPage ? { checkedAt: new Date().toISOString(), accessible: true, pageCount: 1,
      receivedCountOnPage: replyPage.items.filter(item => item.ue_type === 2).length,
      hasMore: !!replyPage.next_starting_after, completeHistory: !replyPage.next_starting_after,
      latestReceivedAtOnPage: replyPage.items.filter(item => item.ue_type === 2).map(item => item.timestamp_created).sort().at(-1) ?? null,
      source: "Instantly GET emails filtered by exact account and received direction; access evidence only, not a complete reply check." } : null;
    return NextResponse.json({ ...base, senderEmail, health, dnsEvidence, campaigns, replyCollection, complete: results.every(r => r.status === "fulfilled") && replyPage !== null }, { headers });
  } catch {
    return NextResponse.json({ error: "Operational evidence could not be completely checked." }, { status: 503, headers });
  }
}

/** Explicit DNS diagnostic for the configured sender; may generate internal provider test mail. */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (!request.headers.get("content-type")?.startsWith("application/json") || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)) return NextResponse.json({ error: "Same-origin JSON is required." }, { status: 400, headers });
    const raw = await request.text();
    if (raw.length > 1000) return NextResponse.json({ error: "Request too large." }, { status: 413, headers });
    const body = JSON.parse(raw);
    const senderEmail = process.env.MANAGED_OUTREACH_SENDER_EMAIL?.trim().toLowerCase();
    if (body.action !== "test_sender_dns" || !senderEmail || body.senderEmail !== senderEmail || Object.keys(body).some(k => !["action", "senderEmail"].includes(k))) return NextResponse.json({ error: "Only the explicitly configured sender can be tested." }, { status: 400, headers });
    const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 10_000, maxPages: 8 });
    if (!client) return NextResponse.json({ error: "No saved provider connection." }, { status: 409, headers });
    const result = await client.runAccountVitals(senderEmail);
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) throw new Error("Missing workspace");
    // Internal diagnostic evidence is separate from prospect sends and has no invented provider message ID.
    const id = `managed:sender-dns:${createHash("sha256").update(JSON.stringify(result)).digest("hex")}`;
    await prisma.managedOutreachEvent.upsert({ where: { id }, create: { id, workspaceId: workspace.id, type: "sender_dns_diagnostic", occurredAt: new Date(result.observedAt), dataJson: JSON.stringify(result) }, update: {} });
    return NextResponse.json({ ...result, evidenceRecordId: id }, { headers });
  } catch {
    return NextResponse.json({ error: "The diagnostic result was not confirmed; no prospect send was requested." }, { status: 503, headers });
  }
}
