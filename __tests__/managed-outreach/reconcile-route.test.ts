import { GET, POST } from "@/app/api/managed-outreach/reconcile/route";
jest.mock("@/lib/managed-outreach/auth", () => ({ getManagedOwner: jest.fn() }));
jest.mock("@/lib/managed-outreach/client", () => ({ getManagedInstantlyClientForUserId: jest.fn() }));
jest.mock("@/lib/managed-outreach/reconcile", () => ({ inspectManagedStage: jest.fn() }));
jest.mock("@/lib/managed-outreach/orchestrator", () => ({ dispatchManagedJob: jest.fn(), validateClearances: jest.fn(), readManagedDispatchConfig: jest.fn(() => ({})), ManagedDispatchError: class extends Error {} }));
jest.mock("@/lib/prisma", () => ({ prisma: { workspace: { findUnique: jest.fn() }, managedOutreachJob: { findFirst: jest.fn(), updateMany: jest.fn() },
  managedOutreachEvent: { findMany: jest.fn(), create: jest.fn() }, $transaction: jest.fn() } }));
const { getManagedOwner } = require("@/lib/managed-outreach/auth");
const { getManagedInstantlyClientForUserId } = require("@/lib/managed-outreach/client");
const { inspectManagedStage } = require("@/lib/managed-outreach/reconcile");
const { dispatchManagedJob, validateClearances } = require("@/lib/managed-outreach/orchestrator");
const { prisma } = require("@/lib/prisma");
const fingerprint = "a".repeat(64);
const input = { action: "resume_empty_stage", jobId: "job", proofFingerprint: fingerprint, mailbox: {}, attioClearance: {}, bookingClearance: {} };
const request = (body: unknown = input) => new Request("https://example.com/api/managed-outreach/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  jest.clearAllMocks();
  getManagedOwner.mockResolvedValue({ id: "owner" });
  getManagedInstantlyClientForUserId.mockResolvedValue({});
  prisma.workspace.findUnique.mockResolvedValue({ id: "workspace" });
  prisma.managedOutreachJob.findFirst.mockResolvedValue({ id: "job", providerCampaignId: "campaign", updatedAt: new Date(), sequenceFingerprint: null, candidateJson: "{}" });
  prisma.managedOutreachEvent.findMany.mockResolvedValue([]);
  prisma.managedOutreachJob.updateMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation((fn: any) => fn(prisma));
  inspectManagedStage.mockResolvedValue({ recoverableEmptyStage: true, reconcilable: false, proofFingerprint: fingerprint, checkedAt: new Date().toISOString(), stageData: { campaignId: "campaign", sequenceFingerprint: "b".repeat(64), bodyHash: "hash", localDate: "2026-11-04" } });
  dispatchManagedJob.mockResolvedValue({ status: "staged", sendingConfirmed: false, providerCampaignId: "campaign" });
  validateClearances.mockImplementation(() => {});
});
describe("existing empty-stage recovery route", () => {
  it("requires owner authentication and exact reviewed proof before changing state", async () => {
    getManagedOwner.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request({ ...input, proofFingerprint: "c".repeat(64) }))).status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(dispatchManagedJob).not.toHaveBeenCalled();
  });
  it("keeps a GET read-only and persists recovery authorization before invoking full staging gates", async () => {
    await GET(new Request("https://example.com/api/managed-outreach/reconcile?jobId=job"));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "staged", resumedExistingCampaign: true, sendingConfirmed: false });
    expect(validateClearances.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    expect(prisma.managedOutreachEvent.create.mock.invocationCallOrder[0]).toBeLessThan(dispatchManagedJob.mock.invocationCallOrder[0]);
    expect(dispatchManagedJob).toHaveBeenCalledWith({ userId: "owner", workspaceId: "workspace" }, { ...input, action: "stage", proofFingerprint: undefined }, expect.anything());
  });
  it("does not stage after stale clearances or an optimistic-lock conflict", async () => {
    validateClearances.mockImplementationOnce(() => { throw new Error("stale"); });
    expect((await POST(request())).status).toBe(503);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    prisma.managedOutreachJob.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await POST(request())).status).toBe(503);
    expect(dispatchManagedJob).not.toHaveBeenCalled();
  });
});
