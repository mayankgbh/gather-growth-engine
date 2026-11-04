import { createManagedInstantlyClient, ManagedInstantlyError } from "@/lib/managed-outreach/instantly";

const address = "buyer@example.com";
const campaign = {
  id: "campaign-1", name: "Single recipient", status: 2,
  email_list: ["mayank@example.net"], stop_on_reply: true, stop_on_auto_reply: true, stop_for_company: true,
  sequences: [{ steps: [{ type: "email", variants: [{ subject: "Research", body: "Hello" }] }] }],
};
const lead = { id: "lead-1", email: address, campaign: campaign.id, status: 1, email_reply_count: 0 };
function mail(id: string, overrides: Record<string, unknown> = {}) {
  return { id, message_id: `<${id}@example.com>`, timestamp_created: "2026-11-04T19:30:00.000Z",
    timestamp_email: "2026-11-04T19:29:00.000Z", subject: "Re: Research", eaccount: "mayank@example.net",
    to_address_email_list: "mayank@example.net", from_address_email: address, body: { text: "Interested" },
    thread_id: "same-thread", ue_type: 2, ...overrides };
}
function setup(...responses: unknown[]) {
  const fetcher = jest.fn();
  for (const value of responses) fetcher.mockResolvedValueOnce(new Response(JSON.stringify(value), { status: 200 }));
  return { fetcher, client: createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch }) };
}
function paths(fetcher: jest.Mock) { return fetcher.mock.calls.map(call => new URL(call[0]).pathname); }

describe("restricted Instantly adapter", () => {
  it("paginates mailbox inventory and excludes unrelated account configuration", async () => {
    const { client, fetcher } = setup(
      { items: [{ email: "a@example.net", warmup_status: 1, setup_pending: false, smtp_password: "do-not-expose" }], next_starting_after: "created&email" },
      { items: [{ email: "b@example.net", warmup_status: 0, setup_pending: true }] },
    );
    const result = await client.listAccounts();
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("smtp_password");
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("starting_after")).toBe("created&email");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
  });

  it("fails closed on an unexpected list response instead of returning no accounts", async () => {
    const { client } = setup({ data: [] });
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects pagination loops without returning a partial success", async () => {
    const { client } = setup({ items: [campaign], next_starting_after: "repeat" }, { items: [campaign], next_starting_after: "repeat" });
    await expect(client.listCampaigns()).rejects.toMatchObject({ code: "pagination_incomplete" });
  });

  it("rejects an exhausted page budget rather than advancing a scan watermark", async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [campaign], next_starting_after: "more" })));
    const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch, maxPages: 1 });
    await expect(client.listCampaigns()).rejects.toMatchObject({ code: "pagination_incomplete" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains separate provider IDs for multiple replies in one thread without unread filtering", async () => {
    const { client, fetcher } = setup({ items: [mail("reply-1")], next_starting_after: "cursor" }, { items: [mail("reply-2")] });
    const result = await client.listInboundEmails({ minCreatedAt: "2026-11-03T00:00:00Z", maxCreatedAt: "2026-11-04T20:00:00Z" });
    expect(result.map(item => item.id)).toEqual(["reply-1", "reply-2"]);
    const query = new URL(fetcher.mock.calls[0][0]).searchParams;
    expect(query.get("latest_of_thread")).toBe("false");
    expect(query.get("mode")).toBe("emode_all");
    expect(query.has("is_unread")).toBe(false);
    expect(query.get("email_type")).toBe("received");
  });

  it("does not count outgoing or directionless mail as an inbound reply", async () => {
    const { client } = setup({ items: [mail("outgoing", { ue_type: 1 })] });
    await expect(client.listInboundEmails()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("checks exact addresses and parent-domain blocklist entries on every page", async () => {
    const { client } = setup({ items: [{ id: "b1", bl_value: "unrelated.net", is_domain: true }], next_starting_after: "b1" },
      { items: [{ id: "b2", bl_value: "example.com", is_domain: true }] });
    await expect(client.isSuppressed("person@sub.example.com")).resolves.toBe(true);
  });

  it("adds an exact opt-out to native suppression without removing or broadening it", async () => {
    const block = { id: "block-1", bl_value: address, is_domain: false };
    const { client, fetcher } = setup({ items: [] }, block);
    await expect(client.suppressEmail(address)).resolves.toEqual(block);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ bl_value: address });
    expect(fetcher.mock.calls[1][1].method).toBe("POST");
  });

  it("does not recreate an existing exact suppression", async () => {
    const block = { id: "block-1", bl_value: address, is_domain: false };
    const { client, fetcher } = setup({ items: [block] });
    await expect(client.suppressEmail(address)).resolves.toEqual(block);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains webhook provenance without treating webhook success as email delivery", async () => {
    const event = { id: "hook-event-1", timestamp_created: "2026-11-04T19:30:00Z", success: true,
      retry_group_id: "event-group-1", payload: { event_type: "email_bounced", email: address } };
    const { client } = setup({ items: [event] });
    const result = await client.listWebhookEvents({ fromDate: "2026-11-04", toDate: "2026-11-04" });
    expect(result[0]).toMatchObject(event);
    expect(result[0]).not.toHaveProperty("delivered");
  });

  it("creates one step, explicitly pauses, and never auto-activates or chooses all workspace accounts", async () => {
    const { client, fetcher } = setup({ ...campaign, status: 0 }, campaign);
    await expect(client.createPausedCampaign({ name: "Draft", senderEmails: ["mayank@example.net"], subject: "Research", bodyText: "Hello <buyer>\nAgain" })).resolves.toMatchObject({ status: 2 });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({ email_list: ["mayank@example.net"], stop_on_reply: true, stop_on_auto_reply: true,
      stop_for_company: true, daily_limit: 1, open_tracking: false, link_tracking: false });
    expect(body.sequences[0].steps).toHaveLength(1);
    expect(body.sequences[0].steps[0].variants[0].body).toBe("Hello &lt;buyer&gt;<br/>Again");
    expect(body).not.toHaveProperty("status");
    expect(paths(fetcher)).toEqual(["/api/v2/campaigns", "/api/v2/campaigns/campaign-1/pause"]);
  });

  it("requires one explicit sender before any provider mutation", async () => {
    const { client, fetcher } = setup();
    await expect(client.createPausedCampaign({ name: "Draft", senderEmails: [], subject: "Research", bodyText: "Hello" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains the created campaign ID when the pause confirmation fails", async () => {
    const { client, fetcher } = setup({ ...campaign, status: 0 });
    fetcher.mockRejectedValueOnce(new Error("network error"));
    await expect(client.createPausedCampaign({ name: "Draft", senderEmails: ["mayank@example.net"], subject: "Research", bodyText: "Hello" })).rejects.toMatchObject({ outcomeUnknown: true, providerId: "campaign-1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses to upload into an active campaign", async () => {
    const { client, fetcher } = setup({ ...campaign, status: 1 });
    await expect(client.uploadVerifiedLead(campaign.id, { email: address, verificationEvidence: "verified-saved-record" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(paths(fetcher)).toEqual(["/api/v2/campaigns/campaign-1"]);
  });

  it("uploads a verified lead with duplicate and blocklist protections without buying verification", async () => {
    const receipt = { status: "success", leads_uploaded: 1, in_blocklist: 0, duplicated_leads: 0, skipped_count: 0, invalid_email_count: 0, created_leads: [{ id: "lead-1", index: 0, email: address }] };
    const { client, fetcher } = setup(campaign, { items: [] }, receipt);
    await expect(client.uploadVerifiedLead(campaign.id, { email: address, verificationEvidence: "verified-saved-record" })).resolves.toEqual(receipt);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ skip_if_in_workspace: true, skip_if_in_campaign: true, verify_leads_on_import: false });
    expect(paths(fetcher).some(path => path.includes("activate"))).toBe(false);
  });

  it("marks timed-out mutation outcomes unknown and does not retry", async () => {
    const fetcher = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch, timeoutMs: 5 });
    await expect(client.pauseCampaign(campaign.id)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider error bodies or credentials", async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response("secret echoed by provider", { status: 401 }));
    const client = createManagedInstantlyClient("never-echo-this", { fetch: fetcher as typeof fetch });
    try { await client.listAccounts(); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(ManagedInstantlyError);
      expect(String(error)).not.toMatch(/secret|never-echo/);
      expect(error).toMatchObject({ status: 401, outcomeUnknown: false });
    }
  });

  it("refuses activation without a recent external preflight", async () => {
    const { client, fetcher } = setup();
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date(Date.now() - 61_000).toISOString(), expectedRecipientEmail: address })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses provider multi-step drips", async () => {
    const { client, fetcher } = setup({ ...campaign, sequences: [{ steps: [...campaign.sequences[0].steps, ...campaign.sequences[0].steps] }] });
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("holds a recipient with an incoming reply instead of dispatching", async () => {
    const { client, fetcher } = setup(campaign, { items: [lead] }, { items: [] }, { items: [mail("reply-1")] });
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(paths(fetcher).some(path => path.endsWith("/activate"))).toBe(false);
  });

  it("queues only one guarded first touch and does not invent a sent receipt", async () => {
    const { client, fetcher } = setup(campaign, { items: [lead] }, { items: [] }, { items: [] }, { ...campaign, status: 1 });
    const result = await client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address });
    expect(result.status).toBe(1);
    expect(result).not.toHaveProperty("message_id");
    expect(paths(fetcher).filter(path => path.endsWith("/activate"))).toHaveLength(1);
  });

  it("attempts pause after uncertain activation and never retries activation", async () => {
    const { client, fetcher } = setup(campaign, { items: [lead] }, { items: [] }, { items: [] });
    fetcher.mockRejectedValueOnce(new Error("connection lost"));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(campaign)));
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address })).rejects.toMatchObject({ outcomeUnknown: true, providerId: campaign.id });
    expect(paths(fetcher).filter(path => path.endsWith("/activate"))).toHaveLength(1);
    expect(paths(fetcher).at(-1)).toBe("/api/v2/campaigns/campaign-1/pause");
  });
});
