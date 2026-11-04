import { AttioCandidate, buildAttioExclusionQueries, checkAttioExclusions } from "@/lib/managed-outreach/attio";

const candidate: AttioCandidate = { email: "person@example.com", companyName: "Example Inc.", companyDomain: "example.com", corporateDomains: ["parent.example.org"], corporateNames: ["Parent Example"] };
const options = { apiKey: "test-only-token", now: () => new Date("2026-11-04T20:00:00Z") };
const record = (id: string, values: Record<string, unknown>) => ({ id: { record_id: id }, values });
const response = (data: unknown[], status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });

describe("fresh Attio exclusions", () => {
  it("checks aliases, domain boundaries, parent/root domains, exact email and same-account people without lifecycle filters", () => {
    const queries = buildAttioExclusionQueries(candidate);
    expect(queries.map(query => query.object)).toEqual(["companies", "people"]);
    expect(JSON.stringify(queries)).toContain('"$eq":"parent.example.org"');
    expect(JSON.stringify(queries)).toContain('"root_domain":{"$eq":"example.org"}');
    expect(JSON.stringify(queries)).toContain('"$ends_with":".example.com"');
    expect(JSON.stringify(queries)).toContain('"email_address":{"$eq":"person@example.com"}');
    expect(JSON.stringify(queries)).not.toMatch(/lifecycle|stage|customer_status/);
  });

  it("requires fresh full company and people checks for every send, with no cache", async () => {
    const request = jest.fn().mockImplementation(async () => response([]));
    expect((await checkAttioExclusions(candidate, { ...options, fetch: request })).clear).toBe(true);
    expect((await checkAttioExclusions(candidate, { ...options, fetch: request })).clear).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[0][1]).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ limit: 100, offset: 0 });
  });

  it("excludes a company alias regardless of its status", async () => {
    const request = jest.fn()
      .mockResolvedValueOnce(response([record("company-id", { domains: [{ domain: "parent.example.org", root_domain: "example.org" }], stage: [{ status: { title: "Lost" } }] })]))
      .mockResolvedValueOnce(response([]));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request })).toMatchObject({ clear: false, complete: true, matches: [{ object: "companies", recordId: "company-id" }] });
  });

  it("excludes a company when only a different person at that domain exists", async () => {
    const request = jest.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([record("person-id", { email_addresses: [{ email_address: "someone-else@example.com", email_domain: "example.com", email_root_domain: "example.com" }] })]));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request })).toMatchObject({ clear: false, complete: true, matches: [{ object: "people", recordId: "person-id" }] });
  });

  it("matches a company name without a domain while rejecting unrelated token hits", async () => {
    const request = jest.fn()
      .mockResolvedValueOnce(response([record("unrelated", { name: [{ value: "Example Other" }], domains: [{ domain: "notexample.com" }] }), record("name-only", { name: [{ value: "Example, Incorporated" }] })]))
      .mockResolvedValueOnce(response([]));
    expect((await checkAttioExclusions(candidate, { ...options, fetch: request })).matches).toEqual([{ object: "companies", recordId: "name-only" }]);
  });

  it("pages through nonmatching name hits before clearing an account", async () => {
    const request = jest.fn()
      .mockResolvedValueOnce(response([record("other-1", { name: [{ value: "Example Other One" }] })]))
      .mockResolvedValueOnce(response([record("other-2", { name: [{ value: "Example Other Two" }] })]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request, pageSize: 1 })).toMatchObject({ clear: true, complete: true });
    expect(request.mock.calls.map(call => JSON.parse(call[1].body).offset)).toEqual([0, 1, 2, 0]);
  });

  it("fails closed when a full page has not been exhausted", async () => {
    const request = jest.fn().mockResolvedValue(response([record("other", { name: [{ value: "Example Other" }] })]));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request, pageSize: 1, maxPages: 1 })).toMatchObject({ clear: false, complete: false });
  });

  it("fails closed if pagination repeats a record", async () => {
    const request = jest.fn().mockImplementation(async () => response([record("other", { name: [{ value: "Example Other" }] })]));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request, pageSize: 1 })).toMatchObject({ clear: false, complete: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed on missing credentials without making a request", async () => {
    const request = jest.fn();
    expect(await checkAttioExclusions(candidate, { ...options, apiKey: "", fetch: request })).toMatchObject({ clear: false, complete: false });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("fails closed on provider status %s without exposing response data", async status => {
    const request = jest.fn().mockResolvedValue(new Response("private provider error", { status }));
    const result = await checkAttioExclusions(candidate, { ...options, fetch: request });
    expect(result).toMatchObject({ clear: false, complete: false });
    expect(JSON.stringify(result)).not.toContain("private provider error");
    expect(JSON.stringify(result)).not.toContain(options.apiKey);
  });

  it.each([{ data: null }, { data: [{}] }, { data: [record("missing-evidence", {})] }, { data: [record("bad-domain", { domains: [{}] })] }])("fails closed on invalid payload %#", async payload => {
    const request = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request })).toMatchObject({ clear: false, complete: false });
  });

  it("aborts a timed-out request and never reports clearance", async () => {
    const request = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    expect(await checkAttioExclusions(candidate, { ...options, fetch: request as typeof fetch, timeoutMs: 5 })).toMatchObject({ clear: false, complete: false });
  });

  it("does not accept missing company identity or inferred email", async () => {
    const request = jest.fn();
    expect((await checkAttioExclusions({ ...candidate, companyName: undefined }, { ...options, fetch: request })).clear).toBe(false);
    expect((await checkAttioExclusions({ ...candidate, email: "person at example" }, { ...options, fetch: request })).clear).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
