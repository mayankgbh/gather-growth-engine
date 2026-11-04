import { readManagedEvents, parseEventReadQuery, ManagedEventInputError } from "@/lib/managed-outreach/events";
import { GET } from "@/app/api/managed-outreach/events/route";

jest.mock("@/lib/managed-outreach/auth", () => ({ getManagedOwner: jest.fn() }));
jest.mock("@/lib/prisma", () => ({ prisma: { workspace: { findUnique: jest.fn() }, managedOutreachEvent: { findMany: jest.fn() } } }));
const { getManagedOwner } = require("@/lib/managed-outreach/auth");
const { prisma } = require("@/lib/prisma");
const now = new Date("2026-11-04T21:00:00.000Z");
function row(id: string, createdAt = "2026-11-04T20:00:00.000Z", overrides: Record<string, any> = {}) {
  return { id, workspaceId: "owner-workspace", jobId: "job-a", type: "sent", providerMessageId: `provider-${id}`,
    occurredAt: new Date("2026-11-01T12:00:00Z"), createdAt: new Date(createdAt), dataJson: JSON.stringify({ provider: "instantly", source: "provider-email", threadId: "thread-a" }), ...overrides };
}
let rows: ReturnType<typeof row>[];
beforeEach(() => {
  jest.resetAllMocks(); rows = [row("a"), row("b"), row("c"), row("other", undefined, { workspaceId: "other-workspace" }), row("diagnostic", undefined, { type: "sender_dns_diagnostic" })];
  getManagedOwner.mockResolvedValue({ id: "owner-id" });
  prisma.workspace.findUnique.mockResolvedValue({ id: "owner-workspace" });
  prisma.managedOutreachEvent.findMany.mockImplementation(async ({ where, take }: any) => {
    return rows.filter(r => r.workspaceId === where.workspaceId && where.type.in.includes(r.type) && r.createdAt <= where.createdAt.lte
      && (!where.OR || r.createdAt < where.OR[0].createdAt.lt || (r.createdAt.getTime() === where.OR[1].createdAt.getTime() && r.id < where.OR[1].id.lt)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, take);
  });
});

it("replays old provider receipts by durable insertion time with stable keyset paging and workspace isolation", async () => {
  const first = await readManagedEvents("owner-workspace", { limit: 2 }, now);
  expect(first.events.map(e => e.id)).toEqual(["c", "b"]);
  expect(first.events[0]).toMatchObject({ occurredAt: "2026-11-01T12:00:00.000Z", recordedAt: "2026-11-04T20:00:00.000Z" });
  expect(first.events_has_more).toBe(true);
  expect(first.events_next_cursor).toEqual({ at: "2026-11-04T20:00:00.000Z", id: "b" });
  // A late arrival appears on the next scan, not inside the completed snapshot.
  rows.push(row("later", "2026-11-04T21:00:01.000Z"));
  const second = await readManagedEvents("owner-workspace", { limit: 2, before: first.events_next_cursor!, snapshotAt: first.events_snapshot_at }, new Date("2026-11-04T21:01:00Z"));
  expect(second.events.map(e => e.id)).toEqual(["a"]);
  expect(second.events_has_more).toBe(false);
  expect(second.events_next_cursor).toBeNull();
  const recovery = await readManagedEvents("owner-workspace", {}, new Date("2026-11-04T21:01:00Z"));
  expect(recovery.events.map(e => e.id)).toEqual(["later", "c", "b", "a"]);
  expect(prisma.managedOutreachEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "owner-workspace" }), take: 3 }));
});

it("returns the same immutable evidence again after a downstream write was missed", async () => {
  const first = await readManagedEvents("owner-workspace", {}, now);
  const retry = await readManagedEvents("owner-workspace", { snapshotAt: first.events_snapshot_at }, now);
  expect(retry).toEqual(first);
});

it.each([0, 201, -1, 1.5, NaN])("rejects unbounded or invalid limit %s", async limit => {
  await expect(readManagedEvents("owner-workspace", { limit }, now)).rejects.toThrow(ManagedEventInputError);
  expect(prisma.managedOutreachEvent.findMany).not.toHaveBeenCalled();
});

it("rejects ambiguous cursors, duplicate query parameters, future snapshots and unknown selectors", async () => {
  for (const query of ["events_before_at=2026-11-04", "events_before_id=a", "events_limit=1&events_limit=2", "workspaceId=other", "events_before_at=&events_before_id="]) {
    expect(() => parseEventReadQuery(new URLSearchParams(query))).toThrow(ManagedEventInputError);
  }
  await expect(readManagedEvents("owner-workspace", { snapshotAt: "2026-11-05T00:00:00Z" }, now)).rejects.toThrow(ManagedEventInputError);
  await expect(readManagedEvents("owner-workspace", { before: { at: now.toISOString(), id: "" } }, now)).rejects.toThrow(ManagedEventInputError);
  expect(prisma.managedOutreachEvent.findMany).not.toHaveBeenCalled();
});

it("rejects unauthorized calls before loading events or workspace metadata", async () => {
  getManagedOwner.mockResolvedValue(null);
  const response = await GET(new Request("https://example.com/api/managed-outreach/events"));
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  expect(prisma.managedOutreachEvent.findMany).not.toHaveBeenCalled();
});

it("scopes the route to the authenticated owner and fails closed without raw corrupt event data", async () => {
  const response = await GET(new Request("https://example.com/api/managed-outreach/events?events_limit=2"));
  expect(response.status).toBe(200);
  expect(prisma.workspace.findUnique).toHaveBeenCalledWith({ where: { userId: "owner-id" }, select: { id: true } });
  rows[2].dataJson = "synthetic-secret-corrupt-json";
  const failed = await GET(new Request("https://example.com/api/managed-outreach/events"));
  expect(failed.status).toBe(503);
  expect(JSON.stringify(await failed.json())).not.toContain("synthetic-secret");
});
