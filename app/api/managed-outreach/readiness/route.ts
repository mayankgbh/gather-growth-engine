import { NextResponse } from "next/server";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { prisma } from "@/lib/prisma";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const workspace = await prisma.workspace.findUnique({
      where: { userId: owner.id },
      select: { id: true, domain: true, instantlyKey: true },
    });
    const base = {
      checkedAt: new Date().toISOString(),
      workspaceExists: !!workspace,
      workspaceDomain: workspace?.domain ?? null,
      hasInstantlyConnection: !!workspace?.instantlyKey,
      hasDirectAttioConnection: !!process.env.ATTIO_API_KEY,
      hasOwnerAlertConnection: !!process.env.RESEND_API_KEY,
      sendingEnabled: false,
      activationBoundary: "Fresh checks are required immediately before provider activation. Provider delivery is asynchronous.",
    };
    if (!workspace?.instantlyKey) return NextResponse.json({ ...base, accounts: [], blockers: ["No saved Instantly connection in the authorized owner's workspace."] }, { headers });
    const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 5_000, maxPages: 8 });
    if (!client) return NextResponse.json({ ...base, accounts: [], blockers: ["Saved Instantly connection could not be loaded."] }, { headers });
    try {
      const accounts = await client.listAccounts();
      // Whitelist metadata: never return provider credentials, tokens or SMTP details.
      return NextResponse.json({ ...base, accounts: accounts.map(a => ({
        email: a.email, domain: a.email.split("@")[1]?.toLowerCase() ?? null,
        status: a.status ?? null,
        dailyLimit: typeof a.daily_limit === "number" && Number.isFinite(a.daily_limit) ? a.daily_limit : null,
        warmupStatus: a.warmup_status, setupPending: a.setup_pending,
        warmupScore: typeof a.stat_warmup_score === "number" && Number.isFinite(a.stat_warmup_score) ? a.stat_warmup_score : null,
        createdAt: typeof a.timestamp_created === "string" ? a.timestamp_created : null,
      })), blockers: accounts.length ? ["Sender health, candidate eligibility and fresh exclusions must pass before activation."] : ["Instantly returned no sending accounts."] }, { headers });
    } catch {
      return NextResponse.json({ ...base, accounts: [], blockers: ["Saved Instantly connection failed its account inventory check."] }, { status: 502, headers });
    }
  } catch {
    return NextResponse.json({ error: "Readiness could not be checked." }, { status: 503, headers });
  }
}
