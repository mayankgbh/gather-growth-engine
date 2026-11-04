import {
  cancelPreMutationReservation,
  claimBudgetAndJob, claimJob, getOwnerJobs, importCandidateJob, markJobReady, markMutationUncertain,
  ManagedOutreachConflictError, ManagedOutreachLeaseError, updateWithLease, upsertEvent,
} from "@/lib/managed-outreach/store";
import type { Candidate } from "@/lib/managed-outreach/policy";

jest.mock("@/lib/prisma", () => ({ prisma: {
  managedOutreachJob: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  managedOutreachEvent: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(), $queryRaw: jest.fn(),
} }));
const { prisma } = require("@/lib/prisma");

// Stateful delegates exercise competing claims and retries without a database.
type Row = Record<string, any>;
let jobs: Row[];
let events: Row[];
const now = new Date("2026-11-04T20:00:00.000Z");
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some((condition: Row) => matches(row, condition));
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((condition: Row) => matches(row, condition));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (key === "workspaceId_externalId" || key === "workspaceId_email") return matches(row, value);
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === "lte") return row[key] != null && row[key] <= (expected as any);
        if (operator === "lt") return row[key] != null && row[key] < (expected as any);
        if (operator === "gt") return row[key] != null && row[key] > (expected as any);
        if (operator === "gte") return row[key] != null && row[key] >= (expected as any);
        if (operator === "in") return (expected as unknown[]).includes(row[key]);
        if (operator === "not") return row[key] !== expected;
        throw new Error(`Unsupported test query operator: ${operator}`);
      });
    }
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
}

function candidate(email = "person@example.com"): Candidate {
  return {
    email, company: "Example", companyDomain: "example.com", title: "Director of Marketing",
    segment: "cmo", roleGroup: "general_marketing",
    evidence: { domain: "example.com", hqCountry: "US", employeeMin: 101, b2b: true,
      checkedAt: now.toISOString(), sources: [{ source: "Research", reference: "https://example.com", claim: "US B2B company with 101 employees" }] },
    emailVerification: { status: "verified", catchAll: false, checkedAt: now.toISOString(), source: "verification-provider" },
  };
}
function importInput(overrides: Row = {}) {
  return { workspaceId: "workspace-a", externalId: "source-a", candidate: candidate(),
    steps: [{ subject: "Example subject", body: "Example body" }], experimentId: "experiment-a",
    variant: "A", senderEmail: "sender@example.org", ...overrides };
}
function job(overrides: Row = {}): Row {
  return { id: "job-a", workspaceId: "workspace-a", externalId: "source-a", email: "person@example.com",
    companyDomain: "example.com", candidateJson: JSON.stringify(candidate()), stepsJson: "[]",
    experimentId: "experiment-a", variant: "A", senderEmail: "sender@example.org", status: "ready",
    providerCampaignId: null, sequenceFingerprint: null, nextStep: 1, dueAt: now,
    leaseToken: null, leaseUntil: null, lastError: null, createdAt: now, updatedAt: now, ...overrides };
}
function eventInput(overrides: Row = {}) {
  return { id: "provider:event-a", workspaceId: "workspace-a", jobId: null, type: "sent",
    providerMessageId: "message-a", occurredAt: now, data: { sequence: 1, receipt: { accepted: true } }, ...overrides };
}

beforeEach(() => {
  jest.resetAllMocks(); jobs = []; events = [];
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  prisma.$queryRaw.mockResolvedValue([{ acquired: "" }]);
  for (const [delegate, rows] of [[prisma.managedOutreachJob, jobs], [prisma.managedOutreachEvent, events]] as const) {
    delegate.findMany.mockImplementation(async ({ where = {} }: Row) => rows.filter(row => matches(row, where)).map(row => ({ ...row })));
    delegate.findFirst.mockImplementation(async ({ where }: Row) => {
      const row = rows.find(row => matches(row, where)); return row ? { ...row } : null;
    });
    delegate.findUnique.mockImplementation(delegate.findFirst);
  }
  prisma.managedOutreachJob.create.mockImplementation(async ({ data }: Row) => {
    if (jobs.some(row => row.workspaceId === data.workspaceId && (row.externalId === data.externalId || row.email === data.email))) throw { code: "P2002" };
    const row = job({ id: `job-${jobs.length + 1}`, status: "held", dueAt: null, ...data });
    jobs.push(row); return { ...row };
  });
  prisma.managedOutreachJob.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const matching = jobs.filter(row => matches(row, where));
    matching.forEach(row => Object.assign(row, data)); return { count: matching.length };
  });
  prisma.managedOutreachEvent.create.mockImplementation(async ({ data }: Row) => {
    if (events.some(row => row.id === data.id)) throw { code: "P2002" };
    const row = { createdAt: now, ...data }; events.push(row); return { ...row };
  });
});

describe("managed outreach durable jobs", () => {
  it("imports normalized contacts held and never starts sending on import", async () => {
    const result = await importCandidateJob(importInput({ candidate: candidate(" Person@Example.com ") }));
    expect(result).toMatchObject({ workspaceId: "workspace-a", email: "person@example.com", status: "held", providerCampaignId: null, nextStep: 1 });
    expect(prisma.managedOutreachJob.updateMany).not.toHaveBeenCalled();
  });

  it("preserves provider progress and the original sequence on repeat import", async () => {
    const original = job({ status: "queued", providerCampaignId: "campaign-a", nextStep: 2,
      sequenceFingerprint: "fingerprint-a", stepsJson: '[{"subject":"Original"}]' });
    jobs.push(original);
    const result = await importCandidateJob(importInput({ steps: [{ subject: "Changed", body: "Changed" }], variant: "B" }));
    expect(result).toEqual(original);
    expect(jobs).toHaveLength(1);
    expect(prisma.managedOutreachJob.updateMany).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent imports for the same owner and recipient", async () => {
    const imported = await Promise.all([importCandidateJob(importInput()), importCandidateJob(importInput())]);
    expect(imported[0].id).toBe(imported[1].id);
    expect(jobs).toHaveLength(1);
  });

  it("rejects reassigning an external identifier to a different recipient", async () => {
    jobs.push(job());
    await expect(importCandidateJob(importInput({ candidate: candidate("another@example.com") }))).rejects.toBeInstanceOf(ManagedOutreachConflictError);
    expect(jobs[0].email).toBe("person@example.com");
  });

  it("returns only jobs belonging to the requested workspace", async () => {
    jobs.push(job(), job({ id: "job-b", workspaceId: "workspace-b" }));
    expect((await getOwnerJobs("workspace-a")).map(row => row.id)).toEqual(["job-a"]);
  });

  it("allows only one worker to claim a due ready job", async () => {
    jobs.push(job());
    const attempts = await Promise.all([claimJob("job-a", "workspace-a", now), claimJob("job-a", "workspace-a", now)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.filter(result => result === null)).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "claimed", leaseToken: expect.any(String) });
    expect(jobs[0].leaseUntil.getTime()).toBeGreaterThan(now.getTime());
  });

  it.each(["claimed", "uncertain", "held", "staged", "completed"])("never automatically reclaims an expired %s job", async status => {
    jobs.push(job({ status, leaseToken: "old-token", leaseUntil: new Date(now.getTime() - 1) }));
    expect(await claimJob("job-a", "workspace-a", now)).toBeNull();
    expect(jobs[0].status).toBe(status);
  });

  it("holds future, unscheduled, actively leased and foreign workspace jobs", async () => {
    const configurations = [
      { dueAt: new Date(now.getTime() + 1) }, { dueAt: null },
      { leaseToken: "other-worker", leaseUntil: new Date(now.getTime() + 1) },
      { workspaceId: "workspace-b" },
    ];
    for (const configuration of configurations) {
      jobs.splice(0, jobs.length, job(configuration));
      expect(await claimJob("job-a", "workspace-a", now)).toBeNull();
      expect(jobs[0].status).toBe("ready");
    }
  });

  it("allows an expired lease on a ready job to be replaced", async () => {
    jobs.push(job({ leaseToken: "old-token", leaseUntil: new Date(now.getTime() - 1) }));
    const claimed = await claimJob("job-a", "workspace-a", now);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.leaseToken).not.toBe("old-token");
  });

  it("requires the current live lease and workspace when recording progress", async () => {
    jobs.push(job({ status: "claimed", leaseToken: "token-a", leaseUntil: new Date(now.getTime() + 60_000) }));
    await expect(updateWithLease("job-a", "workspace-a", "wrong-token", { status: "staged" }, now)).rejects.toBeInstanceOf(ManagedOutreachLeaseError);
    await expect(updateWithLease("job-a", "workspace-b", "token-a", { status: "staged" }, now)).rejects.toBeInstanceOf(ManagedOutreachLeaseError);
    await expect(updateWithLease("job-a", "workspace-a", "token-a", { status: "staged" }, new Date(now.getTime() + 60_001))).rejects.toBeInstanceOf(ManagedOutreachLeaseError);
    expect(jobs[0].status).toBe("claimed");
    expect(await updateWithLease("job-a", "workspace-a", "token-a", { providerCampaignId: "campaign-a" }, now)).toMatchObject({ providerCampaignId: "campaign-a" });
  });

  it("quarantines unknown mutation outcomes even after their worker lease expires", async () => {
    jobs.push(job({ status: "claimed", leaseToken: "token-a", leaseUntil: new Date("2000-01-01T00:00:00Z") }));
    await markMutationUncertain("job-a", "workspace-a", "token-a", "Provider result unavailable", "campaign-a");
    expect(jobs[0]).toMatchObject({ status: "uncertain", providerCampaignId: "campaign-a", leaseToken: null, leaseUntil: null });
    expect(await claimJob("job-a", "workspace-a", now)).toBeNull();
  });

  it("marks due held and staged jobs ready without reviving uncertain or future jobs", async () => {
    for (const status of ["held", "staged"]) {
      jobs.splice(0, jobs.length, job({ status, dueAt: null }));
      expect(await markJobReady("job-a", "workspace-a", now)).toMatchObject({ status: "ready", dueAt: now });
    }
    for (const configuration of [{ status: "uncertain" }, { status: "held", dueAt: new Date(now.getTime() + 1) }]) {
      jobs.splice(0, jobs.length, job(configuration));
      expect(await markJobReady("job-a", "workspace-a", now)).toBeNull();
    }
  });
});

describe("managed outreach immutable events", () => {
  it("deduplicates identical event payloads regardless of object key order", async () => {
    const first = await upsertEvent(eventInput());
    const repeated = await upsertEvent(eventInput({ data: { receipt: { accepted: true }, sequence: 1 } }));
    expect(repeated).toEqual(first);
    expect(events).toHaveLength(1);
  });

  it("deduplicates simultaneous identical receipts", async () => {
    const recorded = await Promise.all([upsertEvent(eventInput()), upsertEvent(eventInput())]);
    expect(recorded[0]).toEqual(recorded[1]);
    expect(events).toHaveLength(1);
  });

  it.each([
    { data: { sequence: 2, receipt: { accepted: true } } },
    { type: "delivered" }, { providerMessageId: "message-b" },
    { occurredAt: new Date(now.getTime() + 1) }, { workspaceId: "workspace-b" },
  ])("rejects conflicting retries without rewriting the first record: %j", async change => {
    const first = await upsertEvent(eventInput());
    await expect(upsertEvent(eventInput(change))).rejects.toBeInstanceOf(ManagedOutreachConflictError);
    expect(events).toEqual([first]);
  });

  it("rejects attaching an event to a job in another workspace", async () => {
    jobs.push(job({ workspaceId: "workspace-b" }));
    await expect(upsertEvent(eventInput({ jobId: "job-a" }))).rejects.toThrow();
    expect(events).toHaveLength(0);
  });
});

describe("managed outreach dispatch reservations", () => {
  function reservation(index: number, nextStep = 1, minutesAgo = 30, workspaceId = "workspace-a"): Row {
    return { id: `reservation-${index}`, workspaceId, jobId: `previous-job-${index}`, type: "dispatch_reserved",
      occurredAt: new Date(now.getTime() - minutesAgo * 60_000), dataJson: JSON.stringify({ nextStep }), createdAt: now };
  }

  it("takes the workspace lock before checking quota and durably reserves a successful claim", async () => {
    jobs.push(job());
    const result = await claimBudgetAndJob("job-a", "workspace-a", now);
    expect(result).toMatchObject({ job: { id: "job-a", status: "claimed" }, reservationId: expect.any(String) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId: "workspace-a", jobId: "job-a", type: "dispatch_reserved", occurredAt: now });
    expect(JSON.parse(events[0].dataJson)).toMatchObject({ nextStep: 1, kind: "new" });
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.managedOutreachJob.findFirst.mock.invocationCallOrder[0]);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.managedOutreachEvent.findMany.mock.invocationCallOrder[0]);
  });

  it("holds a sixth new recipient in the rolling 24-hour window", async () => {
    jobs.push(job());
    for (let index = 0; index < 5; index++) events.push(reservation(index));
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toEqual({ reason: "quota" });
    expect(jobs[0].status).toBe("ready");
    expect(events).toHaveLength(5);
  });

  it("holds an eleventh total dispatch including followups", async () => {
    jobs.push(job({ nextStep: 2 }));
    for (let index = 0; index < 10; index++) events.push(reservation(index, 2));
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toEqual({ reason: "quota" });
    expect(events).toHaveLength(10);
  });

  it("allows followups within the total cap when the first-touch cap is full", async () => {
    jobs.push(job({ nextStep: 2 }));
    for (let index = 0; index < 5; index++) events.push(reservation(index));
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toMatchObject({ job: { nextStep: 2 } });
    expect(events).toHaveLength(6);
  });

  it("enforces at least 15 minutes between workspace dispatches", async () => {
    jobs.push(job()); events.push(reservation(1, 2, 14));
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toEqual({ reason: "quota" });
    events[0].occurredAt = new Date(now.getTime() - 15 * 60_000);
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toMatchObject({ job: { id: "job-a" } });
  });

  it("does not reserve the same logical step again after its reservation leaves the rolling window", async () => {
    jobs.push(job());
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toMatchObject({ job: { id: "job-a" } });
    const later = new Date(now.getTime() + 25 * 60 * 60_000);
    Object.assign(jobs[0], { status: "ready", dueAt: later, leaseToken: null, leaseUntil: null });
    expect(await claimBudgetAndJob("job-a", "workspace-a", later)).toEqual({ reason: "blocked" });
    expect(events).toHaveLength(1);
  });

  it("permits a new attempt only after an immutable pre-mutation cancellation and the spacing window", async () => {
    jobs.push(job({ providerCampaignId: "campaign-a", sequenceFingerprint: "fingerprint-a" }));
    const first = await claimBudgetAndJob("job-a", "workspace-a", now);
    if (!("job" in first)) throw new Error("Expected an initial claim");
    await cancelPreMutationReservation("job-a", "workspace-a", first.job.leaseToken, first.reservationId, "Preflight unavailable", now);
    expect(jobs[0]).toMatchObject({ status: "staged", leaseToken: null, leaseUntil: null });
    expect(events.map(event => event.type)).toEqual(["dispatch_reserved", "dispatch_cancelled"]);
    await markJobReady("job-a", "workspace-a", now);
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toEqual({ reason: "quota" });
    const later = new Date(now.getTime() + 15 * 60_000);
    const next = await claimBudgetAndJob("job-a", "workspace-a", later);
    expect(next).toMatchObject({ reservationId: `${first.reservationId}:attempt:2`, job: { status: "claimed", nextStep: 1 } });
    expect(events.filter(event => event.type === "dispatch_reserved")).toHaveLength(2);
  });

  it.each(["activation_attempted", "activation_queued"])("forbids cancellation after %s evidence", async type => {
    jobs.push(job());
    const first = await claimBudgetAndJob("job-a", "workspace-a", now);
    if (!("job" in first)) throw new Error("Expected an initial claim");
    events.push({ id: `marker-${type}`, workspaceId: "workspace-a", jobId: "job-a", type, occurredAt: now,
      dataJson: JSON.stringify({ reservationId: first.reservationId, step: 1 }) });
    await expect(cancelPreMutationReservation("job-a", "workspace-a", first.job.leaseToken, first.reservationId, "Must hold", now))
      .rejects.toBeInstanceOf(ManagedOutreachConflictError);
    expect(jobs[0].status).toBe("claimed");
    expect(events.some(event => event.type === "dispatch_cancelled")).toBe(false);
  });

  it("rejects cancellation by another workspace or lease holder", async () => {
    jobs.push(job());
    const first = await claimBudgetAndJob("job-a", "workspace-a", now);
    if (!("job" in first)) throw new Error("Expected an initial claim");
    for (const [workspaceId, token] of [["workspace-b", first.job.leaseToken], ["workspace-a", "stale-token"]]) {
      await expect(cancelPreMutationReservation("job-a", workspaceId, token, first.reservationId, "Must hold", now))
        .rejects.toBeInstanceOf(ManagedOutreachLeaseError);
    }
    expect(events.some(event => event.type === "dispatch_cancelled")).toBe(false);
  });

  it("creates no reservation when the atomic job claim loses", async () => {
    jobs.push(job());
    prisma.managedOutreachJob.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toEqual({ reason: "lease" });
    expect(prisma.managedOutreachEvent.create).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("blocks another first touch at the same exact company while prior outreach is active", async () => {
    jobs.push(job(), job({ id: "other-job", email: "another@example.com", status: "queued" }));
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toEqual({ reason: "blocked" });
    expect(events).toHaveLength(0);
  });

  it("does not count another owner's company jobs or quota reservations", async () => {
    jobs.push(job(), job({ id: "other-job", workspaceId: "workspace-b", status: "queued" }));
    for (let index = 0; index < 10; index++) events.push(reservation(index, 1, 1, "workspace-b"));
    expect(await claimBudgetAndJob("job-a", "workspace-a", now)).toMatchObject({ job: { id: "job-a" } });
  });
});
