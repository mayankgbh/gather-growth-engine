import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Only durable campaign facts and reply decisions are replayed. Operational
// preflight records, diagnostics and their configuration do not leave this API.
const REPLAY_TYPES = ["sent", "incoming_received", "reply_classified", "unsubscribed", "bounced", "complained", "demo_booked", "delivery_failure", "meeting_request", "positive_reply", "replied"];
export type EventCursor = { at: string; id: string };
export type EventReadOptions = { limit?: number; before?: EventCursor; snapshotAt?: string };
export class ManagedEventInputError extends Error {}

function timestamp(value: string, now: Date): Date {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || date > now) throw new ManagedEventInputError("Invalid event timestamp.");
  return date;
}

export function parseEventReadQuery(query: URLSearchParams): EventReadOptions {
  const allowed = ["events_limit", "events_before_at", "events_before_id", "events_snapshot_at"];
  if (Array.from(query.keys()).some(key => !allowed.includes(key) || query.getAll(key).length !== 1)) throw new ManagedEventInputError("Invalid event pagination.");
  const limit = query.has("events_limit") ? Number(query.get("events_limit")) : 100;
  const at = query.get("events_before_at"); const id = query.get("events_before_id");
  if (Boolean(at) !== Boolean(id) || (query.has("events_before_at") && (!at || !id))) throw new ManagedEventInputError("Both cursor fields are required.");
  return { limit, ...(at && id ? { before: { at, id } } : {}), ...(query.has("events_snapshot_at") ? { snapshotAt: query.get("events_snapshot_at")! } : {}) };
}

/** Read-only, replayable facts. Page by durable insertion time, not provider time,
 * so a late-ingested old message is not lost behind a received-time watermark. */
export async function readManagedEvents(workspaceId: string, options: EventReadOptions = {}, now = new Date(), db: Pick<PrismaClient, "managedOutreachEvent"> = prisma) {
  if (!workspaceId.trim() || !Number.isFinite(now.getTime())) throw new ManagedEventInputError("Invalid event scope.");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ManagedEventInputError("Event page limit must be between 1 and 200.");
  const snapshot = options.snapshotAt === undefined ? now : timestamp(options.snapshotAt, now);
  let before: { at: Date; id: string } | undefined;
  if (options.before) {
    if (typeof options.before.id !== "string" || !options.before.id.trim() || options.before.id.length > 250 || options.before.id.includes("\0")) throw new ManagedEventInputError("Invalid event cursor.");
    before = { at: timestamp(options.before.at, snapshot), id: options.before.id };
  }
  const rows = await db.managedOutreachEvent.findMany({
    where: { workspaceId, type: { in: REPLAY_TYPES }, createdAt: { lte: snapshot },
      ...(before ? { OR: [{ createdAt: { lt: before.at } }, { createdAt: before.at, id: { lt: before.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
    select: { id: true, jobId: true, type: true, providerMessageId: true, occurredAt: true, createdAt: true, dataJson: true },
  });
  const hasMore = rows.length > limit; const page = rows.slice(0, limit);
  const events = page.map(row => {
    const data: unknown = JSON.parse(row.dataJson);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid saved campaign evidence.");
    return { id: row.id, jobId: row.jobId, type: row.type, providerMessageId: row.providerMessageId,
      occurredAt: row.occurredAt.toISOString(), recordedAt: row.createdAt.toISOString(), data };
  });
  const last = page.at(-1);
  return { events, events_limit: limit, events_has_more: hasMore,
    events_next_cursor: hasMore && last ? { at: last.createdAt.toISOString(), id: last.id } : null,
    events_snapshot_at: snapshot.toISOString(), cursor_time_field: "recordedAt" as const };
}
