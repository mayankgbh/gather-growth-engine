import { Candidate, FooterConfig, MailboxReadiness, evaluateCandidate, evaluateMailbox, evaluateFooter, evaluateSendPolicy, buildFooter, normalizeEmail } from "@/lib/managed-outreach/policy";

const now = new Date("2026-11-04T20:00:00Z");
function candidate(): Candidate {
  return {
    email: "person@example.com", company: "Example", companyDomain: "example.com",
    title: "Director of Product Marketing", segment: "cmo", roleGroup: "product_marketing",
    evidence: { domain: "example.com", hqCountry: "United States", employeeMin: 101, employeeMax: 250, b2b: true, checkedAt: now.toISOString(), sources: [{ source: "Verified research", reference: "https://example.com/company", claim: "US headquarters, 101–250 employees, B2B software" }] },
    emailVerification: { status: "verified", catchAll: false, checkedAt: now.toISOString(), source: "verification-provider" },
  };
}
function mailbox(): MailboxReadiness {
  return { email: "sender@example.org", explicitlySelected: true, connected: true, authenticationPassed: true, replyInboxReady: true, healthCheckedAt: now.toISOString(), healthSource: "provider deliverability history", reputation: "healthy", healthyHistoryDays: 21, sentLast7Days: 100, bouncedLast7Days: 1, complaintsLast7Days: 0, warmupStatus: 1 };
}
function footer(): FooterConfig {
  return { businessPostalAddress: "123 Example Street, Example City, CA 90000", postalAddressApproved: true, unsubscribeText: "Reply unsubscribe to stop these emails.", replyOptOutEnabled: true };
}

describe("managed outreach eligibility", () => {
  it("accepts a verified US B2B director at a company with at least 101 employees", () => {
    expect(evaluateCandidate(candidate(), { now }).eligible).toBe(true);
  });

  it.each([100, 0, -1, 100.5, NaN, Infinity])("holds nonqualifying or malformed employee count %s", count => {
    const input = candidate(); input.evidence.employeeCount = count;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
  });

  it("does not turn an employee range beginning at 100 into 101+", () => {
    const input = candidate(); input.evidence.employeeMin = 100;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.evidence.employeeCount = 101;
    expect(evaluateCandidate(input, { now }).eligible).toBe(true);
    input.evidence.employeeMax = 99;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
  });

  it.each(["Canada", "US office", "", null])("does not accept ambiguous or non-US company headquarters: %s", country => {
    const input = candidate(); input.evidence.hqCountry = country;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
  });

  it.each([false, null])("does not assume B2B fit from a marketing title (%s)", b2b => {
    const input = candidate(); input.evidence.b2b = b2b;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
  });

  it("requires current evidence for the exact company and source provenance", () => {
    const input = candidate(); input.evidence.checkedAt = "2026-07-01T00:00:00Z";
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.evidence.checkedAt = now.toISOString(); input.evidence.domain = "different.example.com";
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.evidence.domain = "example.com"; input.evidence.sources = [];
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
  });

  it.each(["Product Marketing Manager", "Director of Engineering", "Assistant Director of Marketing", "Chief of Staff to the CMO"])('holds ineligible title "%s"', title => {
    expect(evaluateCandidate({ ...candidate(), title }, { now }).eligible).toBe(false);
  });

  it.each(["CMO", "VP, Marketing", "Head of Brand", "Senior Director of Corporate Communications", "Director of PR"])('accepts senior marketing title "%s"', title => {
    expect(evaluateCandidate({ ...candidate(), title }, { now }).eligible).toBe(true);
  });

  it("limits agency outreach to leadership at the same qualifying company size", () => {
    const input = { ...candidate(), segment: "agency" as const, roleGroup: "agency" as const, title: "Managing Partner" };
    expect(evaluateCandidate(input, { now }).eligible).toBe(true);
    for (const title of ["Partner Marketing Manager", "Account Director", "Associate Partner", "Account Executive"]) {
      expect(evaluateCandidate({ ...input, title }, { now }).eligible).toBe(false);
    }
    input.evidence.employeeMin = 50;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
  });

  it("excludes customer brand names and verified corporate domain aliases", () => {
    expect(evaluateCandidate({ ...candidate(), company: "Datadog, Inc." }, { now }).eligible).toBe(false);
    expect(evaluateCandidate({ ...candidate(), corporateDomains: ["parent.example.org"] }, { now, knownCustomerDomains: ["example.org"] }).eligible).toBe(false);
    expect(evaluateCandidate(candidate(), { now, knownCustomerDomains: ["notexample.com"] }).eligible).toBe(true);
    expect(evaluateCandidate({ ...candidate(), corporateNames: ["Existing Account LLC"] }, { now, knownCustomerNames: ["Existing Account"] }).eligible).toBe(false);
  });

  it("does not accept a catch-all, stale, mismatched or personal email", () => {
    const input = candidate(); input.emailVerification.catchAll = null;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.emailVerification.catchAll = true;
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.emailVerification.catchAll = false; input.emailVerification.checkedAt = "2026-09-01T00:00:00Z";
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.emailVerification.checkedAt = now.toISOString(); input.email = "person@gmail.com";
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.email = "person@unrelated.example.org";
    expect(evaluateCandidate(input, { now }).eligible).toBe(false);
    input.corporateDomains = ["example.org"];
    expect(evaluateCandidate(input, { now }).eligible).toBe(true);
  });

  it.each(["person@example.com\r\nBcc:other@example.org", "a..b@example.com", "person@127.0.0.1", "a@example.com/path", "a@-example.com"])("rejects invalid address %s", value => {
    expect(normalizeEmail(value)).toBe("");
  });
});

describe("mailbox and footer gates", () => {
  it("requires an explicit mailbox and does not accept active warmup alone", () => {
    expect(evaluateMailbox({ ...mailbox(), explicitlySelected: false }, { now }).eligible).toBe(false);
    expect(evaluateMailbox({ ...mailbox(), warmupStatus: 1, reputation: "unknown", healthyHistoryDays: 0 }, { now }).eligible).toBe(false);
    expect(evaluateMailbox(mailbox(), { now }).eligible).toBe(true);
  });

  it("holds stale health, any complaint, a 2% bounce rate and invalid counts", () => {
    const variants = [
      { healthCheckedAt: "2026-11-04T19:44:00Z" }, { complaintsLast7Days: 1 },
      { bouncedLast7Days: 2 }, { sentLast7Days: -1 }, { bouncedLast7Days: NaN },
      { sentLast7Days: 0, bouncedLast7Days: 1 }, { replyInboxReady: false },
    ];
    for (const variant of variants) expect(evaluateMailbox({ ...mailbox(), ...variant }, { now }).eligible).toBe(false);
  });

  it("holds missing/unapproved postal information and a nonworking opt-out", () => {
    expect(evaluateFooter({}, { now }).eligible).toBe(false);
    expect(evaluateFooter({ ...footer(), postalAddressApproved: false }, { now }).eligible).toBe(false);
    expect(evaluateFooter({ ...footer(), replyOptOutEnabled: false }, { now }).eligible).toBe(false);
    expect(() => buildFooter({})).toThrow("Never invent");
  });

  it("combines all local checks without implying CRM or live stop checks passed", () => {
    expect(evaluateSendPolicy({ candidate: candidate(), mailbox: mailbox(), footer: footer(), now }).eligible).toBe(true);
    expect(evaluateSendPolicy({ candidate: candidate(), mailbox: mailbox(), footer: {}, now }).eligible).toBe(false);
  });
});
