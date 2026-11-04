import {
  createManagedInstantlyClient, fingerprintCampaignSequence, ManagedInstantlyError,
  planInstantlyFollowup, type InstantlyFollowupProof, type ManagedInstantlyCampaign,
  type ManagedInstantlyEmail, type ManagedInstantlyLead,
} from "@/lib/managed-outreach/instantly";

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

function followupFixture() {
  const sentTime = Date.now() - 12 * 86_400_000;
  const outbound = (step: number, at: number): ManagedInstantlyEmail => ({
    ...mail(`sent-${step}`), ue_type: 1, campaign_id: campaign.id, lead_id: lead.id, lead: address,
    eaccount: "mayank@example.net", from_address_email: "mayank@example.net", to_address_email_list: address,
    subject: step === 1 ? "Research" : "Re: Research", step: `opaque-provider-step-${step}`,
    timestamp_email: new Date(at).toISOString(), timestamp_created: new Date(at + 1000).toISOString(),
  });
  const state: {
    campaign: ManagedInstantlyCampaign; lead: ManagedInstantlyLead; history: ManagedInstantlyEmail[];
    inbound: ManagedInstantlyEmail[]; unmatchedThreadReply?: ManagedInstantlyEmail; patchFailsAfterApplying: boolean;
    getOverride?: (email: ManagedInstantlyEmail) => ManagedInstantlyEmail;
  } = {
    campaign: { ...campaign, status: 3, sequences: [{ steps: [{ ...campaign.sequences[0].steps[0], delay: 0 }] }] },
    lead: { ...lead, status: 3, timestamp_last_contact: new Date(sentTime).toISOString(), last_step_from: "campaign", last_step_id: "opaque-provider-step-1" },
    history: [outbound(1, sentTime)], inbound: [], patchFailsAfterApplying: false,
  };
  const fetcher = jest.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url); const path = parsed.pathname;
    let value: unknown;
    if (path === `/api/v2/campaigns/${campaign.id}` && init.method === "GET") value = state.campaign;
    else if (path === `/api/v2/campaigns/${campaign.id}/pause`) { state.campaign = { ...state.campaign, status: 2 }; value = state.campaign; }
    else if (path === `/api/v2/campaigns/${campaign.id}` && init.method === "PATCH") {
      const body = JSON.parse(init.body as string);
      state.campaign = { ...state.campaign, sequences: body.sequences };
      state.lead = { ...state.lead, status: 1 };
      if (state.patchFailsAfterApplying) throw new Error("Lost response after provider accepted PATCH");
      value = state.campaign;
    } else if (path === `/api/v2/campaigns/${campaign.id}/activate`) { state.campaign = { ...state.campaign, status: 1 }; value = state.campaign; }
    else if (path === "/api/v2/leads/list") value = { items: [state.lead] };
    else if (path === "/api/v2/block-lists-entries") value = { items: [] };
    else if (path === "/api/v2/emails") value = { items: parsed.searchParams.get("email_type") === "received" ? state.inbound
      : parsed.searchParams.get("search") && state.unmatchedThreadReply ? [...state.history, state.unmatchedThreadReply] : state.history };
    else if (path.startsWith("/api/v2/emails/")) {
      const found = state.history.find(email => email.id === path.split("/").at(-1))!;
      value = state.getOverride ? state.getOverride(found) : found;
    } else throw new Error(`Unexpected mocked request ${init.method} ${path}`);
    return new Response(JSON.stringify(value));
  });
  const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch });
  const proof = (): InstantlyFollowupProof => ({
    expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net", expectedThreadId: "same-thread",
    priorSentEmailIds: state.history.map(email => email.id), expectedSequenceFingerprint: fingerprintCampaignSequence(state.campaign),
  });
  const completeNextStep = () => {
    const step = state.history.length + 1;
    const next = outbound(step, sentTime + (step - 1) * 2 * 86_400_000);
    state.history.push(next);
    state.campaign = { ...state.campaign, status: 3 };
    state.lead = { ...state.lead, status: 3, timestamp_last_contact: next.timestamp_email, last_step_id: next.step };
  };
  return { state, fetcher, client, proof, completeNextStep };
}

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

  it("accepts explicit converted sending hours and rejects invalid or overnight windows", async () => {
    const { client, fetcher } = setup({ ...campaign, status: 0 }, campaign);
    await client.createPausedCampaign({ name: "Pacific recipient", senderEmails: ["mayank@example.net"], subject: "Research", bodyText: "Hello",
      timezone: "America/Detroit", timing: { from: "12:00", to: "18:00" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).campaign_schedule.schedules[0]).toMatchObject({ timezone: "America/Detroit", timing: { from: "12:00", to: "18:00" } });
    await expect(client.createPausedCampaign({ name: "Invalid", senderEmails: ["mayank@example.net"], subject: "Research", bodyText: "Hello", timing: { from: "23:00", to: "05:00" } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date(Date.now() - 61_000).toISOString(), expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net" })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses provider multi-step drips", async () => {
    const { client, fetcher } = setup({ ...campaign, sequences: [{ steps: [...campaign.sequences[0].steps, ...campaign.sequences[0].steps] }] });
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net" })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses first-touch activation after the provider sender changes", async () => {
    const { client, fetcher } = setup({ ...campaign, email_list: ["different-mailbox@example.net"] });
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net" })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(paths(fetcher).some(path => path.endsWith("/activate"))).toBe(false);
  });

  it("holds a recipient with an incoming reply instead of dispatching", async () => {
    const { client, fetcher } = setup(campaign, { items: [lead] }, { items: [] }, { items: [mail("reply-1")] });
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net" })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(paths(fetcher).some(path => path.endsWith("/activate"))).toBe(false);
  });

  it("queues only one guarded first touch and does not invent a sent receipt", async () => {
    const { client, fetcher } = setup(campaign, { items: [lead] }, { items: [] }, { items: [] }, { ...campaign, status: 1 });
    const result = await client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net" });
    expect(result.status).toBe(1);
    expect(result).not.toHaveProperty("message_id");
    expect(paths(fetcher).filter(path => path.endsWith("/activate"))).toHaveLength(1);
  });

  it("attempts pause after uncertain activation and never retries activation", async () => {
    const { client, fetcher } = setup(campaign, { items: [lead] }, { items: [] }, { items: [] });
    fetcher.mockRejectedValueOnce(new Error("connection lost"));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(campaign)));
    await expect(client.activateCampaign(campaign.id, { preflightCheckedAt: new Date().toISOString(), expectedRecipientEmail: address, expectedSenderEmail: "mayank@example.net" })).rejects.toMatchObject({ outcomeUnknown: true, providerId: campaign.id });
    expect(paths(fetcher).filter(path => path.endsWith("/activate"))).toHaveLength(1);
    expect(paths(fetcher).at(-1)).toBe("/api/v2/campaigns/campaign-1/pause");
  });

  it("plans one blank-subject native followup while preserving completed copy and leaving input untouched", () => {
    const { state, proof } = followupFixture();
    const original = JSON.parse(JSON.stringify(state.campaign));
    const plan = planInstantlyFollowup(state.campaign, { expectedSequenceFingerprint: proof().expectedSequenceFingerprint, bodyText: "A second idea\nfor your team", delayDays: 3 });
    expect(state.campaign).toEqual(original);
    expect(plan.sequences[0].steps).toHaveLength(2);
    expect(plan.sequences[0].steps[0]).toEqual({ ...original.sequences[0].steps[0], delay: 3, delay_unit: "days" });
    expect(plan.sequences[0].steps[1].variants[0]).toEqual({ subject: "", body: "A second idea<br/>for your team" });
    expect(plan.sequenceFingerprint).not.toBe(proof().expectedSequenceFingerprint);
  });

  it("fingerprints canonical sequence data independently of provider key order", () => {
    const { state } = followupFixture();
    const equivalent = { ...state.campaign, sequences: [{ steps: [{ variants: [{ body: "Hello", subject: "Research" }], delay: 0, type: "email" }] }] };
    expect(fingerprintCampaignSequence(state.campaign)).toBe(fingerprintCampaignSequence(equivalent));
  });

  it("stages one next step only, checks immutable outbound proof, and does not activate", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const input = proof();
    const result = await client.appendNextStep(campaign.id, { ...input, bodyText: "Next researched example", delayDays: 3 });
    expect(result.nextStep).toBe(2);
    expect(result.campaign.status).toBe(2);
    expect(result.sequenceFingerprint).toBe(fingerprintCampaignSequence(state.campaign));
    expect(paths(fetcher)).toContain("/api/v2/emails/sent-1");
    expect(paths(fetcher).some(path => path.endsWith("/activate"))).toBe(false);
    expect(fetcher.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(1);
  });

  it.each([
    ["sender", { from_address_email: "someone-else@example.net" }],
    ["recipient", { to_address_email_list: "other@example.com" }],
    ["extra recipient", { to_address_email_list: `${address},other@example.com` }],
    ["thread", { thread_id: "another-thread" }],
    ["campaign", { campaign_id: "different-campaign" }],
    ["scheduled source", { ue_type: 4 }],
    ["incomplete source body", { body_fallback_reason: "unavailable" }],
  ])("holds followup when immutable %s evidence mismatches", async (_name, change) => {
    const { client, state, fetcher, proof } = followupFixture();
    state.getOverride = email => ({ ...email, ...change }) as ManagedInstantlyEmail;
    await expect(client.appendNextStep(campaign.id, { ...proof(), bodyText: "Example", delayDays: 3 })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher.mock.calls.some(call => call[1].method === "PATCH" || new URL(call[0]).pathname.endsWith("/activate"))).toBe(false);
  });

  it("holds a changed original sequence instead of silently adopting it", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const savedProof = proof();
    state.campaign.sequences![0].steps[0].variants[0].body = "Unreviewed manual edit";
    await expect(client.appendNextStep(campaign.id, { ...savedProof, bodyText: "Example", delayDays: 3 })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("holds duplicate or unexpected provider sends and incomplete progress", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const savedProof = proof();
    state.history.push({ ...state.history[0], id: "unexpected-send" });
    await expect(client.appendNextStep(campaign.id, { ...savedProof, bodyText: "Example", delayDays: 3 })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher.mock.calls.some(call => call[1].method === "PATCH")).toBe(false);
    state.history.pop();
    state.lead.status = 1;
    await expect(client.appendNextStep(campaign.id, { ...savedProof, bodyText: "Example", delayDays: 3 })).rejects.toMatchObject({ code: "launch_blocked" });
  });

  it("holds lead progress that points to a different executed step", async () => {
    const { client, state, proof } = followupFixture();
    state.lead.last_step_id = "different-opaque-step";
    await expect(client.appendNextStep(campaign.id, { ...proof(), bodyText: "Example", delayDays: 3 })).rejects.toMatchObject({ code: "launch_blocked" });
  });

  it("does not append twice after a lost PATCH response and preserves the intended fingerprint for reconciliation", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const input = { ...proof(), bodyText: "Example", delayDays: 3 };
    const plan = planInstantlyFollowup(state.campaign, input);
    state.patchFailsAfterApplying = true;
    await expect(client.appendNextStep(campaign.id, input)).rejects.toMatchObject({ outcomeUnknown: true, providerId: campaign.id, expectedSequenceFingerprint: plan.sequenceFingerprint });
    expect(state.campaign.status).toBe(2);
    expect(state.campaign.sequences![0].steps).toHaveLength(2);
    await expect(client.appendNextStep(campaign.id, input)).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(1);
  });

  it("dispatches only the appended step after fresh checks and keeps queued separate from sent", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const originalProof = proof();
    const staged = await client.appendNextStep(campaign.id, { ...originalProof, bodyText: "Example", delayDays: 3 });
    const active = await client.activateNextStep(campaign.id, { ...originalProof, expectedSequenceFingerprint: staged.sequenceFingerprint, preflightCheckedAt: new Date().toISOString() });
    expect(active.status).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(paths(fetcher).filter(path => path.endsWith("/activate"))).toHaveLength(1);
  });

  it("holds a staged followup if a reply arrives before activation", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const originalProof = proof();
    const staged = await client.appendNextStep(campaign.id, { ...originalProof, bodyText: "Example", delayDays: 3 });
    state.inbound = [mail("new-human-reply") as ManagedInstantlyEmail];
    await expect(client.activateNextStep(campaign.id, { ...originalProof, expectedSequenceFingerprint: staged.sequenceFingerprint, preflightCheckedAt: new Date().toISOString() })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(paths(fetcher).some(path => path.endsWith("/activate"))).toBe(false);
  });

  it("holds replies from another address in the actual thread even before provider lead attachment", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    state.unmatchedThreadReply = { ...mail("forwarded-colleague-reply"), from_address_email: "colleague@example.com", campaign_id: null, lead: null } as ManagedInstantlyEmail;
    await expect(client.appendNextStep(campaign.id, { ...proof(), bodyText: "Example", delayDays: 3 })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(fetcher.mock.calls.some(call => call[1].method === "PATCH")).toBe(false);
  });

  it("holds followups not yet due from the prior actual send", async () => {
    const { client, state, fetcher, proof } = followupFixture();
    const originalProof = proof();
    const staged = await client.appendNextStep(campaign.id, { ...originalProof, bodyText: "Example", delayDays: 30 });
    await expect(client.activateNextStep(campaign.id, { ...originalProof, expectedSequenceFingerprint: staged.sequenceFingerprint, preflightCheckedAt: new Date().toISOString() })).rejects.toMatchObject({ code: "launch_blocked" });
    expect(paths(fetcher).some(path => path.endsWith("/activate"))).toBe(false);
    expect(state.history).toHaveLength(1);
  });

  it("supports all five native threaded steps with exactly one pending step at each dispatch", async () => {
    const { client, state, proof, completeNextStep } = followupFixture();
    for (let nextStep = 2; nextStep <= 5; nextStep++) {
      const before = proof();
      const staged = await client.appendNextStep(campaign.id, { ...before, bodyText: `Example ${nextStep}`, delayDays: 2 });
      expect(staged.nextStep).toBe(nextStep);
      expect(state.campaign.sequences![0].steps.length - state.history.length).toBe(1);
      await client.activateNextStep(campaign.id, { ...before, expectedSequenceFingerprint: staged.sequenceFingerprint, preflightCheckedAt: new Date().toISOString() });
      completeNextStep();
    }
    expect(state.history).toHaveLength(5);
    expect(state.campaign.sequences![0].steps.map(step => step.variants[0].subject)).toEqual(["Research", "", "", "", ""]);
    expect(() => planInstantlyFollowup(state.campaign, { expectedSequenceFingerprint: fingerprintCampaignSequence(state.campaign), bodyText: "Sixth", delayDays: 3 })).toThrow(ManagedInstantlyError);
  });

  it("reports real campaign observations separately from warmup placement and unobserved authentication", async () => {
    const { client, fetcher } = setup(
      { email: "mayank@example.net", warmup_status: 1, setup_pending: false, status: 1, daily_limit: 20, stat_warmup_score: 100, smtp_password: "hidden" },
      [{ date: "2026-11-03", email_account: "mayank@example.net", sent: 10, bounced: 1, replies: 2 }],
      { email_date_data: { "mayank@example.net": { "2026-11-03": { sent: 15, landed_inbox: 15 }, "2026-10-01": { sent: 10 } } },
        aggregate_data: { "mayank@example.net": { sent: 100, received: 80, landed_inbox: 100, landed_spam: 0, health_score: 100 } } },
    );
    const result = await client.getAccountHealth("mayank@example.net", { startDate: "2026-11-03", endDate: "2026-11-04" });
    expect(result.campaign).toMatchObject({ sent: 10, bounced: 1, bounceRatio: 0.1, completeWindow: false, missingDates: ["2026-11-04"] });
    expect(result.warmup.dailyObserved).toEqual([{ date: "2026-11-03", sent: 15, received: null, landed_inbox: 15, landed_spam: null }]);
    expect(result.warmup.aggregateWindow).toBe("provider_defined_not_requested_window");
    expect(result.complaints.status).toBe("not_exposed_by_reviewed_endpoints");
    expect(result.authentication.status).toBe("not_checked");
    expect(result.account).not.toHaveProperty("smtp_password");
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("emails")).toBe("mayank@example.net");
    expect(paths(fetcher).some(path => path.includes("vitals"))).toBe(false);
  });

  it("keeps empty campaign/warmup observations unknown rather than manufacturing zeros", async () => {
    const { client } = setup({ email: "mayank@example.net", warmup_status: 1, setup_pending: false }, [], { email_date_data: {}, aggregate_data: {} });
    const result = await client.getAccountHealth("mayank@example.net", { startDate: "2026-11-04", endDate: "2026-11-04" });
    expect(result.campaign).toMatchObject({ sent: null, bounced: null, bounceRatio: null, completeWindow: false });
    expect(result.warmup.aggregate).toBeNull();
  });

  it.each([
    [{ date: "2026-11-04", email_account: "other@example.net", sent: 10, bounced: 0 }],
    [{ date: "2026-11-04", email_account: "mayank@example.net", sent: -1, bounced: 0 }],
    [{ date: "2026-11-04", email_account: "mayank@example.net", sent: 1, bounced: 0 }, { date: "2026-11-04", email_account: "mayank@example.net", sent: 1, bounced: 0 }],
  ])("fails closed on unexpected campaign health rows %#", async (...rows) => {
    const { client } = setup({ email: "mayank@example.net", warmup_status: 1, setup_pending: false }, rows, { email_date_data: {}, aggregate_data: {} });
    await expect(client.getAccountHealth("mayank@example.net", { startDate: "2026-11-04", endDate: "2026-11-04" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects unsupported analytics ranges before any request", async () => {
    const { client, fetcher } = setup();
    await expect(client.getAccountHealth("mayank@example.net", { startDate: "2026-10-01", endDate: "2026-11-04" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs a separately explicit diagnostic only for the exact selected mailbox and whitelists DNS results", async () => {
    const { client, fetcher } = setup({ status: "success", success_list: [{ domain: "example.net", allPass: true,
      mx: true, spf: true, dkim: true, dmarc: true, indeterminate: [], smtp_password: "must-not-escape" }], failure_list: [] });
    const result = await client.runAccountVitals("mayank@example.net");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ accounts: ["mayank@example.net"] });
    expect(paths(fetcher)).toEqual(["/api/v2/accounts/test/vitals"]);
    expect(result.success_list[0]).toEqual({ domain: "example.net", allPass: true, mx: true, spf: true, dkim: true, dmarc: true, indeterminate: [] });
    expect(result.connectionStatus).toBe("not_reported_by_this_endpoint");
    expect(result.countsAsCampaignSend).toBe(false);
  });

  it("retains indeterminate DNS checks as non-passing results", async () => {
    const { client } = setup({ status: "success", success_list: [], failure_list: [{ domain: "example.net", allPass: false,
      mx: true, spf: true, dkim: false, dmarc: true, indeterminate: ["dkim"] }] });
    const result = await client.runAccountVitals("mayank@example.net");
    expect(result.failure_list[0]).toMatchObject({ allPass: false, dkim: false, indeterminate: ["dkim"] });
    expect(result.success_list).toEqual([]);
  });

  it("refuses contradictory DNS passes and unrelated domain results", async () => {
    for (const row of [
      { domain: "example.net", allPass: true, mx: true, spf: false, dkim: true, dmarc: true },
      { domain: "unrequested.net", allPass: true, mx: true, spf: true, dkim: true, dmarc: true },
    ]) {
      const { client } = setup({ status: "success", success_list: [row], failure_list: [] });
      await expect(client.runAccountVitals("mayank@example.net")).rejects.toMatchObject({ code: "invalid_response", outcomeUnknown: true });
    }
  });

  it("never implicitly retries a diagnostic after an uncertain provider error", async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch });
    await expect(client.runAccountVitals("mayank@example.net")).rejects.toMatchObject({ code: "provider_error", outcomeUnknown: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
