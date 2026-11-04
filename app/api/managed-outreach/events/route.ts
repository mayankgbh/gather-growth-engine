import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManagedOwner } from "@/lib/managed-outreach/auth";
import { ManagedEventInputError, parseEventReadQuery, readManagedEvents } from "@/lib/managed-outreach/events";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Replay immutable saved events to recover from a missed downstream write. */
export async function GET(request: Request) {
  try {
    const owner = await getManagedOwner(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const options = parseEventReadQuery(new URL(request.url).searchParams);
    const workspace = await prisma.workspace.findUnique({ where: { userId: owner.id }, select: { id: true } });
    if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404, headers });
    return NextResponse.json(await readManagedEvents(workspace.id, options), { headers });
  } catch (error) {
    if (error instanceof ManagedEventInputError) return NextResponse.json({ error: "Invalid event pagination." }, { status: 400, headers });
    return NextResponse.json({ error: "Campaign events could not be completely read. Keep the previous checkpoint." }, { status: 503, headers });
  }
}
