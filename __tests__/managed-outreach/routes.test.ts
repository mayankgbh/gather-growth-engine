import { GET as jobsGet, POST as jobsPost } from "@/app/api/managed-outreach/jobs/route";
import { POST as dispatchPost } from "@/app/api/managed-outreach/dispatch/route";
jest.mock("@/lib/managed-outreach/auth", () => ({ getManagedOwner: jest.fn() }));
jest.mock("@/lib/prisma", () => ({ prisma: { workspace: { findUnique: jest.fn() } } }));
jest.mock("@/lib/managed-outreach/store", () => ({ getOwnerJobs: jest.fn(), importCandidateJob: jest.fn(), ManagedOutreachConflictError: class extends Error {} }));
jest.mock("@/lib/managed-outreach/orchestrator", () => ({
  dispatchManagedJob: jest.fn(), parseManagedImport: jest.fn(), readManagedDispatchConfig: jest.fn().mockReturnValue({ enabled: false, senderEmail: "sender@example.com" }),
  safeManagedJob: jest.fn(value => ({ jobId: value.id })), ManagedDispatchError: class extends Error {},
}));
const { getManagedOwner } = require("@/lib/managed-outreach/auth");
const { prisma } = require("@/lib/prisma");
const { importCandidateJob, getOwnerJobs } = require("@/lib/managed-outreach/store");
const { dispatchManagedJob, parseManagedImport } = require("@/lib/managed-outreach/orchestrator");
const request = (body = {}, headers = {}) => new Request("https://growth.example.com/api/managed-outreach/dispatch", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("managed outreach API authorization", () => {
  beforeEach(() => { jest.clearAllMocks(); getManagedOwner.mockResolvedValue(null); });
  it("rejects all unauthorized reads and mutations before querying private data", async () => {
    expect((await jobsGet(new Request("https://growth.example.com/api/managed-outreach/jobs"))).status).toBe(401);
    expect((await jobsPost(request())).status).toBe(401);
    expect((await dispatchPost(request())).status).toBe(401);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled(); expect(importCandidateJob).not.toHaveBeenCalled(); expect(dispatchManagedJob).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and non-JSON mutation requests", async () => {
    getManagedOwner.mockResolvedValue({ id: "owner", email: "owner@example.com" });
    expect((await dispatchPost(request({}, { Origin: "https://other.example.com" }))).status).toBe(400);
    expect((await jobsPost(request({}, { "Content-Type": "text/plain" }))).status).toBe(400);
    expect(dispatchManagedJob).not.toHaveBeenCalled(); expect(importCandidateJob).not.toHaveBeenCalled();
  });
  it("derives workspace ownership server-side instead of accepting caller workspace IDs", async () => {
    getManagedOwner.mockResolvedValue({ id: "owner", email: "owner@example.com" });
    prisma.workspace.findUnique.mockResolvedValue({ id: "owned-workspace" });
    dispatchManagedJob.mockResolvedValue({ status: "staged", sendingConfirmed: false });
    expect((await dispatchPost(request({ action: "stage", jobId: "job", workspaceId: "someone-else" }))).status).toBe(200);
    expect(dispatchManagedJob.mock.calls[0][0]).toEqual({ userId: "owner", workspaceId: "owned-workspace" });
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({ where: { userId: "owner" }, select: { id: true } });
  });
  it("uses no-store for private campaign state and does not expose job internals", async () => {
    getManagedOwner.mockResolvedValue({ id: "owner", email: "owner@example.com" }); prisma.workspace.findUnique.mockResolvedValue({ id: "owned-workspace" });
    getOwnerJobs.mockResolvedValue([{ id: "job", leaseToken: "internal-token", candidateJson: "private-body" }]);
    const response = await jobsGet(new Request("https://growth.example.com/api/managed-outreach/jobs"));
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(JSON.stringify(await response.json())).not.toMatch(/internal-token|private-body/);
  });
  it("imports only parsed candidate fields scoped to the owner", async () => {
    getManagedOwner.mockResolvedValue({ id: "owner", email: "owner@example.com" }); prisma.workspace.findUnique.mockResolvedValue({ id: "owned-workspace" });
    parseManagedImport.mockReturnValue({ externalId: "p1", candidate: {}, steps: [], experimentId: "e", variant: "A", senderEmail: "sender@example.com" });
    importCandidateJob.mockResolvedValue({ id: "job" });
    expect((await jobsPost(request({ workspaceId: "other-workspace" }))).status).toBe(200);
    expect(importCandidateJob.mock.calls[0][0].workspaceId).toBe("owned-workspace");
  });
});
