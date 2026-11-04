import { createManagedInstantlyClient, planInstantlySenderRemoval, planInstantlyAccountTagRemoval } from "@/lib/managed-outreach/instantly";

const sender = "mayank@example.net";
const original = { id: "campaign-a", name: "Existing campaign", status: 1, email_list: ["other@example.net", sender, "third@example.net"], email_tag_list: [] };
function fixture(options: { changedBeforePatch?: boolean; lostPatch?: boolean; wrongAfter?: boolean } = {}) {
  let state = structuredClone(original); let reads = 0;
  const audit = jest.fn(async () => undefined);
  const fetcher = jest.fn(async (url: string, init: RequestInit) => {
    if (init.method === "PATCH") {
      expect(audit).toHaveBeenCalledTimes(1);
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body)).toEqual(["email_list"]);
      state = { ...state, email_list: body.email_list };
      if (options.lostPatch) throw new Error("Lost provider response");
      if (options.wrongAfter) state.email_list.push("unexpected@example.net");
    } else {
      reads++;
      if (reads === 2 && options.changedBeforePatch) state.email_list.push("concurrent@example.net");
    }
    return new Response(JSON.stringify(state));
  });
  const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch });
  return { client, fetcher, audit, plan: planInstantlySenderRemoval(original, sender) };
}

describe("exact existing mailbox reservation", () => {
  it("removes only the selected address and preserves all other sender order and case", async () => {
    const { client, fetcher, audit, plan } = fixture();
    const result = await client.removeSenderFromCampaign(original.id, sender, plan.fingerprint, audit);
    expect(result).toMatchObject({ outcome: "removed", before: original.email_list, after: ["other@example.net", "third@example.net"] });
    expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(["GET", "GET", "PATCH", "GET"]);
  });

  it("does not mutate without durable pre-mutation evidence", async () => {
    const { client, fetcher, audit, plan } = fixture();
    audit.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(client.removeSenderFromCampaign(original.id, sender, plan.fingerprint, audit)).rejects.toThrow("Database unavailable");
    expect(fetcher.mock.calls.some(call => call[1].method === "PATCH")).toBe(false);
  });

  it("rejects stale plan fingerprints and a concurrent sender-list change", async () => {
    const first = fixture();
    await expect(first.client.removeSenderFromCampaign(original.id, sender, "0".repeat(64), first.audit)).rejects.toMatchObject({ code: "launch_blocked", outcomeUnknown: false });
    expect(first.audit).not.toHaveBeenCalled();
    const second = fixture({ changedBeforePatch: true });
    await expect(second.client.removeSenderFromCampaign(original.id, sender, second.plan.fingerprint, second.audit)).rejects.toMatchObject({ code: "launch_blocked", outcomeUnknown: false });
    expect(second.fetcher.mock.calls.some(call => call[1].method === "PATCH")).toBe(false);
  });

  it.each([{ lostPatch: true }, { wrongAfter: true }])("quarantines uncertain mutation outcomes without retrying: %j", async options => {
    const { client, fetcher, audit, plan } = fixture(options);
    await expect(client.removeSenderFromCampaign(original.id, sender, plan.fingerprint, audit)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(fetcher.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(1);
    expect(fetcher.mock.calls.some(call => /pause|activate/.test(call[0]))).toBe(false);
  });

  it.each([
    { email_list: [sender] },
    { email_list: [sender, sender.toUpperCase()] },
    { email_list: undefined },
    { email_tag_list: ["dynamic-tag"] },
  ])("rejects sole sender or ambiguous assignments: %j", override => {
    expect(() => planInstantlySenderRemoval({ ...original, ...override }, sender)).toThrow();
  });

  it("does not PATCH an already absent address", async () => {
    const campaign = { ...original, email_list: ["other@example.net"] };
    const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify(campaign)));
    const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch });
    const audit = jest.fn();
    await expect(client.removeSenderFromCampaign(original.id, sender, planInstantlySenderRemoval(campaign, sender).fingerprint, audit)).resolves.toMatchObject({ outcome: "already_absent" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("paginates the account-specific mapping endpoint and rejects incomplete mappings", async () => {
    const row = { campaign_id: "a", campaign_name: "Existing", timestamp_created: "2026-10-01T00:00:00Z", status: 1 };
    const fetcher = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [row], next_starting_after: "cursor" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
    const client = createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch });
    expect(await client.listAccountCampaigns(sender)).toEqual([row]);
    expect(fetcher.mock.calls[0][0]).toContain("account-campaign-mappings/mayank%40example.net");
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("starting_after")).toBe("cursor");
    const looping = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ items: [row], next_starting_after: "same" })));
    await expect(createManagedInstantlyClient("test", { fetch: looping as typeof fetch }).listAccountCampaigns(sender)).rejects.toMatchObject({ code: "pagination_incomplete" });
  });
});

describe("account-only campaign tag reservation", () => {
  const tagsCampaign = { ...original, email_tag_list: ["tag-used"] };
  const initialMappings = [
    { id: "mapping-used", tag_id: "tag-used", resource_id: sender, resource_type: 1 as const },
    { id: "mapping-keep", tag_id: "tag-unrelated", resource_id: sender, resource_type: 1 as const },
  ];
  function tagFixture(options: { lostResponse?: boolean; changedBefore?: boolean; badAfter?: boolean } = {}) {
    let mappings = structuredClone(initialMappings); let reads = 0;
    const audit = jest.fn(async () => undefined);
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/custom-tag-mappings")) {
        expect(parsed.searchParams.get("resource_ids")).toBe(sender);
        reads++;
        if (options.changedBefore && reads === 2) mappings.push({ id: "changed", tag_id: "concurrent", resource_id: sender, resource_type: 1 });
        return new Response(JSON.stringify({ items: mappings }));
      }
      if (parsed.pathname.endsWith("/toggle-resource")) {
        expect(audit).toHaveBeenCalledTimes(1);
        expect(JSON.parse(init.body as string)).toEqual({ tag_ids: ["tag-used"], resource_ids: [sender], resource_type: 1, selected_all: false, assign: false });
        mappings = mappings.filter(row => row.tag_id !== "tag-used");
        if (options.badAfter) mappings = [];
        if (options.lostResponse) throw new Error("lost response");
        return new Response(JSON.stringify({ success: true }));
      }
      expect(init.method).toBe("GET");
      return new Response(JSON.stringify(tagsCampaign));
    });
    return { client: createManagedInstantlyClient("test-key", { fetch: fetcher as typeof fetch }), fetcher, audit,
      plan: planInstantlyAccountTagRemoval(tagsCampaign, sender, initialMappings) };
  }
  it("unassigns only campaign-used tags from the exact account and retains unrelated tags", async () => {
    const { client, plan, audit, fetcher } = tagFixture();
    const result = await client.removeAccountTagsForCampaign(original.id, sender, plan.fingerprint, audit);
    expect(result).toMatchObject({ removeTagIds: ["tag-used"], after: [initialMappings[1]], outcome: "removed" });
    expect(fetcher.mock.calls.filter(call => call[1].method !== "GET")).toHaveLength(1);
    expect(fetcher.mock.calls.some(call => call[1].method === "PATCH")).toBe(false);
  });
  it("requires durable intent and rejects concurrent account-tag changes", async () => {
    const first = tagFixture();
    first.audit.mockRejectedValueOnce(new Error("Cannot save intent"));
    await expect(first.client.removeAccountTagsForCampaign(original.id, sender, first.plan.fingerprint, first.audit)).rejects.toThrow("Cannot save intent");
    expect(first.fetcher.mock.calls.some(call => call[1].method === "POST")).toBe(false);
    const second = tagFixture({ changedBefore: true });
    await expect(second.client.removeAccountTagsForCampaign(original.id, sender, second.plan.fingerprint, second.audit)).rejects.toMatchObject({ code: "launch_blocked", outcomeUnknown: false });
    expect(second.fetcher.mock.calls.some(call => call[1].method === "POST")).toBe(false);
  });
  it.each([{ lostResponse: true }, { badAfter: true }])("does not retry uncertain tag unassignments: %j", async options => {
    const { client, plan, audit, fetcher } = tagFixture(options);
    await expect(client.removeAccountTagsForCampaign(original.id, sender, plan.fingerprint, audit)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
  });
  it("rejects wrong resources and allows direct removal only after tag absence is proved", () => {
    expect(() => planInstantlyAccountTagRemoval(tagsCampaign, sender, [{ ...initialMappings[0], resource_id: "other@example.net" }])).toThrow();
    expect(() => planInstantlySenderRemoval(tagsCampaign, sender)).toThrow();
    expect(() => planInstantlySenderRemoval(tagsCampaign, sender, ["tag-used"])).toThrow();
    expect(planInstantlySenderRemoval(tagsCampaign, sender, ["tag-unrelated"]).after).toEqual(["other@example.net", "third@example.net"]);
  });
});
