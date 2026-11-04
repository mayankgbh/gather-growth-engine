import { inspectManagedStage } from "@/lib/managed-outreach/reconcile";
import { fingerprintCampaignSequence } from "@/lib/managed-outreach/instantly";
import { renderManagedBody } from "@/lib/managed-outreach/orchestrator";
jest.mock("@/lib/prisma", () => ({ prisma: {} }));
jest.mock("@/lib/encryption", () => ({ decrypt: jest.fn() }));
function fixture() {
  const now = new Date();
  const candidate = { email: "buyer@example.com", company: "Example", companyDomain: "example.com", title: "Chief Marketing Officer", segment: "cmo", roleGroup: "cmo", recipientTimezone: "America/Los_Angeles",
    evidence: { domain: "example.com", hqCountry: "US", employeeCount: 201, b2b: true, checkedAt: now.toISOString(), sources: [{ source: "record", reference: "https://example.com", claim: "US B2B 201 employees" }] },
    emailVerification: { status: "verified", catchAll: false, checkedAt: now.toISOString(), source: "verified exact work email" } };
  const steps = [0, 3, 4, 5, 6].map(delayDays => ({ subject: "Research for Example", body: "I used to lead Gartner Peer Insights. Gather creates original research that drives marketing pipeline. Does {{meeting_days}} work?", delayDays }));
  const config = { enabled: true, senderEmail: "sender@example.net", footer: { postalAddressApproved: true, businessPostalAddress: "100 Example Street, Example City, CA 90000", unsubscribeText: "Reply stop to opt out.", replyOptOutEnabled: true } };
  const rendered = renderManagedBody(steps[0].body, now, candidate.recipientTimezone, config.footer);
  const campaign = { id: "campaign", name: "Gather managed job A", status: 2, email_list: [config.senderEmail], stop_on_reply: true, stop_on_auto_reply: true, stop_for_company: true,
    sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: steps[0].subject, body: rendered.html }] }] }] };
  const job: any = { id: "job", workspaceId: "workspace", externalId: "external", senderEmail: config.senderEmail, email: candidate.email, companyDomain: candidate.companyDomain,
    candidateJson: JSON.stringify(candidate), stepsJson: JSON.stringify(steps), experimentId: "test", variant: "A", status: "uncertain", nextStep: 1, providerCampaignId: campaign.id,
    sequenceFingerprint: fingerprintCampaignSequence(campaign), leaseToken: null, leaseUntil: null, updatedAt: now };
  const events: any[] = [{ id: "preflight", type: "preflight_checked", occurredAt: now, dataJson: JSON.stringify({ action: "stage", step: 1 }) }];
  const lead = { id: "lead", email: candidate.email, campaign: campaign.id, status: 1, email_reply_count: 0 };
  const client: any = { getCampaign: jest.fn().mockResolvedValue(campaign), listCampaignLeads: jest.fn().mockResolvedValue([lead]), listEmails: jest.fn().mockResolvedValue([]), uploadVerifiedLead: jest.fn(), activateCampaign: jest.fn() };
  return { job, events, client, config, campaign, lead, run: () => inspectManagedStage(job, events, client, config) };
}
describe("uncertain stage reconciliation", () => {
  it("accepts exact paused copy and one untouched recipient without mutating provider", async () => {
    const h = fixture(); const result = await h.run();
    expect(result.reconcilable).toBe(true); expect(result.stageData.providerLeadId).toBe("lead");
    expect(h.client.uploadVerifiedLead).not.toHaveBeenCalled(); expect(h.client.activateCampaign).not.toHaveBeenCalled();
  });
  it.each([{ leads: [] }, { leads: [{ id: "unexpected", email: "other@example.com", campaign: "campaign", status: 1, email_reply_count: 0 }] }])("holds missing or wrong recipients without uploading: %j", async ({ leads }) => {
    const h = fixture(); h.client.listCampaignLeads.mockResolvedValue(leads);
    expect((await h.run()).reconcilable).toBe(false); expect(h.client.uploadVerifiedLead).not.toHaveBeenCalled();
  });
  it("holds changed body, active campaign and any actual message history", async () => {
    const h = fixture(); h.campaign.sequences[0].steps[0].variants[0].body += " changed"; h.campaign.status = 1;
    h.client.listEmails.mockResolvedValue([{ id: "actual", message_id: "actual-provider-id", timestamp_created: new Date().toISOString(), ue_type: 1 }]);
    const result = await h.run(); expect(result.reconcilable).toBe(false); expect(result.reasons).toHaveLength(3);
  });
  it("holds activation and stop evidence even when provider campaign is paused", async () => {
    const h = fixture(); h.events.push({ id: "attempt", type: "activation_attempted", occurredAt: new Date(), dataJson: "{}" });
    expect((await h.run()).reconcilable).toBe(false);
  });
  it("holds incomplete provider scans instead of recovering from partial state", async () => {
    const h = fixture(); h.client.listEmails.mockRejectedValue(new Error("pagination incomplete"));
    await expect(h.run()).rejects.toThrow("pagination incomplete");
  });
});
