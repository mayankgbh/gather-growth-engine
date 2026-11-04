import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { getOwnerJobs, importCandidateJob, ManagedOutreachConflictError } from "@/lib/managed-outreach/store";
import { ManagedDispatchError, parseManagedImport, readManagedDispatchConfig, safeManagedJob } from "@/lib/managed-outreach/orchestrator";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    const config = readManagedDispatchConfig();
    const jobs = await getOwnerJobs(workspace.id);
    return NextResponse.json({ jobs: jobs.map(safeManagedJob), sendingEnabled: config.enabled, senderEmail: config.senderEmail || null }, { headers });
  } catch { return NextResponse.json({ error: "Managed campaign state is unavailable." }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (!request.headers.get("content-type")?.startsWith("application/json") || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)) {
      return NextResponse.json({ error: "A same-origin JSON request is required." }, { status: 400, headers });
    }
    const raw = await request.text();
    if (raw.length > 80_000) return NextResponse.json({ error: "Request is too large." }, { status: 413, headers });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
    const input = parseManagedImport(body);
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    const job = await importCandidateJob({ workspaceId: workspace.id, ...input });
    return NextResponse.json({ job: safeManagedJob(job), sendingConfirmed: false }, { status: 200, headers });
  } catch (error) {
    if (error instanceof ManagedDispatchError) return NextResponse.json({ error: error.message, code: error.code, reasons: error.reasons }, { status: error.status, headers });
    if (error instanceof ManagedOutreachConflictError) return NextResponse.json({ error: "This candidate conflicts with an existing campaign job." }, { status: 409, headers });
    return NextResponse.json({ error: "The campaign job could not be saved." }, { status: 503, headers });
  }
}
