import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";
import { syncManagedOutreach } from "@/lib/managed-outreach/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Owner-scoped reconciliation can pause campaigns; it never activates or sends a message. */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) return NextResponse.json({ error: "No workspace exists for the authorized owner." }, { status: 409, headers });
    const client = await getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 5_000, maxPages: 20 });
    if (!client) return NextResponse.json({ error: "No saved Instantly connection for the authorized owner." }, { status: 409, headers });
    return NextResponse.json(await syncManagedOutreach(workspace.id, client), { headers });
  } catch {
    return NextResponse.json({ error: "Managed outreach reconciliation could not be completed." }, { status: 503, headers });
  }
}
