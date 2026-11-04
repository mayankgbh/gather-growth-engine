import { normalizeCompanyName, normalizeDomain, normalizeEmail, sameCorporateDomain } from "./policy";

/** Read-only REST adapter. Do not cache a clear result across sends. A connected-tool
 * clearance path can use the same filters; it is separate from this API-key adapter.
 * Official API contract checked 2026-11-04:
 * https://docs.attio.com/rest-api/endpoint-reference/records/list-records
 * https://docs.attio.com/rest-api/attribute-types/attribute-types-domain
 * https://docs.attio.com/rest-api/attribute-types/attribute-types-email-address
 * https://docs.attio.com/rest-api/guides/pagination
 */
export type AttioCandidate = {
  email: string;
  companyDomain: string;
  corporateDomains?: string[];
  companyName?: string;
  corporateNames?: string[];
};
export type AttioMatch = { object: "companies" | "people"; recordId: string };
export type AttioDecision = {
  clear: boolean;
  /** False means the scan was incomplete; clear is never true in that case. */
  complete: boolean;
  checkedAt: string;
  reason: string;
  matches: AttioMatch[];
};
export type AttioOptions = {
  apiKey?: string;
  fetch?: typeof fetch;
  /** Total deadline, including all pages, rather than one deadline per page. */
  timeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
  now?: () => Date;
};
export type AttioQuery = { object: "companies" | "people"; filter: Record<string, unknown> };

type AttioRecord = { id: { record_id: string }; values: Record<string, unknown> };

function domainsToCheck(candidate: AttioCandidate): string[] {
  const email = normalizeEmail(candidate.email || "");
  const values = [candidate.companyDomain, ...(candidate.corporateDomains || []), email.split("@")[1] || ""];
  if (!email || !candidate.companyName?.trim() || values.some(value => !normalizeDomain(value || ""))) throw new Error("invalid_identity");
  if (values.length > 50 || (candidate.corporateNames || []).length > 50) throw new Error("identity_too_large");
  return Array.from(new Set(values.map(normalizeDomain)));
}

function domainQueryVariants(domains: string[]): string[] {
  // Include parents to find an account recorded at its root. Never query a one-label
  // suffix, and include explicit dot boundaries so evil-example.com cannot match.
  return Array.from(new Set(domains.flatMap(domain => {
    const labels = domain.split(".");
    return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
  })));
}

function companyNames(candidate: AttioCandidate): string[] {
  const values = [candidate.companyName || "", ...(candidate.corporateNames || [])];
  if (values.some(value => !normalizeCompanyName(value))) throw new Error("invalid_identity");
  return Array.from(new Set(values));
}

function companyNameToken(value: string): string {
  // A broad token query retrieves punctuation/legal-suffix variants; comparison is
  // done locally on normalized complete names before declaring a match.
  return value.trim().replace(/(?:,?\s+(?:incorporated|inc\.?|llc\.?|ltd\.?|limited|corporation|corp\.?))+$/i, "")
    .split(/[^a-zA-Z0-9\u00C0-\uFFFF]+/).filter(Boolean).sort((a, b) => b.length - a.length)[0] || value.trim();
}

export function buildAttioExclusionQueries(candidate: AttioCandidate): AttioQuery[] {
  const domains = domainQueryVariants(domainsToCheck(candidate));
  const names = companyNames(candidate);
  const companyConditions: Record<string, unknown>[] = domains.flatMap(domain => [
    { domains: { domain: { $eq: domain } } },
    { domains: { domain: { $ends_with: `.${domain}` } } },
    { domains: { root_domain: { $eq: domain } } },
  ]);
  companyConditions.push(...names.map(name => ({ name: { $contains: companyNameToken(name) } })));
  const peopleConditions: Record<string, unknown>[] = [
    { email_addresses: { email_address: { $eq: normalizeEmail(candidate.email) } } },
    ...domains.flatMap(domain => [
      { email_addresses: { email_domain: { $eq: domain } } },
      { email_addresses: { email_domain: { $ends_with: `.${domain}` } } },
      { email_addresses: { email_root_domain: { $eq: domain } } },
    ]),
  ];
  // All CRM people at the corporate domain exclude the account, even if a separate
  // company record has not been created. No lifecycle/status condition is allowed.
  return [{ object: "companies", filter: { $or: companyConditions } }, { object: "people", filter: { $or: peopleConditions } }];
}

function parseRecords(payload: unknown, limit: number): AttioRecord[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) throw new Error("invalid_response");
  const data: unknown[] = (payload as { data: unknown[] }).data;
  if (data.length > limit) throw new Error("invalid_pagination");
  return data.map(record => {
    if (!record || typeof record !== "object") throw new Error("invalid_response");
    const value = record as Partial<AttioRecord>;
    if (!value.id || typeof value.id.record_id !== "string" || !value.id.record_id || !value.values || typeof value.values !== "object" || Array.isArray(value.values)) throw new Error("invalid_response");
    return value as AttioRecord;
  });
}

function attributeValues(record: AttioRecord, key: string): Record<string, unknown>[] {
  const raw = record.values[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("invalid_response");
  return raw as Record<string, unknown>[];
}

function isMatch(record: AttioRecord, object: AttioQuery["object"], candidate: AttioCandidate): boolean {
  const domains = domainsToCheck(candidate);
  if (object === "companies") {
    const foundDomains = attributeValues(record, "domains");
    const foundNames = attributeValues(record, "name");
    if (!foundDomains.length && !foundNames.length) throw new Error("missing_match_evidence");
    if (foundDomains.some(value => typeof value.domain !== "string" || !normalizeDomain(value.domain)) || foundNames.some(value => typeof value.value !== "string" || !normalizeCompanyName(value.value))) throw new Error("invalid_match_evidence");
    if (foundDomains.some(value => [value.domain, value.root_domain].some(found => typeof found === "string" && domains.some(domain => sameCorporateDomain(found, domain))))) return true;
    const names = companyNames(candidate).map(normalizeCompanyName);
    return foundNames.some(value => typeof value.value === "string" && names.includes(normalizeCompanyName(value.value)));
  }
  const emails = attributeValues(record, "email_addresses");
  if (!emails.length) throw new Error("missing_match_evidence");
  if (emails.some(value => typeof value.email_address !== "string" || !normalizeEmail(value.email_address))) throw new Error("invalid_match_evidence");
  return emails.some(value => {
    const email = typeof value.email_address === "string" ? normalizeEmail(value.email_address) : "";
    const foundDomains = [email.split("@")[1], value.email_domain, value.email_root_domain];
    return email === normalizeEmail(candidate.email) || foundDomains.some(found => typeof found === "string" && domains.some(domain => sameCorporateDomain(found, domain)));
  });
}

/** Fresh read-only check immediately before a send. Never expose provider bodies,
 * names, addresses or keys in failure messages or logs. */
export async function checkAttioExclusions(candidate: AttioCandidate, options: AttioOptions = {}): Promise<AttioDecision> {
  const now = options.now || (() => new Date());
  const matches: AttioMatch[] = [];
  const result = (clear: boolean, complete: boolean, reason: string): AttioDecision => ({ clear, complete, checkedAt: now().toISOString(), reason, matches });
  const apiKey = options.apiKey ?? process.env.ATTIO_API_KEY;
  if (!apiKey?.trim()) return result(false, false, "Direct Attio API access is unavailable. A fresh authenticated CRM clearance is required before sending.");
  const limit = options.pageSize ?? 100; const maxPages = options.maxPages ?? 50;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return result(false, false, "Attio scan configuration is invalid.");
  let queries: AttioQuery[];
  try { queries = buildAttioExclusionQueries(candidate); } catch { return result(false, false, "Verified company identity, corporate aliases and an exact email are required for CRM screening."); }
  const request = options.fetch || fetch;
  const deadline = Date.now() + timeoutMs;
  try {
    for (const query of queries) {
      let finished = false;
      const seen = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timeout");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remaining);
        let records: AttioRecord[];
        try {
          const response = await request(`https://api.attio.com/v2/objects/${query.object}/records/query`, {
            method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ filter: query.filter, limit, offset: page * limit }),
          });
          if (!response.ok) throw new Error("provider_failure");
          records = parseRecords(await response.json(), limit);
        } finally { clearTimeout(timeout); }
        for (const record of records) {
          if (seen.has(record.id.record_id)) throw new Error("incomplete_pagination");
          seen.add(record.id.record_id);
          if (isMatch(record, query.object, candidate)) matches.push({ object: query.object, recordId: record.id.record_id });
        }
        if (records.length < limit) { finished = true; break; }
      }
      if (!finished) throw new Error("incomplete_pagination");
    }
    return matches.length ? result(false, true, "An existing Attio company, person or corporate alias excludes this account, regardless of lifecycle status.") : result(true, true, "Fresh complete Attio company, person and corporate-alias checks found no matching record.");
  } catch {
    return result(false, false, matches.length ? "A CRM exclusion was found and the scan did not complete. Keep this account excluded." : "Attio screening failed or pagination was incomplete. Hold outreach until a fresh complete check succeeds.");
  }
}
