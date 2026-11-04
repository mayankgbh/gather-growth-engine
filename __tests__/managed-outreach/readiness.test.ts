import { GET } from "@/app/api/managed-outreach/readiness/route";

jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth", () => ({}));
jest.mock("@/lib/prisma", () => ({ prisma: {
  user: { findUnique: jest.fn() }, workspace: { findUnique: jest.fn() },
} }));
jest.mock("@/lib/encryption", () => ({ decrypt: jest.fn() }));

const { getServerSession } = require("next-auth");
const { prisma } = require("@/lib/prisma");
const { decrypt } = require("@/lib/encryption");
const serviceSecret = "service-secret-for-tests-only-".repeat(2);
const providerKey = "synthetic-provider-secret";
const encryptedKey = "synthetic-encrypted-secret";
const request = (token = serviceSecret) => new Request(
  "https://example.com/api/managed-outreach/readiness?userId=other-user&email=other@example.com",
  { headers: { Authorization: `Bearer ${token}` } },
);

describe("managed outreach readiness boundary", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let fetcher: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, MANAGED_OUTREACH_OWNER_EMAIL: "owner@example.com",
      MANAGED_OUTREACH_SERVICE_SECRET: serviceSecret, ATTIO_API_KEY: "synthetic-attio-secret",
      RESEND_API_KEY: "synthetic-resend-secret" };
    getServerSession.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: "owner-id", email: "owner@example.com" });
    prisma.workspace.findUnique.mockResolvedValue({ id: "workspace-id", domain: "example.com", instantlyKey: encryptedKey });
    decrypt.mockReturnValue(providerKey);
    fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    global.fetch = fetcher;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("rejects unauthorized callers before any owner, workspace or provider access", async () => {
    const response = await GET(request("wrong-secret"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a different signed-in user", async () => {
    getServerSession.mockResolvedValue({ user: { email: "other@example.com" } });
    expect((await GET(request("wrong-secret"))).status).toBe(401);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authorizes the owner's session and never follows caller-supplied workspace selectors", async () => {
    getServerSession.mockResolvedValue({ user: { email: "OWNER@example.com" } });
    const response = await GET(request("wrong-secret"));
    expect(response.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "owner@example.com" }, select: { id: true, email: true } });
    for (const [args] of prisma.workspace.findUnique.mock.calls) expect(args.where).toEqual({ userId: "owner-id" });
    expect((await response.json()).sendingEnabled).toBe(false);
  });

  it("reports a missing workspace or connection without making provider requests", async () => {
    for (const workspace of [null, { id: "workspace-id", domain: "example.com", instantlyKey: null }]) {
      prisma.workspace.findUnique.mockResolvedValue(workspace);
      const response = await GET(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ workspaceExists: !!workspace,
        hasInstantlyConnection: false, sendingEnabled: false, accounts: [],
        blockers: ["No saved Instantly connection in the authorized owner's workspace."] });
    }
    expect(decrypt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns only safe account metadata and performs only the inventory GET", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ items: [{
      email: "sender@example.com", status: 1, warmup_status: 1, setup_pending: false,
      daily_limit: 20, stat_warmup_score: 99, timestamp_created: "2026-10-01T00:00:00Z",
      smtp_password: "synthetic-smtp-secret", imap_password: "synthetic-imap-secret",
      access_token: "synthetic-access-secret", unrelated: { secret: "synthetic-nested-secret" },
    }] })));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ hasInstantlyConnection: true, hasDirectAttioConnection: true,
      hasOwnerAlertConnection: true, sendingEnabled: false, accounts: [{
        email: "sender@example.com", domain: "example.com", status: 1, dailyLimit: 20,
        warmupStatus: 1, setupPending: false, warmupScore: 99, createdAt: "2026-10-01T00:00:00Z",
      }] });
    expect(JSON.stringify(body)).not.toMatch(/synthetic-|service-secret|smtp|imap|access_token|unrelated/);
    expect(decrypt).toHaveBeenCalledWith(encryptedKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).pathname).toBe("/api/v2/accounts");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${providerKey}` } });
  });

  it("does not reflect nested objects in optional account metadata", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ items: [{ email: "sender@example.com",
      warmup_status: 1, setup_pending: false, daily_limit: { secret: "synthetic-nested-secret" },
      stat_warmup_score: { secret: "synthetic-nested-secret" }, timestamp_created: { secret: "synthetic-nested-secret" },
    }] })));
    const response = await GET(request());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.accounts).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("synthetic-");
  });

  it("redacts provider failures from responses and does not log their raw bodies", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      fetcher.mockResolvedValue(new Response(JSON.stringify({ message: providerKey, token: "synthetic-provider-response-secret" }), { status: 401 }));
      const response = await GET(request());
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toMatchObject({ hasInstantlyConnection: true, sendingEnabled: false, accounts: [],
        blockers: ["Saved Instantly connection failed its account inventory check."] });
      expect(JSON.stringify(body)).not.toContain("synthetic-");
      expect(errorLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it("fails closed on malformed inventory rather than reporting an empty success", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect((await response.json()).sendingEnabled).toBe(false);
  });

  it("redacts decryption or database errors", async () => {
    decrypt.mockImplementation(() => { throw new Error(providerKey); });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Readiness could not be checked." });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
