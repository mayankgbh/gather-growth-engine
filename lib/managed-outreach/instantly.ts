/**
 * Restricted Instantly API v2 adapter. Only explicit activation calls queue mail.
 * Official references (reviewed 2026-11-04):
 * https://developer.instantly.ai/api-reference/groups/email
 * https://developer.instantly.ai/api-reference/email/list-email
 * https://developer.instantly.ai/api-reference/campaign/create-campaign
 * https://developer.instantly.ai/api-reference/lead/add-leads-in-bulk-to-a-campaign-or-list
 * https://developer.instantly.ai/api-reference/campaign/patch-campaign
 * https://help.instantly.ai/en/articles/13924383-how-to-add-new-steps-to-an-active-campaign
 *
 * Campaign activation queues provider work, rather than synchronously sending one
 * message. It cannot enforce a fresh external CRM check at actual send time.
 * There is no documented first-touch send endpoint. /emails/reply requires an
 * existing message and defaults to that message's sender; /emails/test is not a
 * production-send workaround. Activation is the controlled dispatch boundary,
 * not a promise about SMTP execution time. Followups use the documented native
 * pause/append/resume workflow, with only one unsent step present at a time.
 */

import { createHash } from "crypto";

const API_BASE = "https://api.instantly.ai/api/v2";
type JsonObject = Record<string, unknown>;

export const INSTANTLY_MANAGED_CAPABILITIES = Object.freeze({
  mailboxInventory: true,
  inboundEmailPagination: true,
  providerBlocklist: true,
  pauseCampaigns: true,
  stageSingleStepCampaigns: true,
  nativeStopOnReply: true,
  synchronousFirstTouch: false,
  freshExternalChecksAtActualSend: false,
  guaranteedThreadedUnansweredFollowup: false,
  documentedMutationIdempotencyKey: false,
  guardedSingleRecipientActivation: true,
  documentedNativeThreadedFollowup: true,
  guardedIncrementalFollowup: true,
  sendBoundaryLimitation: "Instantly campaign activation queues asynchronous sends; fresh external exclusions are checked before dispatch, not again at provider SMTP execution. Direct first-touch sending is not documented.",
});

export class ManagedInstantlyError extends Error {
  readonly code: "provider_error" | "invalid_response" | "pagination_incomplete" | "invalid_input" | "launch_blocked";
  readonly outcomeUnknown: boolean;
  readonly status?: number;
  readonly providerId?: string;
  readonly expectedSequenceFingerprint?: string;
  constructor(message: string, options: {
    code: ManagedInstantlyError["code"];
    outcomeUnknown?: boolean;
    status?: number;
    providerId?: string;
    expectedSequenceFingerprint?: string;
  }) {
    super(message);
    this.name = "ManagedInstantlyError";
    this.code = options.code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.status = options.status;
    this.providerId = options.providerId;
    this.expectedSequenceFingerprint = options.expectedSequenceFingerprint;
  }
}

export type ManagedInstantlyAccount = {
  email: string;
  status?: number;
  warmup_status: number; // 1 means warmup ACTIVE, not warmup completed or safe to send.
  setup_pending: boolean;
  daily_limit?: number | null;
  stat_warmup_score?: number | null;
  timestamp_created?: string;
  timestamp_warmup_start?: string | null;
};
export type ManagedInstantlyCampaign = {
  id: string;
  name: string;
  status: number; // 0 draft, 1 active, 2 paused, 3 completed, 4 subsequences.
  email_list?: string[];
  email_tag_list?: string[];
  stop_on_reply?: boolean | null;
  stop_on_auto_reply?: boolean | null;
  stop_for_company?: boolean | null;
  sequences?: InstantlySequence[];
};
export type InstantlySequence = { steps: InstantlySequenceStep[] };
export type InstantlySequenceStep = {
  type: string;
  delay?: number;
  delay_unit?: "days" | "hours" | "minutes";
  variants: Array<{ subject: string; body: string; v_disabled?: boolean }>;
};
export type ManagedInstantlyLead = {
  id: string;
  email?: string | null;
  campaign?: string | null;
  status: number; // -1 bounced; -2 unsubscribed. These are states, not event IDs.
  email_reply_count: number;
  lt_interest_status?: number;
  timestamp_last_contact?: string | null;
  timestamp_last_reply?: string | null;
  last_step_from?: string | null;
  last_step_id?: string | null;
  status_summary?: { lastStep?: { from?: string; stepID?: string; timestamp_executed?: string } };
};
export type ManagedInstantlyEmail = {
  id: string;
  message_id: string;
  timestamp_created: string; // Provider ingestion time, used for checkpointing.
  timestamp_email: string; // Sender-controlled timestamp; do not use alone for dedup.
  subject: string;
  eaccount: string;
  from_address_email?: string | null;
  to_address_email_list: string;
  cc_address_email_list?: string | null;
  bcc_address_email_list?: string | null;
  body: { text?: string; html?: string };
  campaign_id?: string | null;
  lead?: string | null;
  lead_id?: string | null;
  thread_id?: string | null;
  step?: string | null;
  ue_type?: number | null; // 1 campaign sent, 2 received, 3 manually sent, 4 scheduled.
  is_auto_reply?: number | null;
  body_fallback_reason?: "too_large" | "unavailable" | null;
};
export type ManagedInstantlyBlockEntry = { id: string; bl_value: string; is_domain: boolean };
/** Webhook delivery history only: an empty list is NOT evidence of no bounces. */
export type ManagedInstantlyWebhookEvent = {
  id: string;
  timestamp_created: string;
  payload?: JsonObject;
  success: boolean; // Webhook delivery succeeded, not email delivery.
  retry_group_id?: string | null;
  lead_email?: string | null;
};
export type InstantlyPage<T> = { items: T[]; next_starting_after?: string };
export type EmailWindow = {
  minCreatedAt?: string;
  maxCreatedAt?: string;
  campaignId?: string;
  leadEmail?: string;
  accountEmail?: string;
  threadId?: string;
  emailType?: "received" | "sent" | "manual";
};
export type PausedCampaignInput = {
  name: string;
  senderEmails: string[];
  subject: string;
  bodyText: string;
  /** Trusted server-rendered HTML, never an inbound message or caller-supplied fragment. */
  bodyHtml?: string;
  timezone?: "America/Detroit" | "America/Chicago" | "America/Boise" | "America/Dawson" | "America/Anchorage" | "America/Creston" | "Etc/GMT+10";
  /** Explicit supported-zone hours; caller may convert verified recipient-local hours. */
  timing?: { from: string; to: string };
};
export type VerifiedLeadInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  verificationEvidence: string;
  customVariables?: Record<string, string>;
};
export type LeadUploadResult = {
  status: string;
  leads_uploaded: number;
  in_blocklist: number;
  duplicated_leads: number;
  skipped_count: number;
  invalid_email_count: number;
  created_leads: Array<{ id: string; index: number; email?: string | null }>;
};
export type InstantlyFollowupProof = {
  expectedRecipientEmail: string;
  expectedSenderEmail: string;
  expectedThreadId: string;
  /** Complete immutable sent-email IDs, in chronological step order, from our ledger. */
  priorSentEmailIds: string[];
  expectedSequenceFingerprint: string;
};
export type AppendInstantlyStepInput = InstantlyFollowupProof & {
  bodyText: string;
  bodyHtml?: string;
  /** Native delay from the preceding step's actual send, not from append time. */
  delayDays: number;
};
export type InstantlyFollowupPlan = {
  sequences: InstantlySequence[];
  sequenceFingerprint: string;
  nextStep: number;
};
export type InstantlyAccountCampaignMapping = {
  campaign_id: string; campaign_name: string; timestamp_created: string; status: number;
};
export type InstantlySenderRemovalPlan = {
  campaignId: string; campaignName: string; status: number; senderEmail: string;
  before: string[]; after: string[]; fingerprint: string; alreadyAbsent: boolean;
};
export type InstantlyAccountTagMapping = { id: string; tag_id: string; resource_id: string; resource_type: 1 };
export type InstantlyAccountTagRemovalPlan = {
  campaignId: string; campaignName: string; senderEmail: string; campaignTagIds: string[];
  before: InstantlyAccountTagMapping[]; after: InstantlyAccountTagMapping[];
  removeTagIds: string[]; fingerprint: string; alreadyAbsent: boolean;
};
export type InstantlyAccountHealth = {
  observedAt: string;
  account: ManagedInstantlyAccount;
  campaign: {
    requestedWindow: { startDate: string; endDate: string };
    daily: Array<{ date: string; sent: number; bounced: number; replies?: number }>;
    observedDates: string[];
    missingDates: string[];
    completeWindow: boolean;
    sent: number | null;
    bounced: number | null;
    bounceRatio: number | null;
  };
  warmup: {
    dailyObserved: Array<{ date: string; sent: number | null; received: number | null; landed_inbox: number | null; landed_spam: number | null }>;
    aggregate: { sent: number | null; received: number | null; landed_inbox: number | null; landed_spam: number | null; health_score: number | null; health_score_label: string | null } | null;
    scope: "warmup_only";
    aggregateWindow: "provider_defined_not_requested_window";
  };
  complaints: { status: "not_exposed_by_reviewed_endpoints" };
  authentication: { status: "not_checked" };
  sources: string[];
};
export type InstantlyDomainVitals = {
  domain: string;
  allPass: boolean;
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  indeterminate: Array<"mx" | "spf" | "dkim" | "dmarc">;
};
export type InstantlyAccountVitals = {
  email: string;
  observedAt: string;
  status: "success";
  success_list: InstantlyDomainVitals[];
  failure_list: InstantlyDomainVitals[];
  scope: "domain_dns_diagnostic";
  connectionStatus: "not_reported_by_this_endpoint";
  countsAsCampaignSend: false;
  source: string;
};

function blocked(message: string): never {
  throw new ManagedInstantlyError(message, { code: "launch_blocked" });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as JsonObject;
  return `{${Object.keys(obj).filter(key => obj[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

function validatedFollowupSequences(campaign: ManagedInstantlyCampaign): InstantlySequence[] {
  const sequences = campaign.sequences;
  if (!Array.isArray(sequences) || sequences.length !== 1 || !Array.isArray(sequences[0].steps)
    || sequences[0].steps.length < 1 || sequences[0].steps.length > 5
    || Object.keys(sequences[0]).some(key => key !== "steps")) blocked("A single managed sequence of at most five steps is required.");
  sequences[0].steps.forEach((step, index) => {
    if (!step || Object.keys(step).some(key => !["type", "delay", "delay_unit", "variants"].includes(key))
      || step.type !== "email" || !Number.isInteger(step.delay) || Number(step.delay) < 0 || Number(step.delay) > 366
      || (step.delay_unit !== undefined && step.delay_unit !== "days")
      || !Array.isArray(step.variants) || step.variants.length !== 1) blocked("Unexpected sequence shape or timing; hold for review.");
    const variant = step.variants[0];
    if (!variant || Object.keys(variant).some(key => !["subject", "body", "v_disabled"].includes(key))
      || typeof variant.subject !== "string" || typeof variant.body !== "string" || !variant.body.trim()
      || (index === 0 ? !variant.subject.trim() : variant.subject !== "")
      || (variant.v_disabled !== undefined && variant.v_disabled !== false)) blocked("Managed followups require one enabled variant and a blank followup subject.");
  });
  return sequences;
}

/** Persist this fingerprint with the managed dispatch; never silently adopt edits from the provider. */
export function fingerprintCampaignSequence(campaign: ManagedInstantlyCampaign): string {
  const sequences = validatedFollowupSequences(campaign);
  return createHash("sha256").update(canonicalJson(sequences)).digest("hex");
}

/** Pure plan: callers can persist the intended new fingerprint BEFORE a provider mutation. */
export function planInstantlyFollowup(campaign: ManagedInstantlyCampaign, input: {
  expectedSequenceFingerprint: string; bodyText: string; bodyHtml?: string; delayDays: number;
}): InstantlyFollowupPlan {
  if (fingerprintCampaignSequence(campaign) !== input.expectedSequenceFingerprint) blocked("The provider sequence changed; do not append to an unrecognized sequence.");
  if (typeof input.bodyText !== "string" || !input.bodyText.trim()) invalid("Followup text is required.");
  if (input.bodyHtml !== undefined && (typeof input.bodyHtml !== "string" || !input.bodyHtml.trim())) invalid("Rendered followup HTML must be nonempty.");
  if (!Number.isInteger(input.delayDays) || input.delayDays < 1 || input.delayDays > 30) invalid("A followup interval of 1–30 days is required.");
  const sequences = JSON.parse(JSON.stringify(campaign.sequences)) as InstantlySequence[];
  const steps = sequences[0].steps;
  if (steps.length >= 5) blocked("The managed sequence already contains all five steps.");
  // The only change to a completed step is its documented wait before NEXT email.
  steps[steps.length - 1].delay = input.delayDays;
  steps[steps.length - 1].delay_unit = "days";
  steps.push({ type: "email", delay: 0, delay_unit: "days", variants: [{ subject: "", body: input.bodyHtml ?? textToHtml(input.bodyText) }] });
  return { sequences, sequenceFingerprint: fingerprintCampaignSequence({ ...campaign, sequences }), nextStep: steps.length };
}

/** Reviewable exact removal; no other campaign settings are part of the PATCH. */
export function planInstantlySenderRemoval(campaign: ManagedInstantlyCampaign, senderEmail: string, verifiedAccountTagIds?: string[]): InstantlySenderRemovalPlan {
  const exact = inputEmail(senderEmail);
  if (!Array.isArray(campaign.email_list) || campaign.email_list.length > 10_000
    || campaign.email_list.some(email => typeof email !== "string" || inputEmail(email) !== email.toLowerCase())
    || new Set(campaign.email_list.map(email => email.toLowerCase())).size !== campaign.email_list.length) {
    blocked("Campaign sender assignments are incomplete or ambiguous.");
  }
  if (campaign.email_tag_list !== undefined && !Array.isArray(campaign.email_tag_list)) blocked("Campaign tag assignments are ambiguous.");
  if (campaign.email_tag_list?.length && (!verifiedAccountTagIds || campaign.email_tag_list.some(id => verifiedAccountTagIds.includes(id)))) {
    blocked("Tag-based sender assignments must be removed from this mailbox first; campaign tag lists must remain unchanged.");
  }
  const before = [...campaign.email_list];
  const after = before.filter(email => email.toLowerCase() !== exact);
  if (after.length !== before.length && !after.length) blocked("The mailbox is the campaign's only sender; do not disable that campaign implicitly.");
  return { campaignId: campaign.id, campaignName: campaign.name, status: campaign.status, senderEmail: exact,
    before, after, alreadyAbsent: before.length === after.length,
    fingerprint: createHash("sha256").update(canonicalJson({ id: campaign.id, name: campaign.name, status: campaign.status,
      email_list: before, email_tag_list: campaign.email_tag_list ?? [] })).digest("hex") };
}

export function planInstantlyAccountTagRemoval(campaign: ManagedInstantlyCampaign, senderEmail: string, mappings: InstantlyAccountTagMapping[]): InstantlyAccountTagRemovalPlan {
  const exact = inputEmail(senderEmail);
  if (!Array.isArray(campaign.email_tag_list) || campaign.email_tag_list.some(id => typeof id !== "string" || !id)
    || new Set(campaign.email_tag_list).size !== campaign.email_tag_list.length) blocked("Exact campaign tag assignments are required.");
  if (!Array.isArray(mappings) || mappings.some(row => row.resource_type !== 1 || row.resource_id.toLowerCase() !== exact || !row.id || !row.tag_id)
    || new Set(mappings.map(row => row.tag_id)).size !== mappings.length) blocked("Exact account tag mappings are required.");
  const before = [...mappings].sort((a, b) => a.tag_id.localeCompare(b.tag_id));
  const campaignTagIds = [...campaign.email_tag_list].sort();
  const removeTagIds = before.filter(row => campaignTagIds.includes(row.tag_id)).map(row => row.tag_id);
  const after = before.filter(row => !removeTagIds.includes(row.tag_id));
  return { campaignId: campaign.id, campaignName: campaign.name, senderEmail: exact, campaignTagIds, before, after, removeTagIds,
    alreadyAbsent: removeTagIds.length === 0,
    fingerprint: createHash("sha256").update(canonicalJson({ campaignId: campaign.id, senderEmail: exact, campaignTagIds, before })).digest("hex") };
}

function textToHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br/>");
}

function invalid(message: string): never {
  throw new ManagedInstantlyError(message, { code: "invalid_input" });
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as JsonObject;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty string");
  return value;
}
function numeric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected number");
  return value;
}
function count(value: unknown): number {
  const n = numeric(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("Invalid nonnegative count");
  return n;
}
function optionalCount(value: unknown): number | null { return value == null ? null : count(value); }
function isoDate(value: unknown): string {
  const date = string(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Invalid calendar date");
  return date;
}
function parseAccount(value: unknown): ManagedInstantlyAccount {
  const a = object(value); string(a.email); numeric(a.warmup_status);
  if (typeof a.setup_pending !== "boolean") throw new Error("Missing setup status");
  if (a.status !== undefined) numeric(a.status);
  if (a.daily_limit != null) count(a.daily_limit);
  if (a.stat_warmup_score != null) numeric(a.stat_warmup_score);
  if (a.timestamp_created != null) timestamp(a.timestamp_created);
  if (a.timestamp_warmup_start != null) timestamp(a.timestamp_warmup_start);
  // Deliberately omit signatures, ownership, status text and SMTP configuration.
  return { email: a.email, warmup_status: a.warmup_status, setup_pending: a.setup_pending,
    status: a.status, daily_limit: a.daily_limit, stat_warmup_score: a.stat_warmup_score,
    timestamp_created: a.timestamp_created, timestamp_warmup_start: a.timestamp_warmup_start } as ManagedInstantlyAccount;
}
function inputEmail(value: string): string {
  if (typeof value !== "string" || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(value)) invalid("An exact valid email address is required.");
  return value.toLowerCase();
}
function inputId(value: string): string {
  if (typeof value !== "string" || !value || /[\s/?#\\]/.test(value)) invalid("A provider ID is required.");
  return encodeURIComponent(value);
}
function timestamp(value: unknown): string {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text))) throw new Error("Invalid timestamp");
  return text;
}
function parseCampaign(value: unknown): ManagedInstantlyCampaign {
  const v = object(value);
  string(v.id); string(v.name); numeric(v.status);
  return v as unknown as ManagedInstantlyCampaign;
}
function parseEmail(value: unknown): ManagedInstantlyEmail {
  const v = object(value);
  string(v.id); string(v.message_id); timestamp(v.timestamp_created); timestamp(v.timestamp_email);
  string(v.eaccount); string(v.to_address_email_list);
  if (typeof v.subject !== "string") throw new Error("Missing subject");
  const body = object(v.body);
  for (const key of ["text", "html"]) if (body[key] !== undefined && typeof body[key] !== "string") throw new Error("Invalid body");
  if (v.ue_type != null && ![1, 2, 3, 4].includes(numeric(v.ue_type))) throw new Error("Unknown direction");
  return v as unknown as ManagedInstantlyEmail;
}
function parseLead(value: unknown): ManagedInstantlyLead {
  const v = object(value);
  string(v.id); numeric(v.status); numeric(v.email_reply_count);
  if (v.email != null) string(v.email);
  return v as unknown as ManagedInstantlyLead;
}
function parseBlock(value: unknown): ManagedInstantlyBlockEntry {
  const v = object(value);
  string(v.id); string(v.bl_value);
  if (typeof v.is_domain !== "boolean") throw new Error("Missing blocklist type");
  return v as unknown as ManagedInstantlyBlockEntry;
}
function page<T>(value: unknown, parseItem: (value: unknown) => T): InstantlyPage<T> {
  const v = object(value);
  if (!Array.isArray(v.items)) throw new Error("Missing page items");
  if (v.next_starting_after != null && typeof v.next_starting_after !== "string") throw new Error("Invalid cursor");
  const cursor = v.next_starting_after || undefined;
  if (cursor && v.items.length === 0) throw new Error("Empty page with continuation");
  return { items: v.items.map(parseItem), ...(cursor ? { next_starting_after: string(cursor) } : {}) };
}

export function createManagedInstantlyClient(apiKey: string, options: {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxPages?: number;
} = {}) {
  if (!apiKey?.trim()) invalid("An existing Instantly API key is required.");
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPages = options.maxPages ?? 20;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) invalid("Invalid page budget.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) invalid("Invalid timeout.");

  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, parse: (value: unknown) => T, args: {
    body?: unknown; query?: Record<string, string | undefined>; mutation?: boolean;
  } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(args.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    try {
      const response = await fetcher(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
        signal: controller.signal,
        cache: "no-store",
        redirect: "error", // Never forward the Authorization header to a redirected host.
      });
      if (!response.ok) throw new ManagedInstantlyError(`Instantly request failed (HTTP ${response.status}).`, {
        code: "provider_error", status: response.status,
        outcomeUnknown: !!args.mutation && (response.status >= 500 || response.status === 408),
      });
      try {
        return parse(await response.json());
      } catch {
        throw new ManagedInstantlyError("Instantly returned an invalid response; reconciliation is required for mutations.", {
          code: "invalid_response", outcomeUnknown: !!args.mutation,
        });
      }
    } catch (error) {
      if (error instanceof ManagedInstantlyError) throw error;
      // No retries: a timeout/network error after a mutation can mean it succeeded.
      throw new ManagedInstantlyError("Instantly request did not complete; do not retry mutations without reconciliation.", {
        code: "provider_error", outcomeUnknown: !!args.mutation,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function allPages<T>(getPage: (cursor?: string) => Promise<InstantlyPage<T>>): Promise<T[]> {
    const items: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let count = 0; count < maxPages; count++) {
      const result = await getPage(cursor);
      items.push(...result.items);
      cursor = result.next_starting_after;
      if (!cursor) return items;
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    // No partial success or checkpoint is returned.
    throw new ManagedInstantlyError("Instantly pagination was incomplete; preserve the previous checkpoint.", { code: "pagination_incomplete" });
  }

  function listEmailsPage(window: EmailWindow = {}, cursor?: string) {
    for (const date of [window.minCreatedAt, window.maxCreatedAt]) {
      if (date !== undefined && !Number.isFinite(Date.parse(date))) invalid("Invalid email scan timestamp.");
    }
    return request("GET", "/emails", v => page(v, parseEmail), { query: {
      limit: "100", starting_after: cursor, mode: "emode_all", latest_of_thread: "false",
      preview_only: "false", sort_order: "asc", min_timestamp_created: window.minCreatedAt,
      max_timestamp_created: window.maxCreatedAt, campaign_id: window.campaignId,
      lead: window.leadEmail && inputEmail(window.leadEmail),
      eaccount: window.accountEmail && inputEmail(window.accountEmail),
      search: window.threadId ? `thread:${window.threadId}` : undefined,
      email_type: window.emailType,
    } });
  }
  function getCampaign(id: string) {
    return request("GET", `/campaigns/${inputId(id)}`, parseCampaign);
  }
  function listAccountCampaigns(email: string) {
    const exact = inputEmail(email);
    return allPages(cursor => request("GET", `/account-campaign-mappings/${encodeURIComponent(exact)}`, value => page(value, item => {
      const row = object(item);
      return { campaign_id: string(row.campaign_id), campaign_name: string(row.campaign_name),
        timestamp_created: timestamp(row.timestamp_created), status: numeric(row.status) };
    }), { query: { limit: "100", starting_after: cursor } }));
  }
  function listAccountTagMappings(email: string) {
    const exact = inputEmail(email);
    return allPages(cursor => request("GET", "/custom-tag-mappings", value => page(value, item => {
      const row = object(item);
      if (row.resource_type !== 1 || string(row.resource_id).toLowerCase() !== exact) throw new Error("Unexpected tag resource");
      return { id: string(row.id), tag_id: string(row.tag_id), resource_id: exact, resource_type: 1 as const };
    }), { query: { limit: "100", starting_after: cursor, resource_ids: exact } }));
  }
  async function getSenderRemovalPlan(campaignId: string, senderEmail: string) {
    const campaign = await getCampaign(campaignId);
    if (campaign.id !== campaignId) blocked("Unexpected provider campaign identity.");
    const tagIds = campaign.email_tag_list?.length ? (await listAccountTagMappings(senderEmail)).map(row => row.tag_id) : undefined;
    return planInstantlySenderRemoval(campaign, senderEmail, tagIds);
  }
  async function getAccountTagRemovalPlan(campaignId: string, senderEmail: string) {
    const [campaign, mappings] = await Promise.all([getCampaign(campaignId), listAccountTagMappings(senderEmail)]);
    if (campaign.id !== campaignId) blocked("Unexpected provider campaign identity.");
    return planInstantlyAccountTagRemoval(campaign, senderEmail, mappings);
  }
  async function removeAccountTagsForCampaign(campaignId: string, senderEmail: string, expectedFingerprint: string,
    beforeMutation: (plan: InstantlyAccountTagRemovalPlan) => Promise<void>) {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint) || typeof beforeMutation !== "function") invalid("A saved exact account-tag plan and durable audit callback are required.");
    const plan = await getAccountTagRemovalPlan(campaignId, senderEmail);
    if (plan.fingerprint !== expectedFingerprint) blocked("Account or campaign tags changed; read a fresh removal plan.");
    if (plan.alreadyAbsent) return { ...plan, outcome: "already_absent" as const, checkedAt: new Date().toISOString() };
    await beforeMutation(plan);
    if ((await getAccountTagRemovalPlan(campaignId, senderEmail)).fingerprint !== expectedFingerprint) blocked("Tag assignments changed before removal; no mutation requested.");
    let mutationAccepted = false;
    try {
      await request("POST", "/custom-tags/toggle-resource", value => {
        if (object(value).success !== true) throw new Error("Unconfirmed tag removal");
        return true;
      }, { mutation: true, body: { tag_ids: plan.removeTagIds, resource_type: 1, resource_ids: [plan.senderEmail], selected_all: false, assign: false } });
      mutationAccepted = true;
      const confirmed = await getAccountTagRemovalPlan(campaignId, senderEmail);
      if (canonicalJson(confirmed.before) !== canonicalJson(plan.after) || canonicalJson(confirmed.campaignTagIds) !== canonicalJson(plan.campaignTagIds)) {
        throw new ManagedInstantlyError("Exact account-tag removal was not confirmed; inspect provider state before retrying.", { code: "invalid_response", outcomeUnknown: true });
      }
      return { ...plan, outcome: "removed" as const, checkedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ManagedInstantlyError && !mutationAccepted) throw error;
      throw new ManagedInstantlyError("Account-tag removal may have been applied; reconcile saved evidence before retrying.", {
        code: error instanceof ManagedInstantlyError ? error.code : "provider_error", outcomeUnknown: true, providerId: campaignId,
      });
    }
  }
  async function removeSenderFromCampaign(campaignId: string, senderEmail: string, expectedFingerprint: string,
    beforeMutation: (plan: InstantlySenderRemovalPlan) => Promise<void>) {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint) || typeof beforeMutation !== "function") invalid("A saved exact removal plan and durable audit callback are required.");
    const plan = await getSenderRemovalPlan(campaignId, senderEmail);
    if (plan.fingerprint !== expectedFingerprint) blocked("Campaign assignments changed since review; fetch a fresh removal plan.");
    if (plan.alreadyAbsent) return { ...plan, outcome: "already_absent" as const, checkedAt: new Date().toISOString() };
    await beforeMutation(plan); // Fail closed if the attempted mutation cannot be saved.
    // Re-read AFTER saving the intent. Do not apply a stale sender-array snapshot.
    const latest = await getSenderRemovalPlan(campaignId, senderEmail);
    if (latest.fingerprint !== expectedFingerprint) blocked("Campaign assignments changed before removal; no PATCH was requested.");
    let patchAccepted = false;
    try {
      await request("PATCH", `/campaigns/${inputId(campaignId)}`, parseCampaign, { mutation: true, body: { email_list: plan.after } });
      patchAccepted = true;
      const observed = await getSenderRemovalPlan(campaignId, senderEmail);
      if (observed.campaignId !== campaignId || observed.status !== latest.status || observed.campaignName !== latest.campaignName
        || canonicalJson(observed.before) !== canonicalJson(plan.after)) throw new ManagedInstantlyError("Sender removal was not confirmed exactly; inspect provider state before retrying.", { code: "invalid_response", outcomeUnknown: true });
      return { ...plan, outcome: "removed" as const, checkedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ManagedInstantlyError && !patchAccepted) throw error;
      throw new ManagedInstantlyError("Sender removal may have been applied; reconcile the saved campaign and assignment evidence before retrying.", {
        code: error instanceof ManagedInstantlyError ? error.code : "provider_error", outcomeUnknown: true, providerId: campaignId,
      });
    }
  }
  async function getAccountHealth(email: string, window: { startDate: string; endDate: string }): Promise<InstantlyAccountHealth> {
    const exact = inputEmail(email);
    let startDate: string; let endDate: string;
    try { startDate = isoDate(window.startDate); endDate = isoDate(window.endDate); }
    catch { invalid("Account health requires valid YYYY-MM-DD dates."); }
    const dayCount = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 31) invalid("Account health requires a window of 1–31 calendar days.");
    const requestedDates = Array.from({ length: dayCount }, (_, offset) => new Date(Date.parse(startDate) + offset * 86_400_000).toISOString().slice(0, 10));
    const [account, daily, warmup] = await Promise.all([
      request("GET", `/accounts/${encodeURIComponent(exact)}`, value => {
        const result = parseAccount(value);
        if (result.email.toLowerCase() !== exact) throw new Error("Wrong account");
        return result;
      }),
      request("GET", "/accounts/analytics/daily", value => {
        if (!Array.isArray(value)) throw new Error("Missing daily analytics");
        const seen = new Set<string>();
        return value.map(item => {
          const row = object(item); const date = isoDate(row.date);
          if (string(row.email_account).toLowerCase() !== exact || date < startDate || date > endDate || seen.has(date)) throw new Error("Unexpected daily analytics row");
          seen.add(date);
          return { date, sent: count(row.sent), bounced: count(row.bounced), ...(row.replies == null ? {} : { replies: count(row.replies) }) };
        }).sort((a, b) => a.date.localeCompare(b.date));
      }, { query: { emails: exact, start_date: startDate, end_date: endDate } }),
      // A read-scoped analytics POST; this does not enable warmup or buy accounts.
      request("POST", "/accounts/warmup-analytics", value => {
        const v = object(value);
        const emailDates = object(v.email_date_data);
        const aggregates = object(v.aggregate_data);
        for (const map of [emailDates, aggregates]) {
          if (Object.keys(map).length > 1 || Object.keys(map).some(key => key.toLowerCase() !== exact)) throw new Error("Unexpected warmup account");
        }
        const datesKey = Object.keys(emailDates)[0];
        const aggregateKey = Object.keys(aggregates)[0];
        const dates = datesKey ? object(emailDates[datesKey]) : {};
        const dailyObserved = Object.keys(dates).map(key => {
          const date = isoDate(key); const row = object(dates[key]);
          return { date, sent: optionalCount(row.sent), received: optionalCount(row.received), landed_inbox: optionalCount(row.landed_inbox), landed_spam: optionalCount(row.landed_spam) };
        }).filter(row => row.date >= startDate && row.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
        const aggregateRow = aggregateKey ? object(aggregates[aggregateKey]) : null;
        const healthScore = aggregateRow?.health_score == null ? null : numeric(aggregateRow.health_score);
        if (healthScore !== null && (healthScore < 0 || healthScore > 100)) throw new Error("Invalid warmup score");
        if (aggregateRow?.health_score_label != null && typeof aggregateRow.health_score_label !== "string") throw new Error("Invalid warmup label");
        const aggregate = aggregateRow ? {
          sent: optionalCount(aggregateRow.sent), received: optionalCount(aggregateRow.received),
          landed_inbox: optionalCount(aggregateRow.landed_inbox), landed_spam: optionalCount(aggregateRow.landed_spam),
          health_score: healthScore, health_score_label: (aggregateRow.health_score_label as string | null | undefined) ?? null,
        } : null;
        return { dailyObserved, aggregate, scope: "warmup_only" as const, aggregateWindow: "provider_defined_not_requested_window" as const };
      }, { mutation: false, body: { emails: [exact] } }),
    ]);
    const observedDates = daily.map(row => row.date);
    const missingDates = requestedDates.filter(date => !observedDates.includes(date));
    const sent = daily.length ? daily.reduce((sum, row) => sum + row.sent, 0) : null;
    const bounced = daily.length ? daily.reduce((sum, row) => sum + row.bounced, 0) : null;
    return { observedAt: new Date().toISOString(), account,
      campaign: { requestedWindow: { startDate, endDate }, daily, observedDates, missingDates,
        completeWindow: missingDates.length === 0, sent, bounced, bounceRatio: sent && bounced !== null ? bounced / sent : null },
      warmup, complaints: { status: "not_exposed_by_reviewed_endpoints" }, authentication: { status: "not_checked" },
      sources: ["https://developer.instantly.ai/api-reference/account/get-account",
        "https://developer.instantly.ai/api-reference/account/get-daily-account-analytics",
        "https://developer.instantly.ai/api-reference/account/get-warmup-analytics",
        "https://help.instantly.ai/en/articles/13939939-warmup-health-score"],
    };
  }
  /**
   * Explicit diagnostic only, never called by passive inventory/health reads.
   * The provider documentation does not exclude internal test sending; therefore
   * a timeout is an uncertain diagnostic outcome, never an automatic retry.
   */
  async function runAccountVitals(email: string): Promise<InstantlyAccountVitals> {
    const exact = inputEmail(email);
    const expectedDomain = exact.split("@")[1];
    return request("POST", "/accounts/test/vitals", value => {
      const v = object(value);
      if (v.status !== "success" || !Array.isArray(v.success_list) || !Array.isArray(v.failure_list)) throw new Error("Missing diagnostic results");
      const parseResult = (item: unknown, success: boolean): InstantlyDomainVitals => {
        const row = object(item);
        const domain = string(row.domain).toLowerCase();
        if (domain !== expectedDomain) throw new Error("Diagnostic returned an unexpected domain");
        for (const key of ["allPass", "mx", "spf", "dkim", "dmarc"]) if (typeof row[key] !== "boolean") throw new Error("Incomplete DNS result");
        const uncertain = row.indeterminate === undefined ? [] : row.indeterminate;
        if (!Array.isArray(uncertain) || uncertain.some(key => !["mx", "spf", "dkim", "dmarc"].includes(key)) || new Set(uncertain).size !== uncertain.length) throw new Error("Invalid indeterminate DNS result");
        if (row.allPass !== success || (row.allPass && (!row.mx || !row.spf || !row.dkim || !row.dmarc || uncertain.length))) throw new Error("Inconsistent DNS diagnostic result");
        return { domain, allPass: row.allPass, mx: row.mx, spf: row.spf, dkim: row.dkim, dmarc: row.dmarc,
          indeterminate: uncertain } as InstantlyDomainVitals;
      };
      // One requested mailbox has one domain; no broad workspace results leak out.
      if (v.success_list.length + v.failure_list.length !== 1) throw new Error("Expected exactly one diagnostic domain result");
      return { email: exact, observedAt: new Date().toISOString(), status: "success",
        success_list: v.success_list.map(item => parseResult(item, true)),
        failure_list: v.failure_list.map(item => parseResult(item, false)),
        scope: "domain_dns_diagnostic", connectionStatus: "not_reported_by_this_endpoint", countsAsCampaignSend: false,
        source: "https://developer.instantly.ai/api-reference/account/test-account-vitals",
      };
    }, { mutation: true, body: { accounts: [exact] } });
  }
  async function pauseCampaign(id: string) {
    const result = await request("POST", `/campaigns/${inputId(id)}/pause`, parseCampaign, { mutation: true, body: {} });
    if (result.id !== id || ![0, 2, 3].includes(result.status)) throw new ManagedInstantlyError("Campaign pause was not confirmed.", {
      code: "invalid_response", outcomeUnknown: true, providerId: id,
    });
    return result;
  }
  function listBlocklist() {
    return allPages(cursor => request("GET", "/block-lists-entries", v => page(v, parseBlock), {
      query: { limit: "100", starting_after: cursor },
    }));
  }
  async function isSuppressed(email: string) {
    const exact = inputEmail(email);
    const domain = exact.split("@")[1];
    // Read the complete blocklist; fuzzy search must not miss a domain block.
    return (await listBlocklist()).some(entry => {
      const value = entry.bl_value.trim().toLowerCase().replace(/^@/, "");
      return entry.is_domain ? domain === value || domain.endsWith(`.${value}`) : exact === value;
    });
  }
  function listCampaignLeads(campaignId: string) {
    inputId(campaignId);
    return allPages(cursor => request("POST", "/leads/list", v => page(v, parseLead), {
      body: { campaign: campaignId, limit: 100, starting_after: cursor },
      mutation: false, // Documented read-only POST, never a send or enrollment.
    }));
  }
  async function listInboundEmails(window: Omit<EmailWindow, "emailType"> = {}) {
    const emails = await allPages(cursor => listEmailsPage({ ...window, emailType: "received" }, cursor));
    if (emails.some(email => email.ue_type !== 2)) throw new ManagedInstantlyError("Inbound scan included an unconfirmed email direction.", { code: "invalid_response" });
    return emails;
  }
  function getEmail(id: string) {
    return request("GET", `/emails/${inputId(id)}`, value => {
      const email = parseEmail(value);
      if (email.id !== id) throw new Error("Wrong email receipt");
      return email;
    });
  }
  function assertFreshPreflight(checkedAt: string) {
    const at = Date.parse(checkedAt);
    if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 60_000) blocked("Fresh external exclusions and eligibility checks are required immediately before dispatch.");
  }
  function validateFollowupProof(proof: InstantlyFollowupProof) {
    const sender = inputEmail(proof.expectedSenderEmail);
    const recipient = inputEmail(proof.expectedRecipientEmail);
    inputId(proof.expectedThreadId);
    if (sender === recipient || !Array.isArray(proof.priorSentEmailIds) || proof.priorSentEmailIds.length < 1
      || proof.priorSentEmailIds.length > 4 || new Set(proof.priorSentEmailIds).size !== proof.priorSentEmailIds.length
      || !/^[a-f0-9]{64}$/.test(proof.expectedSequenceFingerprint)) invalid("Complete unique prior sent IDs, thread and sequence fingerprint are required for a followup.");
    proof.priorSentEmailIds.forEach(inputId);
    return { sender, recipient };
  }
  function assertFollowupCampaign(campaign: ManagedInstantlyCampaign, campaignId: string, proof: InstantlyFollowupProof, expectedSteps: number) {
    const { sender } = validateFollowupProof(proof);
    if (campaign.id !== campaignId || ![2, 3].includes(campaign.status)
      || campaign.stop_on_reply !== true || campaign.stop_on_auto_reply !== true || campaign.stop_for_company !== true
      || campaign.email_list?.length !== 1 || campaign.email_list[0].toLowerCase() !== sender
      || fingerprintCampaignSequence(campaign) !== proof.expectedSequenceFingerprint
      || campaign.sequences![0].steps.length !== expectedSteps) {
      blocked("Followup campaign identity, sequence, progress or stop-on-reply protections do not match the saved evidence.");
    }
  }
  async function verifyFollowupHistory(campaign: ManagedInstantlyCampaign, proof: InstantlyFollowupProof, requireCompleted: boolean) {
    const { sender, recipient } = validateFollowupProof(proof);
    const leads = await listCampaignLeads(campaign.id);
    const candidate = leads[0];
    if (leads.length !== 1 || candidate.email?.toLowerCase() !== recipient || candidate.campaign !== campaign.id
      || !(requireCompleted ? [3] : [1, 3]).includes(candidate.status) || candidate.email_reply_count !== 0
      || candidate.timestamp_last_reply || candidate.lt_interest_status != null) {
      blocked("The previous sequence must be completed by exactly one recipient, without replies, pause labels, bounces or other stop states.");
    }
    // Fetch ALL campaign mail, not just a latest-thread preview or a sent-only list.
    // Unexpected manual, inbound or scheduled mail prevents a new dispatch.
    const history = await allPages(cursor => listEmailsPage({ campaignId: campaign.id }, cursor));
    if (history.length !== proof.priorSentEmailIds.length || new Set(history.map(email => email.id)).size !== history.length
      || history.some(email => email.ue_type !== 1 || !proof.priorSentEmailIds.includes(email.id))) {
      blocked("Campaign mail history does not exactly match the immutable completed-step ledger.");
    }
    // Catch responses from a different address that have not been attached to the
    // original lead/campaign yet. Thread identity, not inferred sender, stops us.
    const threadHistory = await allPages(cursor => listEmailsPage({ threadId: proof.expectedThreadId }, cursor));
    if (threadHistory.length !== proof.priorSentEmailIds.length
      || new Set(threadHistory.map(email => email.id)).size !== threadHistory.length
      || threadHistory.some(email => email.ue_type !== 1 || email.thread_id !== proof.expectedThreadId || !proof.priorSentEmailIds.includes(email.id))) {
      blocked("Thread history includes a reply, pending mail or unrecognized activity; hold the sequence.");
    }
    const messages = await Promise.all(proof.priorSentEmailIds.map(id => getEmail(id)));
    const firstSubject = campaign.sequences![0].steps[0].variants[0].subject;
    const rfcIds = new Set<string>();
    let previousTime = -Infinity;
    for (let index = 0; index < messages.length; index++) {
      const email = messages[index];
      const sentAt = Date.parse(email.timestamp_email);
      // Unibox's opaque step field is never treated as an invented numeric index.
      if (email.ue_type !== 1 || email.campaign_id !== campaign.id || email.lead_id !== candidate.id
        || email.lead?.toLowerCase() !== recipient || email.eaccount.toLowerCase() !== sender
        || email.from_address_email?.toLowerCase() !== sender || email.to_address_email_list.toLowerCase() !== recipient
        || email.cc_address_email_list?.trim() || email.bcc_address_email_list?.trim()
        || email.thread_id !== proof.expectedThreadId || email.body_fallback_reason
        || (!email.body.text?.trim() && !email.body.html?.trim()) || rfcIds.has(email.message_id)
        || sentAt <= previousTime || sentAt > Date.now() + 300_000
        || Date.parse(email.timestamp_created) > Date.now() + 300_000
        || (index === 0 ? email.subject !== firstSubject : email.subject.replace(/^(?:re:\s*)+/i, "") !== firstSubject)) {
        blocked("Prior outbound evidence failed exact sender, recipient, thread, subject, chronology or message validation.");
      }
      const listed = history.find(item => item.id === email.id)!;
      if (listed.message_id !== email.message_id || listed.timestamp_email !== email.timestamp_email
        || listed.campaign_id !== email.campaign_id || listed.thread_id !== email.thread_id) {
        blocked("Provider list and immutable message evidence disagree; reconcile before following up.");
      }
      rfcIds.add(email.message_id);
      previousTime = sentAt;
    }
    const previous = messages[messages.length - 1];
    const lastContact = Date.parse(candidate.timestamp_last_contact ?? "");
    if (!Number.isFinite(lastContact) || Math.abs(lastContact - Date.parse(previous.timestamp_email)) > 300_000) {
      blocked("Lead progress does not match the newest proven outbound message.");
    }
    const progress = candidate.status_summary?.lastStep;
    if ((candidate.last_step_from != null && candidate.last_step_from !== "campaign")
      || (progress?.from != null && progress.from !== "campaign")
      || [candidate.last_step_id, progress?.stepID].some(id => id != null && (!previous.step || id !== previous.step))
      || (progress?.timestamp_executed != null && (!Number.isFinite(Date.parse(progress.timestamp_executed))
        || Math.abs(Date.parse(progress.timestamp_executed) - Date.parse(previous.timestamp_email)) > 300_000))) {
      blocked("Provider lead progress refers to a different step or execution.");
    }
    if (await isSuppressed(recipient)) blocked("Recipient is on the provider blocklist.");
    if ((await listInboundEmails({ leadEmail: recipient })).length) blocked("Incoming mail exists for this recipient; hold all further sequence steps.");
    return { previous, candidate };
  }

  async function appendNextStep(campaignId: string, input: AppendInstantlyStepInput) {
    validateFollowupProof(input);
    const campaign = await getCampaign(campaignId);
    assertFollowupCampaign(campaign, campaignId, input, input.priorSentEmailIds.length);
    const plan = planInstantlyFollowup(campaign, input);
    await verifyFollowupHistory(campaign, input, true);
    try {
      // The documented edit workflow explicitly pauses before adding a step.
      await pauseCampaign(campaignId);
      const paused = await getCampaign(campaignId);
      assertFollowupCampaign(paused, campaignId, input, input.priorSentEmailIds.length);
      const staged = await request("PATCH", `/campaigns/${inputId(campaignId)}`, parseCampaign, {
        mutation: true, body: { sequences: plan.sequences },
      });
      let stagedFingerprint: string;
      try { stagedFingerprint = fingerprintCampaignSequence(staged); }
      catch { throw new ManagedInstantlyError("Followup patch response is incomplete; reconcile the known campaign.", { code: "invalid_response", outcomeUnknown: true }); }
      if (staged.id !== campaignId || ![2, 3].includes(staged.status)
        || stagedFingerprint !== plan.sequenceFingerprint
        || staged.email_list?.length !== 1 || staged.email_list[0].toLowerCase() !== input.expectedSenderEmail.toLowerCase()
        || staged.stop_on_reply !== true || staged.stop_on_auto_reply !== true || staged.stop_for_company !== true) {
        throw new ManagedInstantlyError("Followup patch was not confirmed exactly as planned.", { code: "invalid_response", outcomeUnknown: true });
      }
      return { campaign: staged, sequenceFingerprint: plan.sequenceFingerprint, nextStep: plan.nextStep,
        priorSentEmailIds: [...input.priorSentEmailIds], threadId: input.expectedThreadId };
    } catch (error) {
      if (error instanceof ManagedInstantlyError && error.outcomeUnknown) {
        try { await pauseCampaign(campaignId); } catch { /* Pausing cannot undo prior sends. */ }
        throw new ManagedInstantlyError("Followup staging is uncertain. Pause was attempted; compare the saved intended fingerprint before retrying any mutation.", {
          code: error.code, status: error.status, outcomeUnknown: true, providerId: campaignId,
          expectedSequenceFingerprint: plan.sequenceFingerprint,
        });
      }
      throw error;
    }
  }

  async function activateNextStep(campaignId: string, proof: InstantlyFollowupProof & { preflightCheckedAt: string }) {
    assertFreshPreflight(proof.preflightCheckedAt);
    validateFollowupProof(proof);
    const campaign = await getCampaign(campaignId);
    assertFollowupCampaign(campaign, campaignId, proof, proof.priorSentEmailIds.length + 1);
    const { previous } = await verifyFollowupHistory(campaign, proof, false);
    const priorStep = campaign.sequences![0].steps[proof.priorSentEmailIds.length - 1];
    const delay = Number(priorStep.delay);
    if (!Number.isInteger(delay) || delay < 1 || delay > 30
      || Date.now() < Date.parse(previous.timestamp_email) + delay * 86_400_000) blocked("The next followup is not due relative to the previous actual send.");
    assertFreshPreflight(proof.preflightCheckedAt);
    try {
      const active = await request("POST", `/campaigns/${inputId(campaignId)}/activate`, parseCampaign, { mutation: true, body: {} });
      if (active.id !== campaignId || active.status !== 1) throw new ManagedInstantlyError("Followup activation was not confirmed.", { code: "invalid_response", outcomeUnknown: true });
      return active; // Native queued execution; only a later immutable email proves sent.
    } catch (error) {
      if (error instanceof ManagedInstantlyError && error.outcomeUnknown) {
        try { await pauseCampaign(campaignId); } catch { /* Keep the uncertain outcome. */ }
        throw new ManagedInstantlyError("Followup activation is uncertain. Pause was attempted; reconcile immutable provider mail history before retrying.", {
          code: error.code, status: error.status, outcomeUnknown: true, providerId: campaignId,
          expectedSequenceFingerprint: proof.expectedSequenceFingerprint,
        });
      }
      throw error;
    }
  }

  return {
    capabilities: INSTANTLY_MANAGED_CAPABILITIES,
    listAccounts() {
      return allPages(cursor => request("GET", "/accounts", v => page(v, parseAccount), { query: { limit: "100", starting_after: cursor } }));
    },
    getAccountHealth,
    runAccountVitals,
    listCampaigns() {
      return allPages(cursor => request("GET", "/campaigns", v => page(v, parseCampaign), { query: { limit: "100", starting_after: cursor } }));
    },
    getCampaign,
    listAccountCampaigns,
    listAccountTagMappings,
    getSenderRemovalPlan,
    getAccountTagRemovalPlan,
    removeAccountTagsForCampaign,
    removeSenderFromCampaign,
    pauseCampaign,
    listCampaignLeads,
    listBlocklist,
    isSuppressed,
    async suppressEmail(email: string): Promise<ManagedInstantlyBlockEntry> {
      const exact = inputEmail(email);
      const existing = (await listBlocklist()).find(entry => !entry.is_domain && entry.bl_value.toLowerCase() === exact);
      if (existing) return existing;
      return request("POST", "/block-lists-entries", value => {
        const entry = parseBlock(value);
        if (entry.is_domain || entry.bl_value.toLowerCase() !== exact) throw new Error("Wrong suppression receipt");
        return entry;
      }, { mutation: true, body: { bl_value: exact } });
    },
    /** Historical attempts for configured webhooks, NOT an exhaustive email-event stream. */
    listWebhookEvents(window: { fromDate: string; toDate: string; leadEmail?: string }) {
      for (const date of [window.fromDate, window.toDate]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) invalid("Webhook history requires YYYY-MM-DD dates.");
      }
      return allPages(cursor => request("GET", "/webhook-events", value => page(value, item => {
        const event = object(item); string(event.id); timestamp(event.timestamp_created);
        if (typeof event.success !== "boolean") throw new Error("Missing webhook delivery status");
        if (event.payload !== undefined) object(event.payload);
        return { id: event.id, timestamp_created: event.timestamp_created, payload: event.payload,
          success: event.success, retry_group_id: event.retry_group_id, lead_email: event.lead_email } as ManagedInstantlyWebhookEvent;
      }), { query: { limit: "100", starting_after: cursor, from: window.fromDate, to: window.toDate,
        search: window.leadEmail && inputEmail(window.leadEmail) } }));
    },
    listEmailsPage,
    listEmails(window: EmailWindow = {}) { return allPages(cursor => listEmailsPage(window, cursor)); },
    listInboundEmails,
    getEmail,
    appendNextStep,
    activateNextStep,
    async createPausedCampaign(input: PausedCampaignInput) {
      if (!input.name?.trim() || !input.subject?.trim() || !input.bodyText?.trim()) invalid("Campaign name, subject and body are required.");
      if (input.bodyHtml !== undefined && (typeof input.bodyHtml !== "string" || !input.bodyHtml.trim())) invalid("Rendered campaign HTML must be nonempty.");
      if (!Array.isArray(input.senderEmails) || input.senderEmails.length !== 1) invalid("Exactly one explicit sending account is required.");
      const senders = input.senderEmails.map(inputEmail);
      const timing = input.timing ?? { from: "09:00", to: "16:00" };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.to) || timing.from >= timing.to) invalid("An ordered, same-day HH:mm sending window is required.");
      const html = input.bodyHtml ?? textToHtml(input.bodyText);
      const campaign = await request("POST", "/campaigns", parseCampaign, { mutation: true, body: {
        name: input.name, email_list: senders,
        campaign_schedule: { schedules: [{ name: "US business hours", timing,
          days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
          timezone: input.timezone ?? "America/Detroit" }] },
        sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: input.subject, body: html }] }] }],
        daily_limit: 1, daily_max_leads: 1, email_gap: 15, random_wait_max: 0,
        stop_on_reply: true, stop_on_auto_reply: true, stop_for_company: true,
        insert_unsubscribe_header: true, allow_risky_contacts: false, disable_bounce_protect: false,
        text_only: input.bodyHtml === undefined, first_email_text_only: input.bodyHtml === undefined, open_tracking: false, link_tracking: false,
      } });
      // status is read-only in CreateCampaign, so never send a fictitious status:2.
      // Explicitly pause and confirm before any lead can be added.
      try { return await pauseCampaign(campaign.id); }
      catch { throw new ManagedInstantlyError("Campaign was created but pause was not confirmed. Hold and reconcile this provider ID.", {
        code: "provider_error", outcomeUnknown: true, providerId: campaign.id,
      }); }
    },
    async uploadVerifiedLead(campaignId: string, input: VerifiedLeadInput): Promise<LeadUploadResult> {
      const email = inputEmail(input.email);
      if (!input.verificationEvidence?.trim()) invalid("Saved email verification evidence is required.");
      const campaign = await getCampaign(campaignId);
      if (![0, 2].includes(campaign.status) || campaign.stop_on_reply !== true) invalid("Lead uploads require a paused or draft campaign with stop-on-reply confirmed.");
      if (await isSuppressed(email)) invalid("Recipient is on the provider blocklist.");
      return request("POST", "/leads/add", value => {
        const v = object(value); string(v.status);
        for (const key of ["leads_uploaded", "in_blocklist", "duplicated_leads", "skipped_count", "invalid_email_count"]) numeric(v[key]);
        if (!Array.isArray(v.created_leads)) throw new Error("Missing uploaded provider IDs");
        for (const item of v.created_leads) { const lead = object(item); string(lead.id); numeric(lead.index); }
        return v as unknown as LeadUploadResult;
      }, { mutation: true, body: {
        campaign_id: campaignId, leads: [{ email, first_name: input.firstName, last_name: input.lastName,
          company_name: input.companyName, custom_variables: input.customVariables }],
        skip_if_in_workspace: true, skip_if_in_campaign: true,
        verify_leads_on_import: false, // Already verified; do not purchase a verification job implicitly.
      } });
    },
    async activateCampaign(campaignId: string, guard: { preflightCheckedAt: string; expectedRecipientEmail: string; expectedSenderEmail: string }): Promise<ManagedInstantlyCampaign> {
      const blocked = (message: string): never => { throw new ManagedInstantlyError(message, { code: "launch_blocked" }); };
      const assertFresh = () => {
        const at = Date.parse(guard?.preflightCheckedAt);
        if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 60_000) blocked("Fresh external exclusions and eligibility checks are required immediately before dispatch.");
      };
      assertFresh();
      const expected = inputEmail(guard.expectedRecipientEmail);
      const sender = inputEmail(guard.expectedSenderEmail);
      const campaign = await getCampaign(campaignId);
      const steps = campaign.sequences?.[0]?.steps;
      if (campaign.id !== campaignId || ![0, 2].includes(campaign.status)
        || campaign.stop_on_reply !== true || campaign.stop_on_auto_reply !== true || campaign.stop_for_company !== true
        || campaign.email_list?.length !== 1 || campaign.email_list[0].toLowerCase() !== sender || campaign.sequences?.length !== 1
        || steps?.length !== 1 || steps[0].type !== "email" || steps[0].variants?.length !== 1) {
        blocked("Dispatch requires one paused, one-step campaign with one sender and stop-on-reply protections.");
      }
      const leads = await listCampaignLeads(campaignId);
      if (leads.length !== 1 || leads[0].email?.toLowerCase() !== expected || leads[0].campaign !== campaignId
        || leads[0].status !== 1 || leads[0].email_reply_count !== 0 || leads[0].timestamp_last_contact
        || leads[0].timestamp_last_reply || [2, 3, 4, -1, -2, -3, -4].includes(leads[0].lt_interest_status ?? 999)) {
        blocked("Dispatch requires exactly one untouched eligible recipient; replies, prior contact and stop states are held.");
      }
      if (await isSuppressed(expected)) blocked("Recipient is on the provider blocklist.");
      if ((await listInboundEmails({ leadEmail: expected })).length) blocked("Incoming mail exists for this recipient; hold for review.");
      assertFresh();
      try {
        const activated = await request("POST", `/campaigns/${inputId(campaignId)}/activate`, parseCampaign, { mutation: true, body: {} });
        if (activated.id !== campaignId || activated.status !== 1) throw new ManagedInstantlyError("Activation outcome was not confirmed.", { code: "invalid_response", outcomeUnknown: true });
        return activated; // Queued/active is NOT a sent or delivered receipt.
      } catch (error) {
        if (error instanceof ManagedInstantlyError && error.outcomeUnknown) {
          // Minimize further queued work, but pausing cannot retract a message sent already.
          try { await pauseCampaign(campaignId); } catch { /* Preserve uncertain outcome. */ }
          throw new ManagedInstantlyError("Activation outcome is uncertain. Pause was attempted; reconcile provider history before retrying.", {
            code: error.code, status: error.status, outcomeUnknown: true, providerId: campaignId,
          });
        }
        throw error;
      }
    },
  };
}

export type ManagedInstantlyClient = ReturnType<typeof createManagedInstantlyClient>;
