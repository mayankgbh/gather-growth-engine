import { createHash, randomUUID } from "crypto";
import type { ManagedOutreachEvent, ManagedOutreachJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeDomain, normalizeEmail, type Candidate } from "./policy";

export type ManagedOutreachJobStatus = "held" | "ready" | "claimed" | "staged" | "queued" | "uncertain" | "completed" | "stopped" | "suppressed";
export type ClaimedManagedOutreachJob = ManagedOutreachJob & { leaseToken: string; leaseUntil: Date };
type StoreDb = Pick<Prisma.TransactionClient, "managedOutreachJob" | "managedOutreachEvent">;
export type ImportCandidateJobInput = {
  workspaceId: string;
  externalId: string;
  candidate: Candidate;
  steps: unknown[];
  experimentId: string;
  variant: string;
  senderEmail: string;
};
export type ManagedOutreachJobPatch = {
  status?: ManagedOutreachJobStatus;
  providerCampaignId?: string | null;
  sequenceFingerprint?: string | null;
  nextStep?: number;
  dueAt?: Date | null;
  leaseUntil?: Date;
  lastError?: string | null;
};
export type ManagedOutreachEventInput = {
  id: string;
  workspaceId: string;
  jobId?: string | null;
  type: string;
  providerMessageId?: string | null;
  occurredAt: Date;
  data: unknown;
};

export class ManagedOutreachConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ManagedOutreachConflictError"; }
}
export class ManagedOutreachLeaseError extends Error {
  constructor() { super("Managed outreach lease was lost, expired or belongs to another workspace."); this.name = "ManagedOutreachLeaseError"; }
}

// Server-owned hard ceilings. Requests cannot raise these limits.
export const MANAGED_OUTREACH_DISPATCH_LIMITS = Object.freeze({
  newRecipientsPer24Hours: 5,
  totalPer24Hours: 10,
  minimumSpacingMs: 15 * 60_000,
});
const DEFAULT_LEASE_MS = 120_000;
const DAY_MS = 24 * 60 * 60_000;
const RESERVATION_TYPE = "dispatch_reserved";
const STATUSES: readonly string[] = ["held", "ready", "claimed", "staged", "queued", "uncertain", "completed", "stopped", "suppressed"];

function required(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required.`);
  return value.trim();
}
function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("A valid timestamp is required.");
  return value;
}
function leaseEnd(now: Date, durationMs: number): Date {
  validDate(now);
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 15 * 60_000) throw new TypeError("Lease duration must be between 1 ms and 15 minutes.");
  return new Date(now.getTime() + durationMs);
}
function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

/** Stable object-key ordering makes equivalent provider retries immutable. */
export function canonicalOutreachJson(value: unknown): string {
  function sort(input: unknown, ancestors: Set<object>): unknown {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object" || (Object.getPrototypeOf(input) !== Object.prototype && !Array.isArray(input))) {
      throw new TypeError("Outreach data must contain only JSON values.");
    }
    if (ancestors.has(input)) throw new TypeError("Outreach data cannot contain a cycle.");
    ancestors.add(input);
    let result: unknown;
    if (Array.isArray(input)) result = input.map(item => sort(item, ancestors));
    else {
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input).sort()) {
        const entry = (input as Record<string, unknown>)[key];
        // Optional properties are omitted just as they are in JSON.stringify.
        if (entry !== undefined) output[key] = sort(entry, ancestors);
      }
      result = output;
    }
    ancestors.delete(input);
    return result;
  }
  return JSON.stringify(sort(value, new Set()));
}

/** Every method requires an owner-derived workspace ID; authentication is the caller's responsibility. */
export function createManagedOutreachStore(db: StoreDb = prisma) {
  async function importCandidateJob(input: ImportCandidateJobInput): Promise<ManagedOutreachJob> {
    const workspaceId = required(input.workspaceId, "workspaceId");
    const externalId = required(input.externalId, "externalId");
    const email = normalizeEmail(input.candidate?.email || "");
    const companyDomain = normalizeDomain(input.candidate?.companyDomain || "");
    const senderEmail = normalizeEmail(input.senderEmail || "");
    if (!email || !companyDomain || !senderEmail || !Array.isArray(input.steps)) throw new TypeError("Valid recipient, company, sender and steps are required.");
    const data = {
      workspaceId, externalId, email, companyDomain, senderEmail,
      candidateJson: canonicalOutreachJson({ ...input.candidate, email, companyDomain }),
      stepsJson: canonicalOutreachJson(input.steps),
      experimentId: required(input.experimentId, "experimentId"),
      variant: required(input.variant, "variant"),
      status: "held",
    };
    async function existing() {
      const matches = await db.managedOutreachJob.findMany({ where: { workspaceId, OR: [{ externalId }, { email }] } });
      if (matches.length > 1 || (matches[0] && matches[0].email !== email)) {
        throw new ManagedOutreachConflictError("The external candidate ID and recipient identify different existing jobs.");
      }
      return matches[0] || null;
    }
    const previous = await existing();
    // Re-import never rewrites content, provider IDs, leases, stop states or progress.
    if (previous) return previous;
    try { return await db.managedOutreachJob.create({ data }); }
    catch (error) {
      if (!uniqueViolation(error)) throw error;
      const winner = await existing();
      if (!winner) throw error;
      return winner;
    }
  }

  function getOwnerJobs(workspaceId: string) {
    return db.managedOutreachJob.findMany({ where: { workspaceId: required(workspaceId, "workspaceId") }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  }

  async function claimJob(jobId: string, workspaceId: string, now: Date, leaseDurationMs = DEFAULT_LEASE_MS): Promise<ClaimedManagedOutreachJob | null> {
    const leaseUntil = leaseEnd(now, leaseDurationMs);
    const leaseToken = randomUUID();
    const changed = await db.managedOutreachJob.updateMany({
      where: { id: required(jobId, "jobId"), workspaceId: required(workspaceId, "workspaceId"), status: "ready", dueAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { status: "claimed", leaseToken, leaseUntil },
    });
    if (changed.count !== 1) return null;
    const job = await db.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId, status: "claimed", leaseToken } });
    if (!job) throw new ManagedOutreachLeaseError();
    return job as ClaimedManagedOutreachJob;
  }

  async function markJobReady(jobId: string, workspaceId: string, now: Date): Promise<ManagedOutreachJob | null> {
    validDate(now);
    const scope = { id: required(jobId, "jobId"), workspaceId: required(workspaceId, "workspaceId"), status: { in: ["held", "staged"] } };
    const changed = await db.managedOutreachJob.updateMany({
      where: { ...scope, OR: [{ dueAt: null }, { dueAt: { lte: now } }] },
      data: { status: "ready", dueAt: now },
    });
    if (!changed.count) return null;
    return db.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId } });
  }

  async function updateWithLease(jobId: string, workspaceId: string, leaseToken: string, patch: ManagedOutreachJobPatch, now = new Date()): Promise<ManagedOutreachJob> {
    validDate(now);
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new TypeError("Invalid managed outreach status.");
    if (patch.nextStep !== undefined && (!Number.isInteger(patch.nextStep) || patch.nextStep < 1)) throw new TypeError("nextStep must be a positive integer.");
    if (patch.dueAt) validDate(patch.dueAt);
    if (patch.leaseUntil) validDate(patch.leaseUntil);
    // An allowlist prevents untyped callers from changing ownership or importing identity.
    const data: Prisma.ManagedOutreachJobUpdateManyMutationInput = {};
    for (const key of ["status", "providerCampaignId", "sequenceFingerprint", "nextStep", "dueAt", "leaseUntil", "lastError"] as const) {
      if (patch[key] !== undefined) Object.assign(data, { [key]: patch[key] });
    }
    if (patch.status && patch.status !== "claimed") { data.leaseToken = null; data.leaseUntil = null; }
    const changed = await db.managedOutreachJob.updateMany({
      where: { id: required(jobId, "jobId"), workspaceId: required(workspaceId, "workspaceId"), status: "claimed",
        leaseToken: required(leaseToken, "leaseToken"), leaseUntil: { gt: now } },
      data,
    });
    if (changed.count !== 1) throw new ManagedOutreachLeaseError();
    const job = await db.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId } });
    if (!job) throw new ManagedOutreachLeaseError();
    return job;
  }

  async function markMutationUncertain(jobId: string, workspaceId: string, leaseToken: string, error: string, providerCampaignId?: string): Promise<ManagedOutreachJob> {
    // Even an expired worker can quarantine its own uncertain provider outcome.
    // Claimed and uncertain rows are never automatically reclaimed.
    const changed = await db.managedOutreachJob.updateMany({
      where: { id: required(jobId, "jobId"), workspaceId: required(workspaceId, "workspaceId"), status: "claimed", leaseToken: required(leaseToken, "leaseToken") },
      data: { status: "uncertain", leaseToken: null, leaseUntil: null, dueAt: null,
        lastError: required(error, "error").slice(0, 1000), ...(providerCampaignId ? { providerCampaignId: required(providerCampaignId, "providerCampaignId") } : {}) },
    });
    if (changed.count !== 1) throw new ManagedOutreachLeaseError();
    const job = await db.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId } });
    if (!job) throw new ManagedOutreachLeaseError();
    return job;
  }

  async function upsertEvent(input: ManagedOutreachEventInput): Promise<ManagedOutreachEvent> {
    const data = {
      id: required(input.id, "event id"), workspaceId: required(input.workspaceId, "workspaceId"),
      jobId: input.jobId == null ? null : required(input.jobId, "jobId"),
      type: required(input.type, "event type"), providerMessageId: input.providerMessageId == null ? null : required(input.providerMessageId, "providerMessageId"),
      occurredAt: validDate(input.occurredAt), dataJson: canonicalOutreachJson(input.data),
    };
    function verify(previous: ManagedOutreachEvent) {
      if (previous.workspaceId !== data.workspaceId || previous.jobId !== data.jobId || previous.type !== data.type
        || previous.providerMessageId !== data.providerMessageId || previous.occurredAt.getTime() !== data.occurredAt.getTime()
        || canonicalOutreachJson(JSON.parse(previous.dataJson)) !== data.dataJson) {
        throw new ManagedOutreachConflictError("An immutable outreach event ID was reused with different content.");
      }
      return previous;
    }
    const previous = await db.managedOutreachEvent.findUnique({ where: { id: data.id } });
    if (previous) return verify(previous);
    if (data.jobId && !await db.managedOutreachJob.findFirst({ where: { id: data.jobId, workspaceId: data.workspaceId } })) {
      throw new ManagedOutreachConflictError("The event job does not belong to this workspace.");
    }
    try { return await db.managedOutreachEvent.create({ data }); }
    catch (error) {
      if (!uniqueViolation(error)) throw error;
      const winner = await db.managedOutreachEvent.findUnique({ where: { id: data.id } });
      if (!winner) throw error;
      return verify(winner);
    }
  }

  return { importCandidateJob, getOwnerJobs, claimJob, markJobReady, updateWithLease, markMutationUncertain, upsertEvent };
}

export const { importCandidateJob, getOwnerJobs, claimJob, markJobReady, updateWithLease, markMutationUncertain, upsertEvent } = createManagedOutreachStore();

export type BudgetedJobClaim = { job: ClaimedManagedOutreachJob; reservationId: string } | { reason: "blocked" | "quota" | "lease" };

function dispatchBaseId(workspaceId: string, jobId: string, nextStep: number): string {
  return `dispatch:${createHash("sha256").update(JSON.stringify([workspaceId, jobId, nextStep])).digest("hex")}`;
}
function dispatchData(event: ManagedOutreachEvent): { nextStep: number; reservationId?: string; reason?: string; attempt?: number; step?: number } {
  const value: unknown = JSON.parse(event.dataJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagedOutreachConflictError("Invalid saved dispatch evidence.");
  return value as ReturnType<typeof dispatchData>;
}
function cancellationFor(events: ManagedOutreachEvent[], reservation: ManagedOutreachEvent, nextStep: number): ManagedOutreachEvent | undefined {
  return events.find(event => {
    if (event.type !== "dispatch_cancelled" || event.id !== `dispatch-cancelled:${reservation.id}`) return false;
    const data = dispatchData(event);
    return data.reservationId === reservation.id && data.nextStep === nextStep && data.reason === "pre-mutation-failure";
  });
}

/** Reserve quota and one job atomically; no network or provider work occurs inside the transaction. */
export async function claimBudgetAndJob(jobId: string, workspaceId: string, now: Date, leaseDurationMs = DEFAULT_LEASE_MS): Promise<BudgetedJobClaim> {
  required(jobId, "jobId"); required(workspaceId, "workspaceId"); leaseEnd(now, leaseDurationMs);
  return prisma.$transaction(async tx => {
    const lockScope = `managed-outreach:${workspaceId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))::text AS acquired`;
    const job = await tx.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId } });
    if (!job || job.status !== "ready" || !job.dueAt || job.dueAt.getTime() > now.getTime()) return { reason: "blocked" };
    if (job.leaseUntil && job.leaseUntil.getTime() > now.getTime()) return { reason: "lease" };
    if (job.nextStep === 1) {
      const companyCollision = await tx.managedOutreachJob.findFirst({ where: {
        workspaceId, id: { not: jobId }, companyDomain: job.companyDomain,
        OR: [{ status: { in: ["claimed", "staged", "queued", "completed", "uncertain"] } }, { nextStep: { gt: 1 } }],
      } });
      if (companyCollision) return { reason: "blocked" };
    }
    const baseId = dispatchBaseId(workspaceId, jobId, job.nextStep);
    const dispatchEvents = await tx.managedOutreachEvent.findMany({ where: { workspaceId, jobId,
      type: { in: [RESERVATION_TYPE, "dispatch_cancelled", "activation_attempted", "activation_queued"] } } });
    const priorAttempts = dispatchEvents.filter(event => event.type === RESERVATION_TYPE && dispatchData(event).nextStep === job.nextStep);
    // Only an explicit pre-mutation cancellation permits another reservation.
    // All attempts continue to consume the conservative rolling dispatch budget.
    if (priorAttempts.some(event => !cancellationFor(dispatchEvents, event, job.nextStep))) return { reason: "blocked" };
    for (let index = 1; index <= priorAttempts.length; index++) {
      const expected = index === 1 ? baseId : `${baseId}:attempt:${index}`;
      if (!priorAttempts.some(event => event.id === expected)) throw new ManagedOutreachConflictError("Dispatch attempt history is incomplete.");
    }
    if (dispatchEvents.some(event => ["activation_attempted", "activation_queued"].includes(event.type)
      && dispatchData(event).step === job.nextStep)) return { reason: "blocked" };
    const attempt = priorAttempts.length + 1;
    const reservationId = attempt === 1 ? baseId : `${baseId}:attempt:${attempt}`;
    const recent = await tx.managedOutreachEvent.findMany({
      where: { workspaceId, type: RESERVATION_TYPE, occurredAt: { gte: new Date(now.getTime() - DAY_MS) } },
      select: { dataJson: true, occurredAt: true },
    });
    let firstTouches = 0;
    let latestAt = -Infinity;
    for (const event of recent) {
      const reservation = JSON.parse(event.dataJson) as { nextStep?: unknown };
      if (!Number.isInteger(reservation?.nextStep) || (reservation.nextStep as number) < 1) throw new ManagedOutreachConflictError("A dispatch reservation has invalid step data; budget cannot be established.");
      if (reservation.nextStep === 1) firstTouches++;
      latestAt = Math.max(latestAt, event.occurredAt.getTime());
    }
    if (recent.length >= MANAGED_OUTREACH_DISPATCH_LIMITS.totalPer24Hours
      || (job.nextStep === 1 && firstTouches >= MANAGED_OUTREACH_DISPATCH_LIMITS.newRecipientsPer24Hours)
      || now.getTime() - latestAt < MANAGED_OUTREACH_DISPATCH_LIMITS.minimumSpacingMs) return { reason: "quota" };
    const claimed = await createManagedOutreachStore(tx).claimJob(jobId, workspaceId, now, leaseDurationMs);
    if (!claimed) return { reason: "lease" };
    await tx.managedOutreachEvent.create({ data: {
      id: reservationId, workspaceId, jobId, type: RESERVATION_TYPE, occurredAt: now,
      dataJson: canonicalOutreachJson({ nextStep: claimed.nextStep, kind: claimed.nextStep === 1 ? "new" : "followup", attempt }),
    } });
    return { job: claimed, reservationId };
  }, { maxWait: 10_000, timeout: 15_000 });
}

/** Release only a reservation proven to have failed before any provider activation was attempted. */
export async function cancelPreMutationReservation(jobId: string, workspaceId: string, leaseToken: string,
  reservationId: string, error: string, now = new Date()): Promise<ManagedOutreachJob> {
  required(jobId, "jobId"); required(workspaceId, "workspaceId"); required(leaseToken, "leaseToken");
  required(reservationId, "reservationId"); required(error, "error"); validDate(now);
  return prisma.$transaction(async tx => {
    const lockScope = `managed-outreach:${workspaceId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))::text AS acquired`;
    const job = await tx.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId, status: "claimed", leaseToken } });
    if (!job) throw new ManagedOutreachLeaseError();
    const events = await tx.managedOutreachEvent.findMany({ where: { workspaceId, jobId,
      type: { in: [RESERVATION_TYPE, "dispatch_cancelled", "activation_attempted", "activation_queued"] } } });
    const reservation = events.find(event => event.id === reservationId && event.type === RESERVATION_TYPE);
    if (!reservation || dispatchData(reservation).nextStep !== job.nextStep || cancellationFor(events, reservation, job.nextStep)) {
      throw new ManagedOutreachConflictError("An active reservation for this exact job step is required.");
    }
    if (events.some(event => {
      if (!["activation_attempted", "activation_queued"].includes(event.type)) return false;
      const data = dispatchData(event);
      return data.reservationId === reservationId || (data.step === job.nextStep && !data.reservationId);
    })) throw new ManagedOutreachConflictError("Provider activation may have been attempted; cancellation is forbidden.");
    await tx.managedOutreachEvent.create({ data: { id: `dispatch-cancelled:${reservationId}`, workspaceId, jobId,
      type: "dispatch_cancelled", occurredAt: now,
      dataJson: canonicalOutreachJson({ reservationId, nextStep: job.nextStep, reason: "pre-mutation-failure" }),
    } });
    const changed = await tx.managedOutreachJob.updateMany({ where: { id: jobId, workspaceId, status: "claimed", leaseToken, nextStep: job.nextStep },
      data: { status: job.providerCampaignId && job.sequenceFingerprint ? "staged" : "held", leaseToken: null, leaseUntil: null,
        lastError: error.slice(0, 1000) } });
    if (changed.count !== 1) throw new ManagedOutreachLeaseError();
    const updated = await tx.managedOutreachJob.findFirst({ where: { id: jobId, workspaceId } });
    if (!updated) throw new ManagedOutreachLeaseError();
    return updated;
  }, { maxWait: 10_000, timeout: 15_000 });
}
