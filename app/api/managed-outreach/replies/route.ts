import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getManagedInstantlyClientForUserId } from "@/lib/managed-outreach/client";
import { classifyManagedReply, ManagedReplyError, parseManagedReplyInput } from "@/lib/managed-outreach/classify";
import { ManagedOutreachConflictError } from "@/lib/managed-outreach/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (!request.headers.get("content-type")?.startsWith("application/json")
      || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)) {
      return NextResponse.json({ error: "A same-origin JSON request is required." }, { status: 400, headers });
    }
    const raw = await request.text();
    if (raw.length > 12_000) return NextResponse.json({ error: "Request is too large." }, { status: 413, headers });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
    const input = parseManagedReplyInput(body);
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    const result = await classifyManagedReply(workspace.id, input, {
      getClient: () => getManagedInstantlyClientForUserId(owner.id, { timeoutMs: 3_000, maxPages: 5 }),
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof ManagedReplyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
    if (error instanceof ManagedOutreachConflictError) return NextResponse.json({ error: "The immutable reply evidence conflicts with saved campaign state.", code: "classification_conflict" }, { status: 409, headers });
    return NextResponse.json({ error: "Reply classification could not be completed; outreach remains held." }, { status: 503, headers });
  }
}
