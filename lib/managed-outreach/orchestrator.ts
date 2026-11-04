import { createHash, randomUUID } from "node:crypto";
import type { ManagedOutreachEvent, ManagedOutreachJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getManagedInstantlyClientForUserId } from "./client";
import { evaluateCandidate, evaluateSendPolicy, normalizeDomain, normalizeEmail, sameCorporateDomain,
  type Candidate, type FooterConfig, type MailboxReadiness } from "./policy";
import { renderManagedEmailContent } from "./email-content";
import { fingerprintCampaignSequence, planInstantlyFollowup, ManagedInstantlyError,
  type ManagedInstantlyCampaign } from "./instantly";
import * as store from "./store";

export class ManagedDispatchError extends Error {
  constructor(public code: string, message: string, public status = 409, public reasons: string[] = []) {
    super(message); this.name = "ManagedDispatchError";
  }
}

export const RECIPIENT_TIMEZONES = ["America/New_York", "America/Detroit", "America/Chicago", "America/Denver", "America/Boise", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu"] as const;
export type ManagedCandidate = Candidate & { recipientTimezone: typeof RECIPIENT_TIMEZONES[number] };
export type ManagedStep = { subject: string; body: string; delayDays: number };
export type AttioClearance = { clear: boolean; complete: boolean; checkedAt: string; source: "connected_attio" | "attio_api";
  checkedEmail: string; checkedCompanyDomain: string; evidence: string[] };
export type BookingClearance = { clear: boolean; complete: boolean; checkedAt: string; checkedEmail: string; source: string; evidence: string[] };
export type ManagedDispatchInput = { action: "stage" | "activate"; jobId: string; mailbox: MailboxReadiness;
  attioClearance: AttioClearance; bookingClearance: BookingClearance };
export type ManagedDispatchConfig = { enabled: boolean; senderEmail: string; footer: FooterConfig };
type Client = NonNullable<Awaited<ReturnType<typeof getManagedInstantlyClientForUserId>>>;
type ClaimedJob = store.ClaimedManagedOutreachJob;

export function readManagedDispatchConfig(): ManagedDispatchConfig {
  return {
    enabled: process.env.MANAGED_OUTREACH_SEND_ENABLED === "true",
    senderEmail: normalizeEmail(process.env.MANAGED_OUTREACH_SENDER_EMAIL || ""),
    footer: {
      businessPostalAddress: process.env.MANAGED_OUTREACH_POSTAL_ADDRESS,
      postalAddressApproved: process.env.MANAGED_OUTREACH_POSTAL_APPROVED === "true",
      unsubscribeText: process.env.MANAGED_OUTREACH_UNSUBSCRIBE_TEXT,
      replyOptOutEnabled: process.env.MANAGED_OUTREACH_REPLY_OPTOUT_ENABLED === "true",
    },
  };
}

function block(code: string, message: string, reasons: string[] = []): never { throw new ManagedDispatchError(code, message, 409, reasons); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagedDispatchError("invalid_input", "A JSON object is required.", 400);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ManagedDispatchError("invalid_input", `${field} is missing or invalid.`, 400);
  return value.trim();
}

export function parseManagedImport(value: unknown, config = readManagedDispatchConfig()) {
  const input = object(value); const candidate = object(input.candidate) as unknown as ManagedCandidate;
  if (!RECIPIENT_TIMEZONES.includes(candidate.recipientTimezone)) throw new ManagedDispatchError("invalid_timezone", "A recorded US recipient timezone is required.", 400);
  let eligibility;
  try { eligibility = evaluateCandidate(candidate); }
  catch { throw new ManagedDispatchError("invalid_candidate", "Candidate evidence is invalid.", 400); }
  if (!eligibility.eligible) throw new ManagedDispatchError("ineligible", "Candidate is held by the audience policy.", 409, eligibility.reasons);
  const steps = parseSteps(input.steps);
  const senderEmail = normalizeEmail(text(input.senderEmail, "senderEmail", 254));
  if (!config.senderEmail || senderEmail !== config.senderEmail) block("sender_not_selected", "Import requires the exact configured sending mailbox.");
  const variant = text(input.variant, "variant", 20);
  if (!["A", "B"].includes(variant)) throw new ManagedDispatchError("invalid_variant", "Subject test variant must be A or B.", 400);
  return { externalId: text(input.externalId, "externalId"), candidate, steps,
    experimentId: text(input.experimentId, "experimentId"), variant, senderEmail };
}

function parseSteps(value: unknown): ManagedStep[] {
  if (!Array.isArray(value) || value.length !== 5) throw new ManagedDispatchError("invalid_steps", "Exactly five prepared emails are required.", 400);
  const first = text(object(value[0]).subject, "initial subject", 150);
  if (/[\r\n]/.test(first)) throw new ManagedDispatchError("invalid_steps", "Subjects cannot contain line breaks.", 400);
  return value.map((raw, index) => {
    const item = object(raw); const subject = typeof item.subject === "string" ? item.subject.trim() : "";
    const body = text(item.body, "email body", 10_000);
    if ((subject && subject !== first) || body.length < 60) throw new ManagedDispatchError("invalid_steps", "Followups must retain the initial subject and contain finished copy.", 400);
    if (!body.includes("{{meeting_days}}") || /{{(?!meeting_days}})/.test(body)) throw new ManagedDispatchError("invalid_steps", "Every email needs the {{meeting_days}} placeholder; unresolved placeholders are held.", 400);
    const delayDays = item.delayDays;
    if (!Number.isInteger(delayDays) || (index === 0 ? delayDays !== 0 : (delayDays as number) < 2 || (delayDays as number) > 14)) {
      throw new ManagedDispatchError("invalid_steps", "Use a zero-day first step and 2–14 days between followups.", 400);
    }
    return { subject: first, body, delayDays: delayDays as number };
  });
}

function localParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
}
export function isRecipientBusinessWindow(now: Date, timezone: string): boolean {
  if (!RECIPIENT_TIMEZONES.includes(timezone as ManagedCandidate["recipientTimezone"])) return false;
  const local = localParts(now, timezone);
  const minutes = local.hour * 60 + local.minute;
  // Instantly queues work asynchronously; reserve twenty minutes before the 3pm schedule end.
  return !["Sat", "Sun"].includes(local.weekday) && minutes >= 9 * 60 && minutes < 14 * 60 + 40;
}
export function renderManagedBody(template: string, now: Date, timezone: string, footer: FooterConfig) {
  const local = localParts(now, timezone); const day = new Date(`${local.date}T12:00:00Z`);
  const choices: string[] = [];
  while (choices.length < 2) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (![0, 6].includes(day.getUTCDay())) choices.push(new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(day));
  }
  const rendered = renderManagedEmailContent(template.replace(/{{meeting_days}}/g, choices.join(" or ")), footer);
  return { ...rendered, localDate: local.date,
    bodyHash: createHash("sha256").update(JSON.stringify([rendered.body, rendered.html])).digest("hex") };
}

export function validateClearances(input: Pick<ManagedDispatchInput, "attioClearance" | "bookingClearance">, candidate: Candidate, now: Date, maxAge = 60_000) {
  const validTime = (value: string) => { const at = Date.parse(value); return Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= maxAge; };
  const evidence = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(v => typeof v === "string" && !!v.trim() && v.length <= 1000);
  const crm = input.attioClearance;
  if (!crm || crm.clear !== true || crm.complete !== true || !["connected_attio", "attio_api"].includes(crm.source)
    || normalizeEmail(crm.checkedEmail || "") !== normalizeEmail(candidate.email)
    || normalizeDomain(crm.checkedCompanyDomain || "") !== normalizeDomain(candidate.companyDomain)
    || !validTime(crm.checkedAt) || !evidence(crm.evidence)) block("crm_not_clear", "Fresh, complete Attio exclusions for this exact recipient and company are required.");
  const booking = input.bookingClearance;
  if (!booking || booking.clear !== true || booking.complete !== true || typeof booking.source !== "string" || !booking.source.trim()
    || normalizeEmail(booking.checkedEmail || "") !== normalizeEmail(candidate.email)
    || !validTime(booking.checkedAt) || !evidence(booking.evidence)) block("booking_not_clear", "Fresh booking exclusion evidence for this exact recipient is required.");
  // The provider guard receives the oldest external check, not a fabricated new timestamp.
  return new Date(Math.min(Date.parse(crm.checkedAt), Date.parse(booking.checkedAt))).toISOString();
}

function parseJob(job: ManagedOutreachJob) {
  let candidate: ManagedCandidate; let steps: ManagedStep[];
  try { candidate = JSON.parse(job.candidateJson); steps = parseSteps(JSON.parse(job.stepsJson)); }
  catch { block("invalid_saved_job", "Saved campaign evidence or copy is invalid; review it before sending."); }
  if (normalizeEmail(candidate.email || "") !== job.email || normalizeDomain(candidate.companyDomain || "") !== job.companyDomain
    || !RECIPIENT_TIMEZONES.includes(candidate.recipientTimezone)) block("invalid_saved_job", "Saved campaign identity or timezone does not match the job.");
  return { candidate, steps };
}
function jobResult(job: Pick<ManagedOutreachJob, "id" | "status" | "providerCampaignId" | "nextStep">) {
  return { jobId: job.id, status: job.status, providerCampaignId: job.providerCampaignId, nextStep: job.nextStep, sendingConfirmed: false };
}
const STOP_EVENTS = ["incoming_received", "replied", "positive_reply", "meeting_request", "demo_booked", "unsubscribed", "bounced", "complained", "unsubscribe", "delivery_failure"];
function eventData(event: ManagedOutreachEvent): Record<string, unknown> {
  try { return object(JSON.parse(event.dataJson)); } catch { block("invalid_event", "Saved campaign evidence is invalid."); }
}
function priorProof(job: ManagedOutreachJob, events: ManagedOutreachEvent[]) {
  const sent = events.filter(event => event.type === "sent").sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (sent.length !== job.nextStep - 1 || !job.providerCampaignId || !job.sequenceFingerprint) block("missing_send_proof", "All earlier steps need immutable provider send receipts before a followup.");
  let thread = "";
  sent.forEach((event, index) => {
    const data = eventData(event);
    if (!event.providerMessageId || data.provider !== "instantly" || data.campaignId !== job.providerCampaignId
      || data.senderEmail !== job.senderEmail || data.recipientEmail !== job.email || data.step !== index + 1
      || typeof data.threadId !== "string" || !data.threadId || (thread && thread !== data.threadId)) block("missing_send_proof", "Prior send receipts do not match this campaign, recipient, sender and thread.");
    thread = data.threadId as string;
  });
  return { expectedRecipientEmail: job.email, expectedSenderEmail: job.senderEmail, expectedThreadId: thread,
    priorSentEmailIds: sent.map(event => event.providerMessageId!), expectedSequenceFingerprint: job.sequenceFingerprint };
}

type Dependencies = {
  now?: () => Date;
  config?: ManagedDispatchConfig;
  client?: Client;
  jobs?: (workspaceId: string) => Promise<ManagedOutreachJob[]>;
  events?: (workspaceId: string, jobId: string) => Promise<ManagedOutreachEvent[]>;
  store?: Pick<typeof store, "markJobReady" | "claimJob" | "claimBudgetAndJob" | "cancelPreMutationReservation" | "updateWithLease" | "markMutationUncertain" | "upsertEvent">;
};

/** Two phases: stage paused content, then recheck external systems and activate. */
export async function dispatchManagedJob(owner: { userId: string; workspaceId: string }, input: ManagedDispatchInput, dependencies: Dependencies = {}) {
  const now = dependencies.now || (() => new Date()); const config = dependencies.config || readManagedDispatchConfig();
  const persistence = dependencies.store || store;
  if (!input || !["stage", "activate"].includes(input.action) || typeof input.jobId !== "string") throw new ManagedDispatchError("invalid_input", "A stage or activate action and job ID are required.", 400);
  if (input.action === "activate" && !config.enabled) block("sending_disabled", "Managed sending is disabled in server configuration.");
  const jobs = await (dependencies.jobs || store.getOwnerJobs)(owner.workspaceId);
  const job = jobs.find(value => value.id === input.jobId);
  if (!job) throw new ManagedDispatchError("not_found", "Campaign job was not found.", 404);
  if (["queued", "completed"].includes(job.status)) return jobResult(job);
  if (["uncertain", "claimed", "stopped", "suppressed"].includes(job.status)) block("job_held", "This job is held or already in progress; no provider action was repeated.");
  if (!Number.isInteger(job.nextStep) || job.nextStep < 1 || job.nextStep > 5) block("invalid_step", "The prepared sequence has no eligible next step.");
  if (job.dueAt && job.dueAt > now()) block("not_due", "The next email is not due.");
  const { candidate, steps } = parseJob(job);
  if (!config.senderEmail || job.senderEmail !== config.senderEmail || input.mailbox?.email !== config.senderEmail) block("sender_not_selected", "The exact configured sending mailbox is required.");
  let policy;
  try { policy = evaluateSendPolicy({ candidate, mailbox: input.mailbox, footer: config.footer, now: now() }); }
  catch { block("invalid_evidence", "Mailbox or eligibility evidence is invalid."); }
  if (!policy.eligible) block("policy_hold", "This job is held by the sending policy.", policy.reasons);
  validateClearances(input, candidate, now(), input.action === "stage" ? 300_000 : 60_000);
  if (!isRecipientBusinessWindow(now(), candidate.recipientTimezone)) block("outside_business_hours", "Activate only weekdays from 9am until 2:40pm in the recipient's timezone, leaving a delivery buffer before 3pm.");
  const aliases = [candidate.companyDomain, ...(candidate.corporateDomains || [])];
  if (job.nextStep === 1 && jobs.some(other => other.id !== job.id
    && (["claimed", "staged", "queued", "completed", "uncertain"].includes(other.status) || other.nextStep > 1)
    && aliases.some(domain => sameCorporateDomain(domain, other.companyDomain)))) block("company_already_contacted", "Another recipient at this company already has campaign activity.");
  const events = await (dependencies.events || ((workspaceId, jobId) => prisma.managedOutreachEvent.findMany({ where: { workspaceId, jobId }, orderBy: { occurredAt: "asc" } })))(owner.workspaceId, job.id);
  if (events.some(event => STOP_EVENTS.includes(event.type))) block("stop_event", "A reply, opt-out, bounce, complaint or booked meeting holds this prospect.");
  const client = dependencies.client || await getManagedInstantlyClientForUserId(owner.userId, { timeoutMs: 5_000, maxPages: 10 });
  if (!client) block("provider_unavailable", "The saved sending connection is unavailable.");
  const accounts = await client.listAccounts();
  const account = accounts.find(value => value.email.toLowerCase() === job.senderEmail);
  if (!account || account.status !== 1 || account.setup_pending || account.warmup_status !== 1
    || typeof account.daily_limit !== "number" || account.daily_limit < 1) block("mailbox_unavailable", "The selected mailbox is not currently connected and ready.");
  const campaigns = await client.listAccountCampaigns(job.senderEmail);
  if (campaigns.some(campaign => campaign.campaign_id !== job.providerCampaignId && campaign.status === 1)) block("sender_busy", "Another active campaign is using the selected mailbox, directly or through account tags.");
  if (await client.isSuppressed(job.email)) block("suppressed", "The recipient is on the provider suppression list.");
  if ((await client.listInboundEmails({ leadEmail: job.email })).length) block("incoming_reply", "Incoming mail from this recipient requires review before any further send.");
  if (job.nextStep === 1 && (await client.listEmails({ leadEmail: job.email })).length) block("existing_contact", "The provider already has message history for this recipient.");

  const rendered = renderManagedBody(steps[job.nextStep - 1].body, now(), candidate.recipientTimezone, config.footer);
  const stagedEvent = events.find(event => event.id === `managed:staged:${job.id}:${job.nextStep}`);
  if (input.action === "activate") {
    if (!stagedEvent || !job.providerCampaignId || !job.sequenceFingerprint) block("not_staged", "Prepare and persist the paused email before activation.");
    const staged = eventData(stagedEvent);
    if (staged.localDate !== rendered.localDate || staged.bodyHash !== rendered.bodyHash) block("stale_copy", "The staged meeting-day copy needs review before activation on a different day.");
    // No new timestamp is invented after potentially slow provider inventory checks.
    validateClearances(input, candidate, now());
  } else if (stagedEvent) {
    const staged = eventData(stagedEvent);
    if (staged.localDate !== rendered.localDate || staged.bodyHash !== rendered.bodyHash) block("stale_copy", "The already staged copy needs review; it was not silently changed.");
    return jobResult(job);
  }

  await persistence.markJobReady(job.id, owner.workspaceId, now());
  let claimed: ClaimedJob;
  let reservationId: string | undefined;
  if (input.action === "activate") {
    const budget = await persistence.claimBudgetAndJob(job.id, owner.workspaceId, now());
    if ("reason" in budget) block(`dispatch_${budget.reason}`, "Dispatch is held by the daily budget, spacing, company exclusion or another worker.");
    claimed = budget.job;
    reservationId = budget.reservationId;
  } else {
    const lease = await persistence.claimJob(job.id, owner.workspaceId, now());
    if (!lease) block("dispatch_lease", "Another worker claimed this job; no provider action was repeated.");
    claimed = lease;
  }
  let campaignId = claimed.providerCampaignId || undefined;
  let mutationStarted = false;
  let phase = "preflight_receipt";
  let uploadCounts: Record<string, number> | undefined;
  try {
    await persistence.upsertEvent({ id: `managed:preflight:${job.id}:${job.nextStep}:${randomUUID()}`, workspaceId: owner.workspaceId, jobId: job.id,
      type: "preflight_checked", occurredAt: now(), data: { action: input.action, step: job.nextStep, experimentId: job.experimentId, variant: job.variant,
        attio: input.attioClearance, booking: input.bookingClearance, mailbox: input.mailbox, policyVersion: policy.policyVersion } });
    if (input.action === "stage") {
      let campaign: ManagedInstantlyCampaign;
      if (job.nextStep === 1) {
        if (campaignId) {
          const authorization = events.find(event => event.id === `managed:stage-resume:${job.id}:1` && event.type === "stage_resume_authorized");
          const proof = authorization ? eventData(authorization) : null;
          if (!proof || proof.campaignId !== campaignId || proof.sequenceFingerprint !== job.sequenceFingerprint
            || proof.bodyHash !== rendered.bodyHash || proof.localDate !== rendered.localDate) block("stage_reconciliation_required", "A provider campaign already exists without a complete stage receipt; review it before retrying.");
          phase = "resume_existing_empty_campaign";
          campaign = await client.getCampaign(campaignId);
          if (campaign.id !== campaignId || campaign.name !== `Gather managed ${job.id} ${job.variant}` || campaign.status !== 2
            || campaign.email_list?.length !== 1 || campaign.email_list[0].toLowerCase() !== job.senderEmail || (campaign.email_tag_list?.length ?? 0)
            || campaign.stop_on_reply !== true || campaign.stop_on_auto_reply !== true || campaign.stop_for_company !== true
            || fingerprintCampaignSequence(campaign) !== job.sequenceFingerprint) block("recovery_campaign_changed", "The reviewed empty campaign changed; keep this stage held.");
          if ((await client.listCampaignLeads(campaignId)).length || (await client.listEmails({ campaignId })).length) block("recovery_campaign_nonempty", "The reviewed campaign is no longer empty; no upload was repeated.");
          validateClearances(input, candidate, now(), 300_000);
        } else {
          mutationStarted = true;
          phase = "create_paused_campaign";
          // Provider timezone governs delivery; the preflight window already uses the recorded recipient timezone.
          campaign = await client.createPausedCampaign({ name: `Gather managed ${job.id} ${job.variant}`, senderEmails: [job.senderEmail],
            subject: steps[0].subject, bodyText: rendered.body, bodyHtml: rendered.html, ...providerSchedule(now(), candidate.recipientTimezone) });
          campaignId = campaign.id;
        }
        phase = "created_sequence_fingerprint";
        const createdFingerprint = fingerprintCampaignSequence(campaign);
        const intendedFingerprint = fingerprintCampaignSequence({ ...campaign, sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: steps[0].subject, body: rendered.html }] }] }] });
        if (createdFingerprint !== intendedFingerprint) block("created_copy_changed", "Provider subject or body differs from the approved rendered email; hold before lead upload.");
        phase = "persist_created_campaign";
        await persistence.updateWithLease(job.id, owner.workspaceId, claimed.leaseToken, { providerCampaignId: campaignId, sequenceFingerprint: createdFingerprint }, now());
        phase = "upload_verified_lead";
        mutationStarted = true;
        const uploaded = await client.uploadVerifiedLead(campaignId, { email: job.email, companyName: candidate.company,
          verificationEvidence: `${candidate.emailVerification.source} ${candidate.emailVerification.checkedAt}; non-catch-all verified` });
        uploadCounts = { leads_uploaded: uploaded.leads_uploaded, in_blocklist: uploaded.in_blocklist, duplicated_leads: uploaded.duplicated_leads,
          skipped_count: uploaded.skipped_count, invalid_email_count: uploaded.invalid_email_count, created_leads: uploaded.created_leads.length };
        phase = "validate_lead_upload";
        if (uploaded.leads_uploaded !== 1 || uploaded.in_blocklist !== 0 || uploaded.duplicated_leads !== 0 || uploaded.skipped_count !== 0 || uploaded.invalid_email_count !== 0 || uploaded.created_leads.length !== 1) block("upload_not_confirmed", "The exact verified recipient upload was not confirmed.");
      } else {
        if (!campaignId) block("missing_campaign", "A threaded followup requires the original provider campaign.");
        const proof = priorProof(job, events);
        const before = await client.getCampaign(campaignId);
        const plan = planInstantlyFollowup(before, { expectedSequenceFingerprint: proof.expectedSequenceFingerprint, bodyText: rendered.body, bodyHtml: rendered.html, delayDays: steps[job.nextStep - 1].delayDays });
        await persistence.upsertEvent({ id: `managed:append-intent:${job.id}:${job.nextStep}`, workspaceId: owner.workspaceId, jobId: job.id, type: "append_planned", occurredAt: now(),
          data: { campaignId, beforeFingerprint: proof.expectedSequenceFingerprint, afterFingerprint: plan.sequenceFingerprint, step: job.nextStep } });
        mutationStarted = true;
        phase = "append_next_step";
        const appended = await client.appendNextStep(campaignId, { ...proof, bodyText: rendered.body, bodyHtml: rendered.html, delayDays: steps[job.nextStep - 1].delayDays });
        campaign = appended.campaign;
      }
      const fingerprint = fingerprintCampaignSequence(campaign);
      phase = "persist_stage_receipt";
      await persistence.upsertEvent({ id: `managed:staged:${job.id}:${job.nextStep}`, workspaceId: owner.workspaceId, jobId: job.id, type: "staged", occurredAt: now(),
        data: { provider: "instantly", campaignId, step: job.nextStep, experimentId: job.experimentId, variant: job.variant,
          localDate: rendered.localDate, bodyHash: rendered.bodyHash, sequenceFingerprint: fingerprint } });
      const saved = await persistence.updateWithLease(job.id, owner.workspaceId, claimed.leaseToken, { status: "staged", providerCampaignId: campaignId, sequenceFingerprint: fingerprint, lastError: null }, now());
      return jobResult(saved);
    }
    const checkedAt = validateClearances(input, candidate, now());
    if (!isRecipientBusinessWindow(now(), candidate.recipientTimezone)) block("outside_business_hours", "The recipient's sending window closed before activation.");
    if (!campaignId) block("missing_campaign", "The prepared provider campaign is missing.");
    const actual = await client.getCampaign(campaignId);
    if (actual.email_list?.length !== 1 || actual.email_list[0].toLowerCase() !== job.senderEmail) block("sender_changed", "The provider campaign sender changed after staging; activation was held.");
    if (fingerprintCampaignSequence(actual) !== job.sequenceFingerprint) block("sequence_changed", "Provider content changed after staging; activation was held.");
    const followupProof = job.nextStep > 1 ? priorProof(job, events) : null;
    await persistence.upsertEvent({ id: `managed:activation-attempt:${reservationId}`, workspaceId: owner.workspaceId, jobId: job.id, type: "activation_attempted", occurredAt: now(),
      data: { reservationId, provider: "instantly", campaignId, step: job.nextStep, experimentId: job.experimentId, variant: job.variant, preflightCheckedAt: checkedAt } });
    // This is the only point that queues a provider send. A queued result is never a sent receipt.
    mutationStarted = true;
    phase = "activate_campaign";
    if (job.nextStep === 1) await client.activateCampaign(campaignId, { preflightCheckedAt: checkedAt, expectedRecipientEmail: job.email, expectedSenderEmail: job.senderEmail });
    else await client.activateNextStep(campaignId, { ...followupProof!, preflightCheckedAt: checkedAt });
    phase = "persist_queued_receipt";
    await persistence.upsertEvent({ id: `managed:queued:${job.id}:${job.nextStep}`, workspaceId: owner.workspaceId, jobId: job.id, type: "activation_queued", occurredAt: now(),
      data: { reservationId, provider: "instantly", campaignId, step: job.nextStep, experimentId: job.experimentId, variant: job.variant, preflightCheckedAt: checkedAt } });
    const queued = await persistence.updateWithLease(job.id, owner.workspaceId, claimed.leaseToken, { status: "queued", lastError: null }, now());
    return jobResult(queued);
  } catch (error) {
    const providerId = error instanceof ManagedInstantlyError ? error.providerId : undefined;
    const uncertain = mutationStarted || (error instanceof ManagedInstantlyError && error.outcomeUnknown);
    const reason = error instanceof ManagedDispatchError ? error.message : uncertain
      ? "Provider mutation or durable receipt could not be confirmed. Reconcile before any retry."
      : "Preflight could not be completed; no provider send was confirmed.";
    if (uncertain) {
      // A known campaign is paused as a best effort. Never claim that pause succeeded if the request fails.
      if (campaignId || providerId) { try { await client.pauseCampaign((campaignId || providerId)!); } catch { /* Keep uncertain; do not retry sends. */ } }
      await persistence.markMutationUncertain(job.id, owner.workspaceId, claimed.leaseToken, reason, campaignId || providerId);
      // Diagnostic facts only: never retain raw exceptions, provider bodies, keys,
      // request payloads or recipient lists. This event cannot authorize a retry.
      try {
        await persistence.upsertEvent({ id: `managed:mutation-diagnostic:${job.id}:${job.nextStep}:${randomUUID()}`, workspaceId: owner.workspaceId, jobId: job.id,
          type: "provider_mutation_diagnostic", occurredAt: now(), data: { provider: "instantly", action: input.action, step: job.nextStep, phase,
            campaignId: campaignId || providerId || null, mutationStarted,
            errorClass: error instanceof ManagedInstantlyError ? "provider" : error instanceof ManagedDispatchError ? "dispatch_guard" : "internal",
            providerCode: error instanceof ManagedInstantlyError ? error.code : null,
            providerHttpStatus: error instanceof ManagedInstantlyError ? error.status ?? null : null,
            providerOutcomeUnknown: error instanceof ManagedInstantlyError ? error.outcomeUnknown : null,
            ...(uploadCounts ? { uploadCounts } : {}) } });
      } catch { /* The uncertain hold is already durable; diagnostics never trigger a retry. */ }
    } else if (reservationId) {
      // Only a provably pre-attempt failure can cancel its reservation. The store
      // preserves both receipts and refuses cancellation after an activation marker.
      await persistence.cancelPreMutationReservation(job.id, owner.workspaceId, claimed.leaseToken, reservationId, reason, now());
    } else await persistence.updateWithLease(job.id, owner.workspaceId, claimed.leaseToken, { status: "held", lastError: reason }, now());
    if (error instanceof ManagedDispatchError && !uncertain) throw error;
    throw new ManagedDispatchError(uncertain ? "mutation_uncertain" : "preflight_failed", reason, uncertain ? 409 : 503);
  }
}

export function providerSchedule(now: Date, timezone: ManagedCandidate["recipientTimezone"]): { timezone: "America/Detroit"; timing: { from: string; to: string } } {
  // Detroit is a documented provider timezone. Convert the recipient's actual local
  // date rather than treating unsupported Pacific aliases as another IANA timezone.
  const recipient = localParts(now, timezone); const provider = localParts(now, "America/Detroit");
  const recipientWall = Date.parse(`${recipient.date}T${String(recipient.hour).padStart(2, "0")}:${String(recipient.minute).padStart(2, "0")}:00Z`);
  const providerWall = Date.parse(`${provider.date}T${String(provider.hour).padStart(2, "0")}:${String(provider.minute).padStart(2, "0")}:00Z`);
  const delta = (providerWall - recipientWall) / 60_000;
  const from = 9 * 60 + delta; const to = 15 * 60 + delta;
  if (!Number.isInteger(delta) || from < 0 || to >= 24 * 60) block("provider_timezone_unverified", "This recipient schedule cannot be represented safely in the provider timezone.");
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { timezone: "America/Detroit", timing: { from: hhmm(from), to: hhmm(to) } };
}

export function safeManagedJob(job: ManagedOutreachJob) {
  let candidate: Record<string, unknown> = {};
  try { candidate = object(JSON.parse(job.candidateJson)); } catch { /* Invalid saved context is returned as unknown, never inferred. */ }
  const savedText = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 250 ? value.trim() : null;
  const savedList = (value: unknown) => value === undefined ? []
    : Array.isArray(value) && value.length <= 100 && value.every(item => savedText(item)) ? value.map(item => savedText(item)!) : null;
  const recipientTimezone = typeof candidate.recipientTimezone === "string" && RECIPIENT_TIMEZONES.includes(candidate.recipientTimezone as ManagedCandidate["recipientTimezone"])
    ? candidate.recipientTimezone : null;
  const company = savedText(candidate.company); const title = savedText(candidate.title);
  const segment = candidate.segment === "cmo" || candidate.segment === "agency" ? candidate.segment : null;
  const corporateDomains = savedList(candidate.corporateDomains); const corporateNames = savedList(candidate.corporateNames);
  return { jobId: job.id, externalId: job.externalId, email: job.email, companyDomain: job.companyDomain, senderEmail: job.senderEmail,
    recipientTimezone, company, title, segment, corporateDomains, corporateNames,
    candidateContextComplete: Boolean(recipientTimezone && company && title && segment && corporateDomains && corporateNames),
    status: job.status, nextStep: job.nextStep, dueAt: job.dueAt?.toISOString() ?? null, providerCampaignId: job.providerCampaignId,
    experimentId: job.experimentId, variant: job.variant, lastError: job.lastError, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString() };
}
