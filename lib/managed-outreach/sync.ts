import { createHash } from "crypto";
import type { ManagedOutreachEvent, ManagedOutreachJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fingerprintCampaignSequence, type ManagedInstantlyCampaign, type ManagedInstantlyClient, type ManagedInstantlyEmail, type ManagedInstantlyLead } from "./instantly";
import { createManagedOutreachStore } from "./store";
import { normalizeEmail } from "./policy";

const DAY = 86_400_000;
const OVERLAP_MS = 2 * DAY;
const SYNC_FAILURE = "Provider reconciliation is incomplete; dispatch remains held.";
type Json = Record<string, unknown>;
type Step = { subject: string; body: string; delayDays: number };
export type SyncedOutreachEvent = {
  id: string; jobId: string | null; type: string; providerMessageId: string | null; occurredAt: string; data: Json;
};
export type ManagedOutreachSyncResult = {
  checkedAt: string;
  scannedJobs: number;
  complete: boolean;
  newEvents: SyncedOutreachEvent[];
  pendingResponses: SyncedOutreachEvent[];
  suppressionRetries: SyncedOutreachEvent[];
  failures: Array<{ jobId: string; code: string; message: string }>;
};
class SyncEvidenceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SyncEvidenceError"; }
}
function evidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SyncEvidenceError(code);
}
function objectJson(json: string): Json {
  const value: unknown = JSON.parse(json);
  evidence(value && typeof value === "object" && !Array.isArray(value), "invalid_saved_evidence");
  return value as Json;
}
function eventView(event: ManagedOutreachEvent): SyncedOutreachEvent {
  return { id: event.id, jobId: event.jobId, type: event.type, providerMessageId: event.providerMessageId,
    occurredAt: event.occurredAt.toISOString(), data: objectJson(event.dataJson) };
}
function parseTime(value: string, now: Date): number {
  const at = Date.parse(value);
  evidence(Number.isFinite(at) && at <= now.getTime() + 300_000, "invalid_provider_timestamp");
  return at;
}
function recipient(value?: string | null): string { return normalizeEmail(value || ""); }
function exactOutbound(email: ManagedInstantlyEmail, job: ManagedOutreachJob): boolean {
  return email.ue_type === 1 && email.campaign_id === job.providerCampaignId
    && recipient(email.eaccount) === job.senderEmail && recipient(email.from_address_email) === job.senderEmail
    && recipient(email.to_address_email_list) === job.email && recipient(email.lead) === job.email
    && !email.cc_address_email_list?.trim() && !email.bcc_address_email_list?.trim()
    && !!email.id && !!email.message_id && !!email.thread_id;
}
function exactIncoming(email: ManagedInstantlyEmail, job: ManagedOutreachJob, threads: Set<string>): boolean {
  return email.ue_type === 2 && email.campaign_id === job.providerCampaignId
    && recipient(email.eaccount) === job.senderEmail && recipient(email.from_address_email) === job.email
    && recipient(email.to_address_email_list) === job.senderEmail
    && (!email.lead || recipient(email.lead) === job.email)
    && !!email.id && !!email.message_id && !!email.thread_id && threads.has(email.thread_id);
}
function reservationId(job: ManagedOutreachJob): string {
  return `dispatch:${createHash("sha256").update(JSON.stringify([job.workspaceId, job.id, job.nextStep])).digest("hex")}`;
}
function parsedSteps(job: ManagedOutreachJob): Step[] {
  const steps: unknown = JSON.parse(job.stepsJson);
  evidence(Array.isArray(steps) && steps.length >= 1 && steps.length <= 5, "invalid_saved_sequence");
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as Partial<Step>;
    evidence(step && typeof step.subject === "string" && typeof step.body === "string" && step.body.trim()
      && Number.isInteger(step.delayDays) && Number(step.delayDays) >= (index === 0 ? 0 : 1)
      && Number(step.delayDays) <= 30, "invalid_saved_sequence");
  }
  return steps as Step[];
}

/** Provider step IDs are opaque; only the saved pending step and its reservation map a new receipt. */
function validateSentHistory(job: ManagedOutreachJob, events: ManagedOutreachEvent[], campaign: ManagedInstantlyCampaign,
  sent: ManagedInstantlyEmail[], leads: ManagedInstantlyLead[], now: Date) {
  const steps = parsedSteps(job);
  evidence(campaign.id === job.providerCampaignId && campaign.email_list?.length === 1
    && recipient(campaign.email_list[0]) === job.senderEmail && campaign.stop_on_reply === true
    && campaign.stop_on_auto_reply === true && campaign.stop_for_company === true,
  "campaign_identity_changed");
  evidence(job.sequenceFingerprint && fingerprintCampaignSequence(campaign) === job.sequenceFingerprint, "sequence_fingerprint_changed");
  evidence(leads.length === 1 && recipient(leads[0].email) === job.email && leads[0].campaign === job.providerCampaignId,
    "campaign_recipient_changed");
  const previous = events.filter(event => event.type === "sent").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  evidence(previous.length === job.nextStep - 1 && new Set(sent.map(email => email.id)).size === sent.length,
    "sent_history_incomplete");
  const byId = new Map(sent.map(email => [email.id, email]));
  const previousIds = new Set<string>();
  const rfcIds = new Set<string>();
  let previousAt = -Infinity;
  let threadId: string | null = null;
  const firstSubject = campaign.sequences![0].steps[0].variants[0].subject;
  for (const email of sent) {
    evidence(exactOutbound(email, job) && email.lead_id === leads[0].id && !email.body_fallback_reason
      && (email.body.text?.trim() || email.body.html?.trim()), "outbound_identity_mismatch");
    parseTime(email.timestamp_created, now); parseTime(email.timestamp_email, now);
    evidence(!rfcIds.has(email.message_id), "duplicate_outbound_message"); rfcIds.add(email.message_id);
  }
  for (let index = 0; index < previous.length; index++) {
    const saved = previous[index]; const data = objectJson(saved.dataJson);
    const email = saved.providerMessageId ? byId.get(saved.providerMessageId) : undefined;
    evidence(email && !previousIds.has(email.id) && saved.id === `instantly:sent:${email.id}`
      && data.provider === "instantly" && data.source === "provider-email" && data.step === index + 1
      && data.campaignId === job.providerCampaignId && data.senderEmail === job.senderEmail && data.recipientEmail === job.email
      && data.experimentId === job.experimentId && data.variant === job.variant && data.threadId === email.thread_id
      && saved.occurredAt.getTime() === Date.parse(email.timestamp_email)
      && (data.rfcMessageId === undefined || data.rfcMessageId === email.message_id), "sent_history_incomplete");
    const at = parseTime(email.timestamp_email, now);
    evidence(at > previousAt && (!threadId || email.thread_id === threadId), "sent_thread_or_chronology_changed");
    evidence(index === 0 ? email.subject === firstSubject : email.subject.replace(/^(?:re:\s*)+/i, "") === firstSubject,
      "sent_subject_changed");
    previousIds.add(email.id); previousAt = at; threadId = email.thread_id!;
  }
  const fresh = sent.filter(email => !previousIds.has(email.id));
  evidence(fresh.length <= 1, "ambiguous_outbound_progress");
  if (!fresh.length) return { steps, fresh: null };
  const staged = events.find(event => event.id === `managed:staged:${job.id}:${job.nextStep}` && event.type === "staged");
  const baseReservationId = reservationId(job);
  const reservations = events.filter(event => {
    if (event.type !== "dispatch_reserved" || objectJson(event.dataJson).nextStep !== job.nextStep) return false;
    const expectedId = event.id === baseReservationId || /^\d+$/.test(event.id.startsWith(`${baseReservationId}:attempt:`) ? event.id.slice(`${baseReservationId}:attempt:`.length) : "");
    evidence(expectedId, "invalid_dispatch_reservation");
    return !events.some(cancellation => {
      if (cancellation.id !== `dispatch-cancelled:${event.id}` || cancellation.type !== "dispatch_cancelled") return false;
      const data = objectJson(cancellation.dataJson);
      return data.reservationId === event.id && data.nextStep === job.nextStep && data.reason === "pre-mutation-failure";
    });
  });
  evidence(reservations.length <= 1, "ambiguous_dispatch_reservation");
  const reservation = reservations[0];
  evidence((job.status === "queued" || job.status === "uncertain") && staged && reservation, "unreserved_outbound_progress");
  const stage = objectJson(staged.dataJson); const reserved = objectJson(reservation.dataJson);
  evidence(stage.provider === "instantly" && stage.campaignId === job.providerCampaignId && stage.step === job.nextStep
    && stage.experimentId === job.experimentId && stage.variant === job.variant
    && stage.sequenceFingerprint === job.sequenceFingerprint && reserved.nextStep === job.nextStep
    && campaign.sequences![0].steps.length === job.nextStep && job.nextStep <= steps.length,
  "staged_sequence_evidence_missing");
  const email = fresh[0]; const at = parseTime(email.timestamp_email, now);
  evidence(at > previousAt && at >= reservation.occurredAt.getTime() - 60_000
    && (!threadId || email.thread_id === threadId), "sent_thread_or_chronology_changed");
  evidence(job.nextStep === 1 ? email.subject === firstSubject : email.subject.replace(/^(?:re:\s*)+/i, "") === firstSubject,
    "sent_subject_changed");
  return { steps, fresh: email };
}

function inboundData(email: ManagedInstantlyEmail, job: ManagedOutreachJob): Json {
  const text = email.body.text ?? (email.body.html || "").replace(/<[^>]*>/g, " ");
  return { provider: "instantly", source: "provider-email", campaignId: job.providerCampaignId,
    threadId: email.thread_id, senderEmail: job.senderEmail, recipientEmail: job.email,
    fromEmail: job.email, toEmail: job.senderEmail, rfcMessageId: email.message_id,
    providerIngestedAt: email.timestamp_created, subject: email.subject.slice(0, 500), bodyExcerpt: text.slice(0, 2000),
    contentTrust: "untrusted_email", classification: "pending", alertStatus: "pending",
    bodyAvailability: email.body_fallback_reason || "available", isAutoReply: email.is_auto_reply ?? null,
    experimentId: job.experimentId, variant: job.variant };
}

async function workspaceLock(tx: Prisma.TransactionClient, workspaceId: string) {
  const scope = `managed-outreach:${workspaceId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))::text AS acquired`;
}

/** Only provider facts are reconciled here. Human reply classification and owner alerts happen elsewhere. */
export async function syncManagedOutreach(workspaceId: string, client: ManagedInstantlyClient,
  options: { now?: Date } = {}): Promise<ManagedOutreachSyncResult> {
  if (!workspaceId?.trim()) throw new TypeError("An owner workspace is required.");
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("A valid sync timestamp is required.");
  const result: ManagedOutreachSyncResult = { checkedAt: now.toISOString(), scannedJobs: 0, complete: true, newEvents: [], pendingResponses: [], suppressionRetries: [], failures: [] };
  const jobs = await prisma.managedOutreachJob.findMany({ where: { workspaceId, providerCampaignId: { not: null } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const fail = (jobId: string, code: string) => {
    result.complete = false;
    if (!result.failures.some(item => item.jobId === jobId && item.code === code)) result.failures.push({ jobId, code, message: SYNC_FAILURE });
  };

  async function scan(job: ManagedOutreachJob) {
    result.scannedJobs++;
    let shouldPause = false;
    try {
      const saved = await prisma.managedOutreachEvent.findMany({ where: { workspaceId, jobId: job.id }, orderBy: { occurredAt: "asc" } });
      const checkpoints = saved.filter(event => event.type === "scan_checkpoint");
      const latestCheckpoint = checkpoints[checkpoints.length - 1];
      let minCreatedAt: string | undefined;
      if (latestCheckpoint) {
        const checkpoint = objectJson(latestCheckpoint.dataJson);
        evidence(checkpoint.complete === true && checkpoint.campaignId === job.providerCampaignId && typeof checkpoint.scannedThrough === "string",
          "invalid_saved_checkpoint");
        const through = parseTime(checkpoint.scannedThrough, now);
        minCreatedAt = new Date(through - OVERLAP_MS).toISOString();
      }
      // Full sent history is required every time. Incoming history overlaps the last complete ingestion scan by 48 hours.
      const reads = await Promise.allSettled([
        client.getCampaign(job.providerCampaignId!),
        client.listEmails({ campaignId: job.providerCampaignId!, emailType: "sent", maxCreatedAt: now.toISOString() }),
        client.listEmails({ campaignId: job.providerCampaignId!, emailType: "received", minCreatedAt, maxCreatedAt: now.toISOString() }),
        client.listCampaignLeads(job.providerCampaignId!),
      ]);
      const campaign = reads[0].status === "fulfilled" ? reads[0].value : null;
      const sent = reads[1].status === "fulfilled" ? reads[1].value : null;
      const incoming = reads[2].status === "fulfilled" ? reads[2].value : null;
      const leads = reads[3].status === "fulfilled" ? reads[3].value : null;
      const completeReads = reads.every(read => read.status === "fulfilled");

      const effects = await prisma.$transaction(async tx => {
        await workspaceLock(tx, workspaceId);
        const current = await tx.managedOutreachJob.findFirst({ where: { id: job.id, workspaceId } });
        evidence(current && current.providerCampaignId === job.providerCampaignId, "job_changed_during_scan");
        const events = await tx.managedOutreachEvent.findMany({ where: { workspaceId, jobId: current.id }, orderBy: { occurredAt: "asc" } });
        const knownIds = new Set(events.map(event => event.id));
        const threads = new Set<string>();
        for (const event of events.filter(item => item.type === "sent")) {
          const data = objectJson(event.dataJson);
          if (data.provider === "instantly" && data.campaignId === current.providerCampaignId
            && data.senderEmail === current.senderEmail && data.recipientEmail === current.email && typeof data.threadId === "string") threads.add(data.threadId);
        }
        for (const email of sent || []) if (exactOutbound(email, current)) threads.add(email.thread_id!);
        const matchedIncoming: ManagedInstantlyEmail[] = [];
        const problems: string[] = completeReads ? [] : ["provider_scan_incomplete"];
        const seenIncoming = new Set<string>();
        for (const email of incoming || []) {
          try {
            evidence(exactIncoming(email, current, threads) && !seenIncoming.has(email.id), "incoming_identity_mismatch");
            parseTime(email.timestamp_email, now); parseTime(email.timestamp_created, now);
            seenIncoming.add(email.id); matchedIncoming.push(email);
          } catch { problems.push("incoming_identity_mismatch"); }
        }
        const exactLead = leads?.length === 1 && recipient(leads[0].email) === current.email && leads[0].campaign === current.providerCampaignId ? leads[0] : null;
        const unsubscribed = exactLead?.status === -2;
        const bounced = exactLead?.status === -1;
        const reportedReply = !!exactLead && (exactLead.email_reply_count > 0 || !!exactLead.timestamp_last_reply);
        const hasSavedReply = events.some(event => event.type === "incoming_received");
        // Staging persists its intended fingerprint before the provider mutation.
        // An active worker may legitimately be between those writes. Still stop on
        // incoming/negative state, but leave progress reconciliation for its next scan.
        const activeWorker = current.status === "claimed" && !!current.leaseUntil && current.leaseUntil.getTime() > now.getTime();
        let progress: ReturnType<typeof validateSentHistory> | null = null;
        if (completeReads && !activeWorker) {
          try { progress = validateSentHistory(current, events, campaign!, sent!, leads!, now); }
          catch (error) { problems.push(error instanceof SyncEvidenceError ? error.code : "invalid_provider_evidence"); }
        }
        const store = createManagedOutreachStore(tx);
        const freshEvents: SyncedOutreachEvent[] = [];
        if (progress?.fresh) {
          const email = progress.fresh;
          const event = await store.upsertEvent({ id: `instantly:sent:${email.id}`, workspaceId, jobId: current.id, type: "sent",
            providerMessageId: email.id, occurredAt: new Date(email.timestamp_email), data: {
              provider: "instantly", campaignId: current.providerCampaignId, threadId: email.thread_id,
              senderEmail: current.senderEmail, recipientEmail: current.email, step: current.nextStep,
              experimentId: current.experimentId, variant: current.variant, source: "provider-email", rfcMessageId: email.message_id,
            } });
          const nextStep = current.nextStep + 1;
          const next = progress.steps[nextStep - 1];
          const changed = await tx.managedOutreachJob.updateMany({
            where: { id: current.id, workspaceId, providerCampaignId: current.providerCampaignId, nextStep: current.nextStep,
              status: current.status, sequenceFingerprint: current.sequenceFingerprint, updatedAt: current.updatedAt },
            data: { nextStep, status: next ? "held" : "completed", dueAt: next ? new Date(Date.parse(email.timestamp_email) + next.delayDays * DAY) : null,
              leaseToken: null, leaseUntil: null, lastError: null },
          });
          evidence(changed.count === 1, "job_changed_during_scan");
          if (!knownIds.has(event.id)) freshEvents.push(eventView(event));
        }
        for (const email of matchedIncoming) {
          const event = await store.upsertEvent({ id: `instantly:incoming:${email.id}`, workspaceId, jobId: current.id,
            type: "incoming_received", providerMessageId: email.id, occurredAt: new Date(email.timestamp_email), data: inboundData(email, current) });
          if (!knownIds.has(event.id)) freshEvents.push(eventView(event));
        }
        // Provider states stop dispatch but do not masquerade as dated bounce, unsubscribe, or booking events.
        const stop = matchedIncoming.length > 0 || hasSavedReply || reportedReply || bounced;
        const pause = stop || unsubscribed || problems.length > 0;
        if (pause) {
          await tx.managedOutreachJob.updateMany({ where: { id: current.id, workspaceId }, data: {
            status: unsubscribed || current.status === "suppressed" ? "suppressed" : stop || current.status === "stopped" ? "stopped" : "uncertain",
            dueAt: null, leaseToken: null, leaseUntil: null,
            lastError: unsubscribed ? "Provider currently marks the exact recipient unsubscribed."
              : bounced ? "Provider currently marks the exact recipient bounced."
              : stop ? "Incoming reply requires human review before further outreach." : SYNC_FAILURE,
          } });
        }
        return { freshEvents, problems: Array.from(new Set(problems)), pause, suppress: unsubscribed, deferred: activeWorker };
      }, { maxWait: 10_000, timeout: 15_000 });
      result.newEvents.push(...effects.freshEvents);
      for (const code of effects.problems) fail(job.id, code);
      if (effects.deferred) fail(job.id, "dispatch_in_progress");
      shouldPause = effects.pause;
      if (shouldPause) {
        try { await client.pauseCampaign(job.providerCampaignId!); }
        catch { fail(job.id, "provider_pause_unconfirmed"); }
      }
      if (effects.suppress) {
        try {
          const suppression = await client.suppressEmail(job.email);
          evidence(!suppression.is_domain && recipient(suppression.bl_value) === job.email, "provider_suppression_unconfirmed");
        } catch { fail(job.id, "provider_suppression_unconfirmed"); }
      }
      if (!result.failures.some(failure => failure.jobId === job.id)) {
        await createManagedOutreachStore().upsertEvent({
          id: `instantly:scan:${createHash("sha256").update(JSON.stringify([workspaceId, job.id, job.providerCampaignId, now.toISOString()])).digest("hex")}`,
          workspaceId, jobId: job.id, type: "scan_checkpoint", occurredAt: now,
          data: { provider: "instantly", campaignId: job.providerCampaignId, scannedThrough: now.toISOString(), overlapHours: 48, complete: true },
        });
      }
    } catch (error) {
      fail(job.id, error instanceof SyncEvidenceError ? error.code : "reconciliation_failed");
      // A failed receipt transaction cannot leave a job eligible for another dispatch.
      try { await prisma.managedOutreachJob.updateMany({ where: { id: job.id, workspaceId, status: { notIn: ["stopped", "suppressed"] } },
        data: { status: "uncertain", dueAt: null, leaseToken: null, leaseUntil: null, lastError: SYNC_FAILURE } }); } catch { /* Report the isolated failure without exposing raw database errors. */ }
      if (!shouldPause) try { await client.pauseCampaign(job.providerCampaignId!); } catch { fail(job.id, "provider_pause_unconfirmed"); }
    }
  }

  // Bound provider concurrency while isolating a failure in one campaign from the other jobs.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (cursor < jobs.length) { const job = jobs[cursor++]; await scan(job); }
  }));
  const reviewEvents = await prisma.managedOutreachEvent.findMany({ where: { workspaceId, type: { in: ["incoming_received", "reply_classified", "unsubscribed"] } }, orderBy: { occurredAt: "asc" } });
  const classifications = reviewEvents.filter(event => event.type === "reply_classified");
  for (const incoming of reviewEvents.filter(event => event.type === "incoming_received")) {
    try {
      const incomingView = eventView(incoming);
      const classified = classifications.some(event => {
        if (event.jobId !== incoming.jobId || event.providerMessageId !== incoming.providerMessageId
          || event.id !== `instantly:classification:${incoming.providerMessageId}`) return false;
        try {
          const data = objectJson(event.dataJson);
          const linked = data.source === "owner-classification" && data.incomingEventId === incoming.id
            && data.incomingEmailId === incoming.providerMessageId;
          if (linked && data.classification === "unsubscribe" && data.explicitOptOut === true) {
            const confirmed = reviewEvents.some(suppression => {
              if (suppression.type !== "unsubscribed" || suppression.id !== `instantly:suppressed:${incoming.providerMessageId}`
                || suppression.jobId !== incoming.jobId || suppression.providerMessageId !== incoming.providerMessageId) return false;
              try {
                const confirmation = objectJson(suppression.dataJson);
                return confirmation.incomingEventId === incoming.id && confirmation.classificationEventId === event.id
                  && confirmation.fromEmail === data.fromEmail && confirmation.suppressionStatus === "confirmed"
                  && typeof confirmation.providerSuppressionId === "string" && !!confirmation.providerSuppressionId;
              } catch { fail(incoming.jobId || "unlinked-reply", "invalid_saved_suppression_evidence"); return false; }
            });
            if (!confirmed) result.suppressionRetries.push(eventView(event));
          }
          return linked;
        } catch { fail(incoming.jobId || "unlinked-reply", "invalid_saved_reply_evidence"); return false; }
      });
      if (!classified) result.pendingResponses.push(incomingView);
    } catch { fail(incoming.jobId || "unlinked-reply", "invalid_saved_reply_evidence"); }
  }
  result.newEvents.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  result.failures.sort((a, b) => a.jobId.localeCompare(b.jobId) || a.code.localeCompare(b.code));
  return result;
}
