import { dispatchManagedJob, isRecipientBusinessWindow, parseManagedImport, providerSchedule, renderManagedBody, validateClearances,
  type ManagedCandidate, type ManagedDispatchConfig, type ManagedDispatchInput } from "@/lib/managed-outreach/orchestrator";
import { fingerprintCampaignSequence, ManagedInstantlyError } from "@/lib/managed-outreach/instantly";
import type { ManagedOutreachEvent, ManagedOutreachJob } from "@prisma/client";
jest.mock("@/lib/prisma", () => ({ prisma: {} }));
jest.mock("@/lib/encryption", () => ({ decrypt: jest.fn() }));

const NOW = new Date("2026-11-04T18:00:00Z");
const candidate: ManagedCandidate = {
  email: "buyer@example.com", company: "Example", companyDomain: "example.com", title: "Chief Marketing Officer", segment: "cmo", roleGroup: "cmo",
  recipientTimezone: "America/New_York", evidence: { domain: "example.com", hqCountry: "US", employeeCount: 201, b2b: true, checkedAt: NOW.toISOString(),
    sources: [{ source: "verified company record", reference: "https://example.com/about", claim: "US headquarters, 201 employees, B2B" }] },
  emailVerification: { status: "verified", catchAll: false, checkedAt: NOW.toISOString(), source: "verified exact address" },
};
const steps = [0, 3, 4, 5, 6].map(delayDays => ({ subject: "Original research for Example", body: "I used to lead Gartner Peer Insights and understand the importance of voice of customer. We built Gather to turn original research into pipeline. Does {{meeting_days}} work?", delayDays }));
const config: ManagedDispatchConfig = { enabled: true, senderEmail: "mayank@outreach.example.com", footer: {
  businessPostalAddress: "100 Example Street, Example City, CA 90000", postalAddressApproved: true,
  unsubscribeText: "Reply stop to opt out.", replyOptOutEnabled: true,
} };
const input = (): ManagedDispatchInput => ({ action: "stage", jobId: "job", mailbox: {
  email: config.senderEmail, explicitlySelected: true, connected: true, authenticationPassed: true, replyInboxReady: true,
  healthCheckedAt: NOW.toISOString(), healthSource: "provider report", reputation: "healthy", healthyHistoryDays: 30,
  sentLast7Days: 20, bouncedLast7Days: 0, complaintsLast7Days: 0,
}, attioClearance: { clear: true, complete: true, checkedAt: NOW.toISOString(), source: "connected_attio", checkedEmail: candidate.email, checkedCompanyDomain: candidate.companyDomain, evidence: ["Exact company/people/alias queries returned no matching CRM record."] },
bookingClearance: { clear: true, complete: true, checkedAt: NOW.toISOString(), source: "confirmed calendar query", checkedEmail: candidate.email, evidence: ["No confirmed booking matches exact recipient."] } });

function harness() {
  let job = { id: "job", workspaceId: "ws", externalId: "source-1", email: candidate.email, companyDomain: candidate.companyDomain,
    candidateJson: JSON.stringify(candidate), stepsJson: JSON.stringify(steps), senderEmail: config.senderEmail,
    experimentId: "subject-1", variant: "A", status: "held", providerCampaignId: null, sequenceFingerprint: null,
    nextStep: 1, dueAt: null, leaseToken: null, leaseUntil: null, lastError: null, createdAt: NOW, updatedAt: NOW } as ManagedOutreachJob;
  const events: ManagedOutreachEvent[] = [];
  const campaign = { id: "campaign-1", name: "Example", status: 2, email_list: [config.senderEmail], stop_on_reply: true,
    stop_on_auto_reply: true, stop_for_company: true, sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: steps[0].subject, body: "provider body" }] }] }] };
  const client = {
    listAccounts: jest.fn().mockResolvedValue([{ email: config.senderEmail, status: 1, setup_pending: false, warmup_status: 1, daily_limit: 20 }]),
    listCampaigns: jest.fn().mockResolvedValue([]), isSuppressed: jest.fn().mockResolvedValue(false), listInboundEmails: jest.fn().mockResolvedValue([]),
    listEmails: jest.fn().mockResolvedValue([]), createPausedCampaign: jest.fn().mockResolvedValue(campaign),
    uploadVerifiedLead: jest.fn().mockResolvedValue({ leads_uploaded: 1, in_blocklist: 0, duplicated_leads: 0, skipped_count: 0, invalid_email_count: 0, created_leads: [{ id: "lead-1", index: 0 }] }),
    getCampaign: jest.fn().mockResolvedValue(campaign), activateCampaign: jest.fn().mockResolvedValue({ ...campaign, status: 1 }),
    pauseCampaign: jest.fn().mockResolvedValue(campaign), appendNextStep: jest.fn(), activateNextStep: jest.fn(),
  };
  const store = {
    markJobReady: jest.fn().mockImplementation(async () => { if (["held", "staged"].includes(job.status)) job = { ...job, status: "ready", dueAt: NOW }; return job; }),
    claimJob: jest.fn().mockImplementation(async () => { if (job.status !== "ready") return null; job = { ...job, status: "claimed", leaseToken: "lease", leaseUntil: new Date(NOW.getTime() + 120000) }; return job; }),
    claimBudgetAndJob: jest.fn().mockImplementation(async () => { if (job.status !== "ready") return { reason: "lease" }; job = { ...job, status: "claimed", leaseToken: "lease", leaseUntil: new Date(NOW.getTime() + 120000) }; return { job, reservationId: "reserved-1" }; }),
    cancelPreMutationReservation: jest.fn().mockImplementation(async (_id, _ws, token, _reservationId, error) => { if (job.leaseToken !== token) throw new Error("Lost lease"); job = { ...job, status: "staged", leaseToken: null, lastError: error }; return job; }),
    updateWithLease: jest.fn().mockImplementation(async (_id, _ws, token, patch) => { if (job.leaseToken !== token) throw new Error("Lost lease"); job = { ...job, ...patch }; if (patch.status && patch.status !== "claimed") job.leaseToken = null; return job; }),
    markMutationUncertain: jest.fn().mockImplementation(async (_id, _ws, _token, error, providerCampaignId) => { job = { ...job, status: "uncertain", lastError: error, ...(providerCampaignId ? { providerCampaignId } : {}) }; return job; }),
    upsertEvent: jest.fn().mockImplementation(async data => { const event = { ...data, dataJson: JSON.stringify(data.data), createdAt: NOW, providerMessageId: data.providerMessageId || null } as ManagedOutreachEvent; events.push(event); return event; }),
  };
  const deps = { now: () => NOW, config, client: client as any, jobs: async () => [job], events: async () => events, store: store as any };
  const run = (value = input()) => dispatchManagedJob({ userId: "owner", workspaceId: "ws" }, value, deps);
  return { deps, client, store, events, run, getJob: () => job, setJob: (patch: Partial<ManagedOutreachJob>) => { job = { ...job, ...patch }; }, campaign };
}

describe("managed outbound orchestration", () => {
  beforeEach(() => { jest.useFakeTimers({ now: NOW }); });
  afterEach(() => { jest.useRealTimers(); });

  it("imports exactly five completed same-subject emails with a selected sender", () => {
    expect(parseManagedImport({ externalId: "p1", candidate, steps, experimentId: "exp", variant: "A", senderEmail: config.senderEmail }, config).steps).toHaveLength(5);
    expect(() => parseManagedImport({ externalId: "p1", candidate, steps: steps.slice(0, 3), experimentId: "exp", variant: "A", senderEmail: config.senderEmail }, config)).toThrow(/five/);
    expect(() => parseManagedImport({ externalId: "p1", candidate, steps, experimentId: "exp", variant: "A", senderEmail: "other@example.com" }, config)).toThrow(/exact configured/);
  });

  it("rejects stale, incomplete or wrong-identity CRM and booking clearances before provider access", async () => {
    for (const patch of [
      { attioClearance: { ...input().attioClearance, checkedAt: "2026-11-03T18:00:00Z" } },
      { attioClearance: { ...input().attioClearance, checkedEmail: "other@example.com" } },
      { attioClearance: { ...input().attioClearance, checkedCompanyDomain: "other.com" } },
      { attioClearance: { ...input().attioClearance, complete: false } },
      { bookingClearance: { ...input().bookingClearance, clear: false } },
    ]) {
      const h = harness(); await expect(h.run({ ...input(), ...patch })).rejects.toMatchObject({ status: 409 });
      expect(h.client.listAccounts).not.toHaveBeenCalled(); expect(h.client.createPausedCampaign).not.toHaveBeenCalled();
    }
  });

  it("never fabricates a newer external check timestamp", () => {
    const value = input(); value.attioClearance.checkedAt = new Date(NOW.getTime() - 55_000).toISOString();
    expect(validateClearances(value, candidate, NOW)).toBe(value.attioClearance.checkedAt);
    expect(() => validateClearances(value, candidate, new Date(NOW.getTime() + 10_000))).toThrow(/Fresh/);
  });

  it("stages a paused campaign durably without activating or counting a send", async () => {
    const h = harness(); const result = await h.run();
    expect(result).toMatchObject({ status: "staged", providerCampaignId: "campaign-1", sendingConfirmed: false });
    expect(h.client.activateCampaign).not.toHaveBeenCalled(); expect(h.store.claimBudgetAndJob).not.toHaveBeenCalled();
    const updateCall = h.store.updateWithLease.mock.invocationCallOrder[0]; const uploadCall = h.client.uploadVerifiedLead.mock.invocationCallOrder[0];
    expect(updateCall).toBeLessThan(uploadCall);
    expect(h.events.some(event => event.type === "sent")).toBe(false);
    expect(h.client.createPausedCampaign.mock.calls[0][0].bodyText).toContain("Thursday or Friday");
  });

  it("permits paused staging while the sending switch is disabled", async () => {
    const h = harness(); h.deps.config = { ...config, enabled: false };
    expect((await h.run()).status).toBe("staged");
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "sending_disabled" });
    expect(h.client.activateCampaign).not.toHaveBeenCalled();
  });

  it("activates only after staging, reserves quota and reports queued rather than sent", async () => {
    const h = harness(); await h.run(); const result = await h.run({ ...input(), action: "activate" });
    expect(result).toMatchObject({ status: "queued", sendingConfirmed: false });
    expect(h.store.claimBudgetAndJob).toHaveBeenCalledTimes(1); expect(h.client.activateCampaign).toHaveBeenCalledTimes(1);
    expect(h.events.filter(event => event.type === "activation_queued")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "sent")).toHaveLength(0);
    await h.run({ ...input(), action: "activate" });
    expect(h.client.activateCampaign).toHaveBeenCalledTimes(1);
  });

  it("honors an atomic quota/race rejection without activating", async () => {
    const h = harness(); await h.run(); h.store.claimBudgetAndJob.mockResolvedValue({ reason: "quota" });
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "dispatch_quota" });
    expect(h.client.activateCampaign).not.toHaveBeenCalled();
  });

  it("cancels a provably pre-mutation failure and allows a fresh guarded attempt", async () => {
    const h = harness(); await h.run(); h.client.getCampaign.mockRejectedValueOnce(new Error("temporary GET failure"));
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "preflight_failed" });
    expect(h.store.cancelPreMutationReservation).toHaveBeenCalledWith("job", "ws", "lease", "reserved-1", expect.any(String), NOW);
    expect(h.getJob().status).toBe("staged"); expect(h.client.activateCampaign).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === "activation_attempted")).toBe(false);
    expect((await h.run({ ...input(), action: "activate" })).status).toBe("queued");
    expect(h.client.activateCampaign).toHaveBeenCalledTimes(1);
  });

  it("holds replies, suppressions and existing account mail before provider mutation", async () => {
    for (const method of ["listInboundEmails", "isSuppressed", "listEmails"] as const) {
      const h = harness(); h.client[method].mockResolvedValue(method === "isSuppressed" ? true : [{ id: "existing-email" }]);
      await expect(h.run()).rejects.toMatchObject({ status: 409 });
      expect(h.client.createPausedCampaign).not.toHaveBeenCalled(); expect(h.client.activateCampaign).not.toHaveBeenCalled();
    }
  });

  it("quarantines uncertain creation and does not repeat the mutation", async () => {
    const h = harness(); h.client.createPausedCampaign.mockRejectedValue(new ManagedInstantlyError("unconfirmed", { code: "provider_error", outcomeUnknown: true }));
    await expect(h.run()).rejects.toMatchObject({ code: "mutation_uncertain" });
    expect(h.getJob().status).toBe("uncertain");
    await expect(h.run()).rejects.toMatchObject({ code: "job_held" });
    expect(h.client.createPausedCampaign).toHaveBeenCalledTimes(1);
  });

  it("holds and attempts pause when activation or receipt persistence is uncertain", async () => {
    const h = harness(); await h.run(); h.client.activateCampaign.mockRejectedValue(new ManagedInstantlyError("unknown", { code: "provider_error", outcomeUnknown: true, providerId: "campaign-1" }));
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "mutation_uncertain" });
    expect(h.client.pauseCampaign).toHaveBeenCalledWith("campaign-1"); expect(h.getJob().status).toBe("uncertain");
    expect(h.store.cancelPreMutationReservation).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === "sent")).toBe(false);
  });

  it("quarantines a successful activation whose durable queued receipt cannot be saved", async () => {
    const h = harness(); await h.run();
    const write = h.store.upsertEvent.getMockImplementation()!;
    h.store.upsertEvent.mockImplementation(async data => {
      if (data.type === "activation_queued") throw new Error("storage unavailable");
      return write(data);
    });
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "mutation_uncertain" });
    expect(h.client.activateCampaign).toHaveBeenCalledTimes(1);
    expect(h.client.pauseCampaign).toHaveBeenCalledWith("campaign-1");
    expect(h.getJob().status).toBe("uncertain");
  });

  it("rechecks external receipt age after slow provider reads before reserving a send", async () => {
    const h = harness(); await h.run(); let time = NOW;
    h.deps.now = () => time;
    h.client.listCampaigns.mockImplementation(async () => { time = new Date(NOW.getTime() + 65_000); return []; });
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "crm_not_clear" });
    expect(h.store.claimBudgetAndJob).not.toHaveBeenCalled(); expect(h.client.activateCampaign).not.toHaveBeenCalled();
  });

  it("holds provider content drift and next-day CTA reuse", async () => {
    const h = harness(); await h.run();
    h.client.getCampaign.mockResolvedValue({ ...h.campaign, sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: "changed", body: "changed" }] }] }] });
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "sequence_changed" });
    expect(h.client.activateCampaign).not.toHaveBeenCalled();
    const other = harness(); await other.run();
    const staged = other.events.find(event => event.type === "staged")!; staged.dataJson = JSON.stringify({ ...JSON.parse(staged.dataJson), localDate: "2026-11-03" });
    await expect(other.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "stale_copy" });
  });

  it("holds a changed provider sender even when the staged sequence is unchanged", async () => {
    const h = harness(); await h.run(); h.client.getCampaign.mockResolvedValue({ ...h.campaign, email_list: ["different@example.com"] });
    await expect(h.run({ ...input(), action: "activate" })).rejects.toMatchObject({ code: "sender_changed" });
    expect(h.client.activateCampaign).not.toHaveBeenCalled();
  });

  it("does not stage when a different active campaign uses the selected sender", async () => {
    const h = harness(); h.client.listCampaigns.mockResolvedValue([{ id: "unrelated", status: 1, email_list: [config.senderEmail] }]);
    await expect(h.run()).rejects.toMatchObject({ code: "sender_busy" }); expect(h.client.createPausedCampaign).not.toHaveBeenCalled();
  });

  it("requires exact sequence fingerprints before activation", () => {
    const h = harness(); expect(fingerprintCampaignSequence(h.campaign)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("recipient-local scheduling and meeting asks", () => {
  it("chooses next two business days and crosses Friday without stale weekdays", () => {
    expect(renderManagedBody("Does {{meeting_days}} work?", NOW, "America/New_York", config.footer).body).toContain("Thursday or Friday");
    expect(renderManagedBody("Does {{meeting_days}} work?", new Date("2026-11-05T18:00:00Z"), "America/New_York", config.footer).body).toContain("Friday or Monday");
    expect(renderManagedBody("Does {{meeting_days}} work?", new Date("2026-11-06T18:00:00Z"), "America/New_York", config.footer).body).toContain("Monday or Tuesday");
  });
  it("enforces weekdays and a twenty minute delivery buffer", () => {
    expect(isRecipientBusinessWindow(NOW, "America/New_York")).toBe(true);
    expect(isRecipientBusinessWindow(new Date("2026-11-04T19:40:00Z"), "America/New_York")).toBe(false);
    expect(isRecipientBusinessWindow(new Date("2026-11-07T18:00:00Z"), "America/New_York")).toBe(false);
  });
  it("converts Pacific, Arizona and Hawaii hours to a documented provider timezone", () => {
    expect(providerSchedule(NOW, "America/Los_Angeles")).toEqual({ timezone: "America/Detroit", timing: { from: "12:00", to: "18:00" } });
    expect(providerSchedule(NOW, "America/Phoenix")).toEqual({ timezone: "America/Detroit", timing: { from: "11:00", to: "17:00" } });
    expect(providerSchedule(new Date("2026-07-01T18:00:00Z"), "America/Phoenix").timing).toEqual({ from: "12:00", to: "18:00" });
    expect(providerSchedule(NOW, "Pacific/Honolulu").timing).toEqual({ from: "14:00", to: "20:00" });
  });
});
