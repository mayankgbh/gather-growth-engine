import type { ManagedOutreachEvent, ManagedOutreachJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ManagedInstantlyClient } from "./instantly";
import { normalizeEmail } from "./policy";
import { canonicalOutreachJson, createManagedOutreachStore } from "./store";

export const MANAGED_REPLY_CLASSIFICATIONS = ["positive", "neutral", "negative", "meeting_request", "unsubscribe", "out_of_office", "delivery_failure", "spam"] as const;
export type ManagedReplyClassification = typeof MANAGED_REPLY_CLASSIFICATIONS[number];
export type ManagedReplyInput = {
  incomingEmailId: string; classification: ManagedReplyClassification; summary: string;
  explicitOptOut?: boolean; evidenceQuote?: string;
};
type Json = Record<string, unknown>;
type SuppressionStatus = "not_requested" | "pending" | "needs_retry" | "confirmed";
type Source = { incoming: ManagedOutreachEvent; job: ManagedOutreachJob; data: Json; fromEmail: string; toEmail: string };
type ClaimedClassification = { source: Source; receipt: ManagedOutreachEvent; attempt?: number; suppressionStatus: SuppressionStatus; providerSuppressionId: string | null };
const RETRY_LEASE_MS = 60_000;
const RETRY_MESSAGE = "Opt-out classification is saved. Provider suppression needs retry; outreach remains held.";

export class ManagedReplyError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "ManagedReplyError"; }
}
function refuse(code: string, message: string, status = 400): never { throw new ManagedReplyError(code, message, status); }
function jsonObject(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid_input", "A JSON object is required.");
  return value as Json;
}
function savedObject(value: string): Json {
  try { return jsonObject(JSON.parse(value)); }
  catch { return refuse("invalid_saved_evidence", "Saved reply evidence cannot be verified.", 409); }
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) refuse("invalid_input", `${field} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}
export function parseManagedReplyInput(value: unknown): ManagedReplyInput {
  const body = jsonObject(value);
  const allowed = ["incomingEmailId", "classification", "summary", "explicitOptOut", "evidenceQuote"];
  if (Object.keys(body).some(key => !allowed.includes(key))) refuse("invalid_input", "Only incomingEmailId, classification, summary and opt-out evidence may be supplied.");
  const incomingEmailId = requiredText(body.incomingEmailId, "incomingEmailId", 200);
  if (/[\s/?#\\]/.test(incomingEmailId) || incomingEmailId.startsWith("instantly:")) refuse("invalid_input", "Use the exact provider incoming email ID.");
  if (typeof body.classification !== "string" || !MANAGED_REPLY_CLASSIFICATIONS.includes(body.classification as ManagedReplyClassification)) refuse("invalid_classification", "Unknown reply classification.");
  if (body.explicitOptOut !== undefined && typeof body.explicitOptOut !== "boolean") refuse("invalid_input", "explicitOptOut must be a boolean.");
  const evidenceQuote = body.evidenceQuote === undefined ? undefined : requiredText(body.evidenceQuote, "evidenceQuote", 300);
  const classification = body.classification as ManagedReplyClassification;
  if (classification === "unsubscribe" && (body.explicitOptOut !== true || !evidenceQuote)) refuse("opt_out_evidence_required", "Unsubscribe requires explicitOptOut:true and a short exact quote of the stop request.");
  if (classification !== "unsubscribe" && (body.explicitOptOut === true || evidenceQuote !== undefined)) refuse("invalid_input", "Opt-out evidence is only accepted for unsubscribe classification.");
  return { incomingEmailId, classification, summary: requiredText(body.summary, "summary", 2000),
    ...(body.explicitOptOut === undefined ? {} : { explicitOptOut: body.explicitOptOut as boolean }), ...(evidenceQuote ? { evidenceQuote } : {}) };
}

async function lock(tx: Prisma.TransactionClient, workspaceId: string) {
  const scope = `managed-outreach:${workspaceId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))::text AS acquired`;
}
async function loadSource(tx: Prisma.TransactionClient, workspaceId: string, input: ManagedReplyInput): Promise<Source> {
  const incoming = await tx.managedOutreachEvent.findFirst({ where: {
    id: `instantly:incoming:${input.incomingEmailId}`, workspaceId, type: "incoming_received", providerMessageId: input.incomingEmailId,
  } });
  if (!incoming?.jobId) refuse("incoming_not_found", "The incoming email was not found in this workspace.", 404);
  const job = await tx.managedOutreachJob.findFirst({ where: { id: incoming.jobId, workspaceId } });
  if (!job) refuse("incoming_not_found", "The incoming email was not found in this workspace.", 404);
  const data = savedObject(incoming.dataJson);
  const fromEmail = typeof data.fromEmail === "string" ? normalizeEmail(data.fromEmail) : "";
  const toEmail = typeof data.toEmail === "string" ? normalizeEmail(data.toEmail) : "";
  if (data.provider !== "instantly" || data.source !== "provider-email" || data.contentTrust !== "untrusted_email"
    || !fromEmail || fromEmail !== job.email || !toEmail || toEmail !== job.senderEmail
    || data.recipientEmail !== job.email || data.senderEmail !== job.senderEmail || !job.providerCampaignId
    || data.campaignId !== job.providerCampaignId || typeof data.threadId !== "string" || !data.threadId
    || typeof data.rfcMessageId !== "string" || !data.rfcMessageId) {
    refuse("invalid_saved_evidence", "Saved reply identity does not match its campaign job; outreach remains held.", 409);
  }
  return { incoming, job, data, fromEmail, toEmail };
}
function checkOptOut(input: ManagedReplyInput, source: Source) {
  if (input.classification !== "unsubscribe") return;
  const quote = input.evidenceQuote!;
  // This validates the owner's explicit classification; incoming text never acts as executable instructions.
  const stopRequest = /\b(?:unsubscribe(?:\s+me)?|remove\s+me|take\s+me\s+off|opt[ -]?out|stop\s+(?:contacting|emailing|e-mailing|sending|messaging|reaching\s+out)|(?:do\s+not|don['’]t)\s+(?:contact|email|e-mail|send|message)|no\s+more\s+(?:emails?|messages?|contact))\b/i;
  // The campaign footer explicitly offers "no thanks" as a stop command. Only
  // accept that exact standalone opening response, never a mention in prose,
  // quoted history or the outgoing footer embedded farther down the message.
  const courtesyStop = /^no[ \t]+(?:thanks|thank[ \t]+you)[.!?]*$/i;
  const firstLine = typeof source.data.bodyExcerpt === "string"
    ? source.data.bodyExcerpt.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "" : "";
  const explicitCourtesyStop = courtesyStop.test(quote) && courtesyStop.test(firstLine) && firstLine.includes(quote);
  if (source.data.bodyAvailability !== "available" || typeof source.data.bodyExcerpt !== "string"
    || !source.data.bodyExcerpt.includes(quote) || !(stopRequest.test(quote) || explicitCourtesyStop)) {
    refuse("invalid_opt_out_evidence", "The quote must appear in the saved incoming body and contain an explicit stop request.");
  }
}
function classificationData(input: ManagedReplyInput, source: Source) {
  return { provider: "instantly", source: "owner-classification", contentTrust: "untrusted_email",
    incomingEventId: source.incoming.id, incomingEmailId: input.incomingEmailId,
    classification: input.classification, summary: input.summary, explicitOptOut: input.explicitOptOut === true,
    evidenceQuote: input.evidenceQuote ?? null, fromEmail: source.fromEmail, toEmail: source.toEmail,
    campaignId: source.data.campaignId, threadId: source.data.threadId, rfcMessageId: source.data.rfcMessageId,
    jobExternalId: source.job.externalId, demoBooked: false };
}
async function hold(tx: Prisma.TransactionClient, source: Source, message: string) {
  await tx.managedOutreachJob.updateMany({ where: { id: source.job.id, workspaceId: source.job.workspaceId, status: { not: "suppressed" } },
    data: { status: "held", dueAt: null, leaseToken: null, leaseUntil: null, lastError: message } });
}
async function confirmedSuppression(tx: Prisma.TransactionClient, source: Source, input: ManagedReplyInput): Promise<string | null> {
  const event = await tx.managedOutreachEvent.findFirst({ where: { id: `instantly:suppressed:${input.incomingEmailId}`,
    workspaceId: source.job.workspaceId, jobId: source.job.id, type: "unsubscribed", providerMessageId: input.incomingEmailId } });
  if (!event) return null;
  const data = savedObject(event.dataJson);
  if (data.incomingEventId !== source.incoming.id || data.classificationEventId !== `instantly:classification:${input.incomingEmailId}`
    || data.fromEmail !== source.fromEmail || data.suppressionStatus !== "confirmed"
    || typeof data.providerSuppressionId !== "string" || !data.providerSuppressionId) refuse("invalid_saved_evidence", "Saved suppression evidence cannot be verified.", 409);
  return data.providerSuppressionId;
}
function view(claim: ClaimedClassification) {
  const data = savedObject(claim.receipt.dataJson);
  return { classificationEventId: claim.receipt.id, incomingEventId: claim.source.incoming.id,
    incomingEmailId: claim.source.incoming.providerMessageId, providerMessageId: claim.source.incoming.providerMessageId,
    jobId: claim.source.job.id, jobExternalId: claim.source.job.externalId,
    classification: data.classification, summary: data.summary, explicitOptOut: data.explicitOptOut,
    evidenceQuote: data.evidenceQuote, fromEmail: claim.source.fromEmail, toEmail: claim.source.toEmail,
    campaignId: claim.source.data.campaignId, threadId: claim.source.data.threadId, rfcMessageId: claim.source.data.rfcMessageId,
    recordedAt: claim.receipt.occurredAt.toISOString(), demoBooked: false,
    status: claim.suppressionStatus === "confirmed" || claim.source.job.status === "suppressed" ? "suppressed" : claim.suppressionStatus === "needs_retry" ? "held_needs_retry" : "held",
    suppressionStatus: claim.suppressionStatus, providerSuppressionId: claim.providerSuppressionId,
    retryRequired: claim.suppressionStatus === "needs_retry", sendingHeld: true };
}

/** Classify only a durable incoming receipt; this function never sends mail or resumes outreach. */
export async function classifyManagedReply(workspaceId: string, raw: ManagedReplyInput, options: {
  getClient?: () => Promise<Pick<ManagedInstantlyClient, "suppressEmail"> | null>;
  now?: Date;
} = {}) {
  const input = parseManagedReplyInput(raw);
  if (!workspaceId?.trim()) refuse("invalid_input", "An owner workspace is required.");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) refuse("invalid_input", "A valid classification time is required.");
  const claim = await prisma.$transaction(async tx => {
    await lock(tx, workspaceId);
    const source = await loadSource(tx, workspaceId, input);
    checkOptOut(input, source);
    const id = `instantly:classification:${input.incomingEmailId}`;
    const data = classificationData(input, source);
    let receipt = await tx.managedOutreachEvent.findFirst({ where: { id, workspaceId, jobId: source.job.id } });
    if (receipt) {
      if (receipt.type !== "reply_classified" || receipt.providerMessageId !== input.incomingEmailId
        || canonicalOutreachJson(savedObject(receipt.dataJson)) !== canonicalOutreachJson(data)) {
        refuse("classification_conflict", "This incoming email already has a different immutable classification.", 409);
      }
    } else receipt = await createManagedOutreachStore(tx).upsertEvent({ id, workspaceId, jobId: source.job.id,
      type: "reply_classified", providerMessageId: input.incomingEmailId, occurredAt: now, data });
    await hold(tx, source, input.classification === "unsubscribe" ? RETRY_MESSAGE : "Incoming email classified; outreach remains held for owner review.");
    const result: ClaimedClassification = { source, receipt, suppressionStatus: "not_requested", providerSuppressionId: null };
    if (input.classification !== "unsubscribe") return result;
    const confirmed = await confirmedSuppression(tx, source, input);
    if (confirmed) return { ...result, suppressionStatus: "confirmed" as const, providerSuppressionId: confirmed };
    const attempts = await tx.managedOutreachEvent.findMany({ where: {
      workspaceId, jobId: source.job.id, type: "suppression_attempt", providerMessageId: input.incomingEmailId,
    }, orderBy: { occurredAt: "desc" } });
    // Sequence IDs avoid ambiguous timestamp ordering when concurrent requests share a millisecond.
    const latest = attempts.find(event => event.id === `instantly:suppression-attempt:${input.incomingEmailId}:${attempts.length}`);
    if (attempts.length && !latest) refuse("invalid_saved_evidence", "Saved suppression attempts cannot be verified.", 409);
    if (latest) {
      const outcome = await tx.managedOutreachEvent.findFirst({ where: { id: `${latest.id}:outcome`, workspaceId, jobId: source.job.id } });
      if (!outcome && now.getTime() - latest.occurredAt.getTime() < RETRY_LEASE_MS) return { ...result, suppressionStatus: "pending" as const };
    }
    const attempt = attempts.length + 1;
    await createManagedOutreachStore(tx).upsertEvent({ id: `instantly:suppression-attempt:${input.incomingEmailId}:${attempt}`,
      workspaceId, jobId: source.job.id, type: "suppression_attempt", providerMessageId: input.incomingEmailId, occurredAt: now,
      data: { incomingEventId: source.incoming.id, classificationEventId: id, fromEmail: source.fromEmail, attempt, suppressionStatus: "pending" } });
    return { ...result, attempt, suppressionStatus: "pending" as const };
  }, { maxWait: 3_000, timeout: 10_000 });
  if (claim.attempt === undefined) return view(claim);

  let providerSuppressionId: string | null = null;
  try {
    const client = await options.getClient?.();
    if (!client) throw new Error("Provider unavailable");
    const receipt = await client.suppressEmail(claim.source.fromEmail);
    if (!receipt || receipt.is_domain !== false || normalizeEmail(receipt.bl_value) !== claim.source.fromEmail || typeof receipt.id !== "string" || !receipt.id) throw new Error("Suppression not confirmed");
    providerSuppressionId = receipt.id;
  } catch { /* Persist a generic retry state below; never expose provider bodies or credentials. */ }
  return prisma.$transaction(async tx => {
    await lock(tx, workspaceId);
    // A concurrent retry can have already confirmed suppression; never downgrade that state.
    const previous = await confirmedSuppression(tx, claim.source, input);
    const confirmed = previous ?? providerSuppressionId;
    const store = createManagedOutreachStore(tx);
    if (confirmed && !previous) await store.upsertEvent({ id: `instantly:suppressed:${input.incomingEmailId}`,
      workspaceId, jobId: claim.source.job.id, type: "unsubscribed", providerMessageId: input.incomingEmailId, occurredAt: now,
      data: { provider: "instantly", incomingEventId: claim.source.incoming.id, classificationEventId: claim.receipt.id,
        fromEmail: claim.source.fromEmail, suppressionStatus: "confirmed", providerSuppressionId: confirmed } });
    await store.upsertEvent({ id: `instantly:suppression-attempt:${input.incomingEmailId}:${claim.attempt}:outcome`,
      workspaceId, jobId: claim.source.job.id, type: confirmed ? "suppression_confirmed" : "suppression_needs_retry",
      providerMessageId: input.incomingEmailId, occurredAt: now,
      data: { incomingEventId: claim.source.incoming.id, classificationEventId: claim.receipt.id, fromEmail: claim.source.fromEmail,
        suppressionStatus: confirmed ? "confirmed" : "needs_retry", providerSuppressionId: confirmed } });
    if (confirmed) await tx.managedOutreachJob.updateMany({ where: { id: claim.source.job.id, workspaceId },
      data: { status: "suppressed", dueAt: null, leaseToken: null, leaseUntil: null, lastError: null } });
    else await hold(tx, claim.source, RETRY_MESSAGE);
    return view({ ...claim, suppressionStatus: confirmed ? "confirmed" : "needs_retry", providerSuppressionId: confirmed });
  }, { maxWait: 3_000, timeout: 10_000 });
}
