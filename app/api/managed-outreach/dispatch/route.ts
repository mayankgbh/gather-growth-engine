import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { dispatchManagedJob, ManagedDispatchError, type ManagedDispatchInput } from "@/lib/managed-outreach/orchestrator";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (!request.headers.get("content-type")?.startsWith("application/json") || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)) {
      return NextResponse.json({ error: "A same-origin JSON request is required." }, { status: 400, headers });
    }
    const raw = await request.text();
    if (raw.length > 40_000) return NextResponse.json({ error: "Request is too large." }, { status: 413, headers });
    let input: ManagedDispatchInput;
    try { input = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    const result = await dispatchManagedJob({ userId: owner.id, workspaceId: workspace.id }, input);
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof ManagedDispatchError) return NextResponse.json({ error: error.message, code: error.code, reasons: error.reasons }, { status: error.status, headers });
    return NextResponse.json({ error: "Dispatch could not be completed; no send was confirmed." }, { status: 503, headers });
  }
}
