/** Pure, fail-closed policy. All evidence is supplied by trusted server-side callers. */
export const OUTREACH_POLICY_VERSION = "us-b2b-101-plus-2026-11-04";
const DAY = 86_400_000;
const MAX_COMPANY_EVIDENCE_AGE = 90 * DAY;
const MAX_EMAIL_EVIDENCE_AGE = 30 * DAY;
const MAX_MAILBOX_EVIDENCE_AGE = 15 * 60_000;

export type EvidenceSource = { source: string; reference: string; claim: string };
export type CandidateEvidence = {
  domain: string;
  hqCountry: string | null;
  employeeCount?: number | null;
  employeeMin?: number | null;
  employeeMax?: number | null;
  b2b: boolean | null;
  checkedAt: string;
  sources: EvidenceSource[];
};
export type MarketingRole = "cmo" | "general_marketing" | "brand_marketing" | "product_marketing" | "content_marketing" | "corporate_marketing" | "pr_communications" | "growth_marketing" | "demand_generation";
export type Candidate = {
  email: string;
  company: string;
  companyDomain: string;
  /** Verified corporate aliases only; never generate domains or addresses. */
  corporateDomains?: string[];
  corporateNames?: string[];
  title: string;
  segment: "cmo" | "agency";
  roleGroup: MarketingRole | "agency";
  evidence: CandidateEvidence;
  emailVerification: { status: "verified" | "unverified" | "invalid" | "unknown"; catchAll: boolean | null; checkedAt: string; source: string };
};
export type MailboxReadiness = {
  email: string;
  explicitlySelected: boolean;
  connected: boolean;
  authenticationPassed: boolean;
  replyInboxReady: boolean;
  healthCheckedAt: string;
  healthSource: string;
  reputation: "healthy" | "unhealthy" | "unknown";
  /** A measured history, not inferred from the fact that warmup is enabled. */
  healthyHistoryDays: number;
  sentLast7Days: number;
  bouncedLast7Days: number;
  complaintsLast7Days: number;
  warmupStatus?: number | string;
};
export type FooterConfig = {
  businessPostalAddress?: string;
  postalAddressApproved?: boolean;
  unsubscribeText?: string;
  replyOptOutEnabled?: boolean;
};
export type PolicyDecision = { eligible: boolean; reasons: string[]; checkedAt: string; policyVersion: string };
export type PolicyOptions = { now?: Date; knownCustomerDomains?: string[]; knownCustomerNames?: string[] };

// Public brand references only. Private CRM records must never be copied into this repository.
const PUBLIC_CUSTOMER_NAMES = ["Gather", "Cyera", "Datadog", "CloudBolt", "Envoy", "Razorfish", "Decision Counsel"];
const INTERNAL_DOMAINS = ["gatherhq.com", "getgatherhq.com"];
const CONSUMER_EMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com"]);

export function normalizeDomain(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").replace(/\.$/, "");
  // Do not silently accept userinfo, ports, paths, IPs, invalid labels or query strings.
  if (candidate.length > 253 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(candidate)) return "";
  if (candidate.split(".").some(label => label.length > 63) || /^\d+(?:\.\d+)+$/.test(candidate)) return "";
  return candidate;
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/?^_`{|}~-]+@[a-z0-9.-]+$/.test(email)) return "";
  const [local, domain] = email.split("@");
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "";
  return normalizeDomain(domain) === domain ? email : "";
}

export function normalizeCompanyName(value: string): string {
  return value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/(?:,?\s+(?:incorporated|inc\.?|llc\.?|ltd\.?|limited|corporation|corp\.?))+$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

export function sameCorporateDomain(a: string, b: string): boolean {
  const left = normalizeDomain(a); const right = normalizeDomain(b);
  return !!left && !!right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));
}

function timestampFresh(value: string | undefined, now: Date, age: number): boolean {
  const parsed = Date.parse(value || "");
  return Number.isFinite(now.getTime()) && Number.isFinite(parsed) && parsed <= now.getTime() + 60_000 && now.getTime() - parsed <= age;
}

function decision(reasons: string[], now: Date): PolicyDecision {
  return { eligible: reasons.length === 0, reasons: Array.from(new Set(reasons)), checkedAt: Number.isFinite(now.getTime()) ? now.toISOString() : "", policyVersion: OUTREACH_POLICY_VERSION };
}

const SENIOR_MARKETING = /\b(?:director|head|vp|svp|evp|vice[ -]president|cmo|chief (?:marketing|market|growth|brand|communications?) officer)\b/i;
const MARKETING_FUNCTION = /\b(?:marketing|cmo|brand|content|communications?|public relations|pr|growth|demand generation)\b/i;
const JUNIOR_OR_AMBIGUOUS = /\b(?:assistant|associate|deputy)\s+(?:director|head|vice president|vp|partner)|\b(?:assistant to|chief of staff to)\b/i;
const AGENCY_EXECUTIVE = /\b(?:senior partner|managing partner|founding partner|general partner|executive partner|founder|co-founder|owner|principal|ceo|president|chief executive(?: officer)?|managing director)\b|^partner$/i;

export function evaluateCandidate(candidate: Candidate, options: PolicyOptions = {}): PolicyDecision {
  const now = options.now || new Date(); const reasons: string[] = [];
  const email = normalizeEmail(candidate.email || "");
  const domain = normalizeDomain(candidate.companyDomain || "");
  const corporateDomains = [domain, ...(candidate.corporateDomains || []).map(normalizeDomain)];
  const names = [candidate.company, ...(candidate.corporateNames || [])].map(value => normalizeCompanyName(value || ""));
  if (!domain || !candidate.company?.trim() || corporateDomains.some(value => !value) || names.some(value => !value)) reasons.push("Company identity or corporate aliases are missing or invalid.");
  const knownDomains = [...INTERNAL_DOMAINS, ...(options.knownCustomerDomains || [])];
  const knownNames = [...PUBLIC_CUSTOMER_NAMES, ...(options.knownCustomerNames || [])].map(normalizeCompanyName);
  if (corporateDomains.some(value => knownDomains.some(known => sameCorporateDomain(value, known))) || names.some(value => value && knownNames.includes(value))) reasons.push("Existing customer, internal company or corporate alias is excluded.");

  const evidence = candidate.evidence;
  if (!evidence || !domain || normalizeDomain(evidence.domain || "") !== domain) reasons.push("Eligibility evidence must belong to this exact company domain.");
  if (!evidence || !timestampFresh(evidence.checkedAt, now, MAX_COMPANY_EVIDENCE_AGE)) reasons.push("Company eligibility evidence is missing or older than 90 days.");
  if (!evidence?.sources?.length || evidence.sources.some(source => !source.source?.trim() || !source.reference?.trim() || !source.claim?.trim())) reasons.push("Headquarters, size and B2B fit require recorded source evidence.");
  if (!evidence?.hqCountry || !["united states", "united states of america", "us", "usa"].includes(evidence.hqCountry.trim().toLowerCase())) reasons.push("US company headquarters must be verified; a US office or person is insufficient.");
  if (evidence?.b2b !== true) reasons.push("B2B company fit must be verified.");
  const count = evidence?.employeeCount; const min = evidence?.employeeMin; const max = evidence?.employeeMax;
  const present = [count, min, max].filter((value): value is number => value != null);
  const validCounts = present.every(value => Number.isInteger(value) && value >= 0);
  const conflictingCounts = (min != null && max != null && min > max) || (count != null && min != null && count < min) || (count != null && max != null && count > max);
  if (!validCounts || conflictingCounts || (count != null && count < 101) || (max != null && max < 101) || !((count != null && count >= 101) || (min != null && min >= 101))) reasons.push("Verified employee count or lower bound must be at least 101, without conflicting evidence.");

  const title = candidate.title || "";
  if (candidate.segment === "cmo") {
    const roles: readonly string[] = ["cmo", "general_marketing", "brand_marketing", "product_marketing", "content_marketing", "corporate_marketing", "pr_communications", "growth_marketing", "demand_generation"];
    if (!roles.includes(candidate.roleGroup) || !SENIOR_MARKETING.test(title) || !MARKETING_FUNCTION.test(title) || JUNIOR_OR_AMBIGUOUS.test(title)) reasons.push("Marketing outreach requires a verified director-level or more senior eligible marketing role.");
  } else if (candidate.segment === "agency") {
    if (candidate.roleGroup !== "agency" || !AGENCY_EXECUTIVE.test(title) || JUNIOR_OR_AMBIGUOUS.test(title) || /\b(?:partner marketing|partner manager|account executive|account director)\b/i.test(title)) reasons.push("Agency outreach is limited to senior partners and executive agency leadership.");
  } else reasons.push("Campaign audience is not approved.");

  if (!email) reasons.push("A valid exact recipient email is required; addresses cannot be inferred.");
  const emailDomain = email.split("@")[1] || "";
  if (!emailDomain || CONSUMER_EMAIL_DOMAINS.has(emailDomain) || !corporateDomains.some(value => sameCorporateDomain(emailDomain, value))) reasons.push("Recipient must have a verified work address belonging to the company or a verified corporate alias.");
  const verification = candidate.emailVerification;
  if (!verification || verification.status !== "verified" || verification.catchAll !== false || !verification.source?.trim() || !timestampFresh(verification.checkedAt, now, MAX_EMAIL_EVIDENCE_AGE)) reasons.push("Email must be verified within 30 days with an explicit non-catch-all result.");
  return decision(reasons, now);
}

export function evaluateMailbox(mailbox: MailboxReadiness, options: { now?: Date } = {}): PolicyDecision {
  const now = options.now || new Date(); const reasons: string[] = [];
  if (!mailbox?.explicitlySelected || !normalizeEmail(mailbox?.email || "")) reasons.push("An exact sending mailbox must be explicitly selected.");
  if (mailbox?.connected !== true || mailbox.authenticationPassed !== true || mailbox.replyInboxReady !== true) reasons.push("The selected mailbox needs verified authentication, a connected account and working reply collection.");
  if (!timestampFresh(mailbox?.healthCheckedAt, now, MAX_MAILBOX_EVIDENCE_AGE) || !mailbox?.healthSource?.trim()) reasons.push("Mailbox health must be checked from a recorded source within 15 minutes of sending.");
  if (mailbox?.reputation !== "healthy" || !Number.isInteger(mailbox.healthyHistoryDays) || mailbox.healthyHistoryDays < 14) reasons.push("At least 14 days of measured healthy mailbox history is required; active warmup alone does not qualify.");
  const counts = [mailbox?.sentLast7Days, mailbox?.bouncedLast7Days, mailbox?.complaintsLast7Days];
  const validCounts = counts.every(value => Number.isInteger(value) && value >= 0) && mailbox.bouncedLast7Days <= mailbox.sentLast7Days && mailbox.complaintsLast7Days <= mailbox.sentLast7Days;
  if (!validCounts) reasons.push("Mailbox delivery and complaint counts must be complete, nonnegative and internally consistent.");
  else if (mailbox.complaintsLast7Days > 0 || (mailbox.sentLast7Days > 0 && mailbox.bouncedLast7Days / mailbox.sentLast7Days >= 0.02)) reasons.push("Mailbox health is paused for a complaint or a bounce rate of at least 2%.");
  return decision(reasons, now);
}

export function evaluateFooter(footer: FooterConfig, options: { now?: Date } = {}): PolicyDecision {
  const reasons: string[] = [];
  if (!footer?.postalAddressApproved || !footer.businessPostalAddress?.trim() || footer.businessPostalAddress.trim().length < 12 || /[{}<>]|\b(?:placeholder|your address|tbd)\b/i.test(footer.businessPostalAddress)) reasons.push("A legitimate business postal address must be configured and approved before outreach. Never invent or silently insert one.");
  if (!footer?.replyOptOutEnabled || !footer.unsubscribeText?.trim() || !/\b(?:unsubscribe|opt[ -]?out|stop|no (?:more|further) emails)\b/i.test(footer.unsubscribeText)) reasons.push("A clear, working reply-based opt-out must be included.");
  return decision(reasons, options.now || new Date());
}

/** Local policy is one gate only. The caller must additionally check fresh CRM, suppressions, replies, bounces, bookings and quota immediately before each send. */
export function evaluateSendPolicy(input: PolicyOptions & { candidate: Candidate; mailbox: MailboxReadiness; footer: FooterConfig }): PolicyDecision {
  const now = input.now || new Date();
  return decision([
    ...evaluateCandidate(input.candidate, { ...input, now }).reasons,
    ...evaluateMailbox(input.mailbox, { now }).reasons,
    ...evaluateFooter(input.footer, { now }).reasons,
  ], now);
}

export function buildFooter(footer: FooterConfig): string {
  const result = evaluateFooter(footer);
  if (!result.eligible) throw new Error(result.reasons.join(" "));
  return `${footer.unsubscribeText!.trim()}\n${footer.businessPostalAddress!.trim()}`;
}
