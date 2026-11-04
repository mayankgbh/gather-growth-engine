import { GET, POST } from "@/app/api/managed-outreach/sender-reservation/route";
import { ManagedInstantlyError, planInstantlySenderRemoval } from "@/lib/managed-outreach/instantly";
jest.mock("@/lib/managed-outreach/auth", () => ({ getManagedOwner: jest.fn() }));
jest.mock("@/lib/managed-outreach/client", () => ({ getManagedInstantlyClientForUserId: jest.fn() }));
jest.mock("@/lib/prisma", () => ({ prisma: { workspace: { findUnique: jest.fn() }, managedOutreachJob: { findFirst: jest.fn() },
  managedOutreachEvent: { findUnique: jest.fn(), create: jest.fn(), upsert: jest.fn() } } }));
const { getManagedOwner } = require("@/lib/managed-outreach/auth");
const { getManagedInstantlyClientForUserId } = require("@/lib/managed-outreach/client");
const { prisma } = require("@/lib/prisma");
const sender = "mayank@example.net";
const campaign = { id: "a", name: "Existing", status: 1, email_list: [sender, "other@example.net"] };
const plan = planInstantlySenderRemoval(campaign, sender);
const input = { action: "remove_sender", senderEmail: sender, campaignId: campaign.id, fingerprint: plan.fingerprint };
let client: any;
function request(body: unknown = input, origin?: string) {
  return new Request("https://example.com/api/managed-outreach/sender-reservation", { method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
}
beforeEach(() => {
  jest.resetAllMocks();
  process.env.MANAGED_OUTREACH_SENDER_EMAIL = sender;
  process.env.MANAGED_OUTREACH_SEND_ENABLED = "false";
  getManagedOwner.mockResolvedValue({ id: "owner" });
  prisma.workspace.findUnique.mockResolvedValue({ id: "workspace" });
  client = { listAccounts: jest.fn().mockResolvedValue([{ email: sender }]),
    listAccountCampaigns: jest.fn().mockResolvedValue([{ campaign_id: "a", campaign_name: "Existing", status: 1 }]),
    getCampaign: jest.fn().mockResolvedValue(campaign), getSenderRemovalPlan: jest.fn().mockResolvedValue(plan), getAccountTagRemovalPlan: jest.fn().mockResolvedValue({ ...plan, removeTagIds: ["tag"] }), removeAccountTagsForCampaign: jest.fn(async (_id, _sender, _fp, audit) => { await audit(plan); return { ...plan, outcome: "removed", checkedAt: "2026-11-04T22:00:00Z" }; }), removeSenderFromCampaign: jest.fn(async (_id, _sender, _fp, audit) => {
      await audit(plan); return { ...plan, outcome: "removed", checkedAt: "2026-11-04T22:00:00Z" };
    }) };
  getManagedInstantlyClientForUserId.mockResolvedValue(client);
});
afterEach(() => { delete process.env.MANAGED_OUTREACH_SENDER_EMAIL; delete process.env.MANAGED_OUTREACH_SEND_ENABLED; });

describe("sender reservation setup endpoint", () => {
  it("authenticates owner before reading accounts or mutating", async () => {
    getManagedOwner.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(client.removeSenderFromCampaign).not.toHaveBeenCalled();
  });
  it("returns a read-only exact plan and saves intent before confirmed result", async () => {
    const preview = await GET(new Request("https://example.com/api/managed-outreach/sender-reservation?campaignId=a"));
    expect(await preview.json()).toMatchObject(plan);
    expect(prisma.managedOutreachEvent.create).not.toHaveBeenCalled();
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ outcome: "removed", prospectEmailSent: false });
    expect(prisma.managedOutreachEvent.create.mock.calls.map((args: any[]) => args[0].data.type)).toEqual(["sender_reservation_attempt", "sender_reservation_confirmed"]);
  });
  it("routes the tag plan and mutation only through exact-account tag unassignment", async () => {
    const preview = await GET(new Request("https://example.com/api/managed-outreach/sender-reservation?campaignId=a&tags=1"));
    expect(await preview.json()).toMatchObject({ action: "remove_sender_tags", removeTagIds: ["tag"] });
    const result = await POST(request({ ...input, action: "remove_sender_tags" }));
    expect(result.status).toBe(200);
    expect(client.removeAccountTagsForCampaign).toHaveBeenCalledWith("a", sender, plan.fingerprint, expect.any(Function));
    expect(client.removeSenderFromCampaign).not.toHaveBeenCalled();
    const data = JSON.parse(prisma.managedOutreachEvent.create.mock.calls[0][0].data.dataJson);
    expect(data.mutationFields).toEqual(["exact_account_tag_associations"]);
  });
  it.each([{ ...input, senderEmail: "other@example.net" }, { ...input, workspaceId: "other" }])("rejects caller-selected sender or workspace: %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(client.removeSenderFromCampaign).not.toHaveBeenCalled();
  });
  it("rejects live managed sending, own managed campaigns and unknown account mappings", async () => {
    process.env.MANAGED_OUTREACH_SEND_ENABLED = "true";
    expect((await POST(request())).status).toBe(409);
    process.env.MANAGED_OUTREACH_SEND_ENABLED = "false";
    prisma.managedOutreachJob.findFirst.mockResolvedValue({ id: "job" });
    expect((await POST(request())).status).toBe(409);
    prisma.managedOutreachJob.findFirst.mockResolvedValue(null);
    client.listAccountCampaigns.mockResolvedValue([]);
    expect((await POST(request())).status).toBe(409);
    expect(client.removeSenderFromCampaign).not.toHaveBeenCalled();
  });
  it("blocks repeated attempts instead of blindly resending an uncertain PATCH", async () => {
    prisma.managedOutreachEvent.findUnique.mockResolvedValue({ id: "previous-attempt" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ outcomeUnknown: true, evidenceRecordId: "previous-attempt" });
    expect(client.removeSenderFromCampaign).not.toHaveBeenCalled();
  });
  it("retains failed or uncertain outcomes after saved attempt", async () => {
    client.removeSenderFromCampaign.mockImplementation(async (_id: string, _sender: string, _fp: string, audit: any) => {
      await audit(plan); throw new ManagedInstantlyError("Reconciliation required.", { code: "provider_error", outcomeUnknown: true });
    });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ outcomeUnknown: true });
    expect(prisma.managedOutreachEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ type: "sender_reservation_failure" }) }));
  });
  it("rejects cross-origin requests and never exposes unexpected error details", async () => {
    expect((await POST(request(input, "https://attacker.example"))).status).toBe(400);
    client.listAccounts.mockRejectedValue(new Error("private-key-value"));
    const response = await POST(request());
    expect(JSON.stringify(await response.json())).not.toContain("private-key-value");
  });
});
