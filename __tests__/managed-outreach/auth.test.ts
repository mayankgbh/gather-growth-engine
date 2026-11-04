import { getManagedOwner } from "@/lib/managed-outreach/auth";
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth", () => ({}));
jest.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: jest.fn() } } }));
const { getServerSession } = require("next-auth");
const { prisma } = require("@/lib/prisma");

describe("managed outreach owner authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MANAGED_OUTREACH_OWNER_EMAIL = "owner@example.com";
    process.env.MANAGED_OUTREACH_SERVICE_SECRET = "s".repeat(48);
    getServerSession.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: "owner", email: "owner@example.com" });
  });
  it("rejects missing, wrong and short credentials without querying owner data", async () => {
    for (const token of ["", "bad", "x".repeat(48)]) {
      expect(await getManagedOwner(new Request("https://example.com", { headers: { Authorization: `Bearer ${token}` } }))).toBeNull();
    }
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
  it("restricts service access to the configured owner", async () => {
    await getManagedOwner(new Request("https://example.com", { headers: { Authorization: `Bearer ${"s".repeat(48)}` } }));
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "owner@example.com" }, select: { id: true, email: true } });
  });
  it("rejects a different signed-in user", async () => {
    getServerSession.mockResolvedValue({ user: { email: "someone@example.com" } });
    expect(await getManagedOwner(new Request("https://example.com"))).toBeNull();
  });
  it("is disabled without an owner configuration", async () => {
    delete process.env.MANAGED_OUTREACH_OWNER_EMAIL;
    expect(await getManagedOwner(new Request("https://example.com"))).toBeNull();
  });
});
