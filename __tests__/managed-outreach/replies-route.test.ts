import { POST } from "@/app/api/managed-outreach/replies/route";

jest.mock("@/lib/managed-outreach/auth", () => ({ getManagedOwner: jest.fn() }));
jest.mock("@/lib/managed-outreach/client", () => ({ getManagedInstantlyClientForUserId: jest.fn() }));
jest.mock("@/lib/managed-outreach/classify", () => ({ ...jest.requireActual("@/lib/managed-outreach/classify"), classifyManagedReply: jest.fn() }));
jest.mock("@/lib/prisma", () => ({ prisma: { workspace: { findUnique: jest.fn() } } }));
const { getManagedOwner } = require("@/lib/managed-outreach/auth");
const { getManagedInstantlyClientForUserId } = require("@/lib/managed-outreach/client");
const { classifyManagedReply, ManagedReplyError } = require("@/lib/managed-outreach/classify");
const { prisma } = require("@/lib/prisma");
const input = { incomingEmailId: "email-a", classification: "meeting_request", summary: "Asked about next week." };
function request(body: unknown = input, origin?: string) {
  return new Request("https://example.com/api/managed-outreach/replies?workspaceId=other-workspace", {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  getManagedOwner.mockResolvedValue({ id: "owner-id", email: "owner@example.com" });
  prisma.workspace.findUnique.mockResolvedValue({ id: "workspace-a" });
  classifyManagedReply.mockResolvedValue({ ...input, providerMessageId: "email-a", jobExternalId: "external-a", demoBooked: false, sendingHeld: true });
});

describe("managed reply classification endpoint", () => {
  it("rejects unauthorized requests before loading workspace or reply data", async () => {
    getManagedOwner.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(classifyManagedReply).not.toHaveBeenCalled();
  });

  it("uses the owner's exact workspace and provider loader, ignoring URL selectors", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({ where: { userId: "owner-id" }, select: { id: true } });
    expect(classifyManagedReply).toHaveBeenCalledWith("workspace-a", input, expect.objectContaining({ getClient: expect.any(Function) }));
    expect(await response.json()).toMatchObject({ classification: "meeting_request", demoBooked: false, jobExternalId: "external-a" });
    await classifyManagedReply.mock.calls[0][2].getClient();
    expect(getManagedInstantlyClientForUserId.mock.calls[0][0]).toBe("owner-id");
  });

  it.each([{ ...input, classification: "demo_booked" }, { ...input, email: "other@example.com" }, { ...input, workspaceId: "other-workspace" }])("rejects unknown classifications or caller-selected scope: %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(classifyManagedReply).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations", async () => {
    expect((await POST(request(input, "https://other.example.com"))).status).toBe(400);
    expect(classifyManagedReply).not.toHaveBeenCalled();
  });

  it("preserves not-found and immutable conflict statuses", async () => {
    for (const status of [404, 409]) {
      classifyManagedReply.mockRejectedValue(new ManagedReplyError("reply_unavailable", "Reply evidence unavailable.", status));
      expect((await POST(request())).status).toBe(status);
    }
  });

  it("does not expose provider credentials or database errors", async () => {
    classifyManagedReply.mockRejectedValue(new Error("synthetic-provider-secret"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-provider-secret");
  });
});
