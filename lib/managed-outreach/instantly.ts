/**
 * Restricted Instantly API v2 adapter. Only explicit activateCampaign queues mail.
 * Official references (reviewed 2026-11-04):
 * https://developer.instantly.ai/api-reference/groups/email
 * https://developer.instantly.ai/api-reference/email/list-email
 * https://developer.instantly.ai/api-reference/campaign/create-campaign
 * https://developer.instantly.ai/api-reference/lead/add-leads-in-bulk-to-a-campaign-or-list
 *
 * Campaign activation queues provider work, rather than synchronously sending one
 * message. It cannot enforce a fresh external CRM check at actual send time.
 * There is no documented first-touch send endpoint. /emails/reply requires an
 * existing message and defaults to that message's sender; /emails/test is not a
 * production-send workaround. Activation is the controlled dispatch boundary,
 * not a promise about SMTP execution time. Unanswered followups remain gated.
 */

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
  sendBoundaryLimitation: "Instantly campaign activation queues asynchronous sends; fresh external exclusions are checked before dispatch, not again at provider SMTP execution. Direct first-touch sending is not documented.",
});

export class ManagedInstantlyError extends Error {
  readonly code: "provider_error" | "invalid_response" | "pagination_incomplete" | "invalid_input" | "launch_blocked";
  readonly outcomeUnknown: boolean;
  readonly status?: number;
  readonly providerId?: string;
  constructor(message: string, options: {
    code: ManagedInstantlyError["code"];
    outcomeUnknown?: boolean;
    status?: number;
    providerId?: string;
  }) {
    super(message);
    this.name = "ManagedInstantlyError";
    this.code = options.code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.status = options.status;
    this.providerId = options.providerId;
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
};
export type ManagedInstantlyCampaign = {
  id: string;
  name: string;
  status: number; // 0 draft, 1 active, 2 paused, 3 completed, 4 subsequences.
  email_list?: string[];
  stop_on_reply?: boolean | null;
  stop_on_auto_reply?: boolean | null;
  stop_for_company?: boolean | null;
  sequences?: Array<{ steps: Array<{ type: string; variants: Array<{ subject: string; body: string }> }> }>;
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
  timezone?: "America/Detroit" | "America/Chicago" | "America/Boise" | "America/Dawson";
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

  async function request<T>(method: "GET" | "POST", path: string, parse: (value: unknown) => T, args: {
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

  return {
    capabilities: INSTANTLY_MANAGED_CAPABILITIES,
    listAccounts() {
      return allPages(cursor => request("GET", "/accounts", v => page(v, value => {
        const a = object(value); string(a.email); numeric(a.warmup_status);
        if (typeof a.setup_pending !== "boolean") throw new Error("Missing setup status");
        if (a.status !== undefined) numeric(a.status);
        // Do not expose unrelated account configuration or credentials to callers.
        return { email: a.email, warmup_status: a.warmup_status, setup_pending: a.setup_pending,
          status: a.status, daily_limit: a.daily_limit, stat_warmup_score: a.stat_warmup_score,
          timestamp_created: a.timestamp_created } as ManagedInstantlyAccount;
      }), { query: { limit: "100", starting_after: cursor } }));
    },
    listCampaigns() {
      return allPages(cursor => request("GET", "/campaigns", v => page(v, parseCampaign), { query: { limit: "100", starting_after: cursor } }));
    },
    getCampaign,
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
    getEmail(id: string) { return request("GET", `/emails/${inputId(id)}`, parseEmail); },
    async createPausedCampaign(input: PausedCampaignInput) {
      if (!input.name?.trim() || !input.subject?.trim() || !input.bodyText?.trim()) invalid("Campaign name, subject and body are required.");
      if (!Array.isArray(input.senderEmails) || input.senderEmails.length !== 1) invalid("Exactly one explicit sending account is required.");
      const senders = input.senderEmails.map(inputEmail);
      const html = input.bodyText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br/>");
      const campaign = await request("POST", "/campaigns", parseCampaign, { mutation: true, body: {
        name: input.name, email_list: senders,
        campaign_schedule: { schedules: [{ name: "US business hours", timing: { from: "09:00", to: "16:00" },
          days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
          timezone: input.timezone ?? "America/Detroit" }] },
        sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: input.subject, body: html }] }] }],
        daily_limit: 1, daily_max_leads: 1, email_gap: 15, random_wait_max: 0,
        stop_on_reply: true, stop_on_auto_reply: true, stop_for_company: true,
        insert_unsubscribe_header: true, allow_risky_contacts: false, disable_bounce_protect: false,
        text_only: true, first_email_text_only: true, open_tracking: false, link_tracking: false,
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
    async activateCampaign(campaignId: string, guard: { preflightCheckedAt: string; expectedRecipientEmail: string }): Promise<ManagedInstantlyCampaign> {
      const blocked = (message: string): never => { throw new ManagedInstantlyError(message, { code: "launch_blocked" }); };
      const assertFresh = () => {
        const at = Date.parse(guard?.preflightCheckedAt);
        if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 60_000) blocked("Fresh external exclusions and eligibility checks are required immediately before dispatch.");
      };
      assertFresh();
      const expected = inputEmail(guard.expectedRecipientEmail);
      const campaign = await getCampaign(campaignId);
      const steps = campaign.sequences?.[0]?.steps;
      if (campaign.id !== campaignId || ![0, 2].includes(campaign.status)
        || campaign.stop_on_reply !== true || campaign.stop_on_auto_reply !== true || campaign.stop_for_company !== true
        || campaign.email_list?.length !== 1 || campaign.sequences?.length !== 1
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
