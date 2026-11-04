import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Read-only operational evidence. Credentials and unrelated email bodies never leave the server. */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const senderEmail = new URL(request.url).searchParams.get("senderEmail")?.trim().toLowerCase();
    let migrations: { migration_name: string; finished_at: Date | null }[] | null = null;
    try {
      migrations = await prisma.$queryRaw`SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY started_at`;
    } catch { /* An unbaselined database must be inspected before applying migrations. */ }
    const base = { checkedAt: new Date().toISOString(), migrations, sendingEnabled: process.env.MANAGED_OUTREACH_SEND_ENABLED === "true" };
    if (!senderEmail) return NextResponse.json(base, { headers });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) return NextResponse.json({ error: "Invalid exact sender." }, { status: 400, headers });
    const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 5_000, maxPages: 8 });
    if (!client) return NextResponse.json({ ...base, error: "No saved Instantly connection." }, { status: 409, headers });
    const accounts = await client.listAccounts();
    if (!accounts.some(a => a.email.toLowerCase() === senderEmail)) return NextResponse.json({ error: "Sender is not in this workspace's account inventory." }, { status: 404, headers });
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const results = await Promise.allSettled([
      client.getAccountHealth(senderEmail, { startDate, endDate }),
      client.listCampaigns(),
    ]);
    const health = results[0].status === "fulfilled" ? results[0].value : null;
    const campaigns = results[1].status === "fulfilled" ? results[1].value.filter(c => c.email_list?.some(email => email.toLowerCase() === senderEmail)).map(c => ({ id: c.id, name: c.name, status: c.status })) : null;
    return NextResponse.json({ ...base, senderEmail, health, campaigns, complete: results.every(r => r.status === "fulfilled") }, { headers });
  } catch {
    return NextResponse.json({ error: "Operational evidence could not be completely checked." }, { status: 503, headers });
  }
}
