import { createHash } from "node:crypto";
import type { ManagedOutreachEvent, ManagedOutreachJob } from "@prisma/client";
import { canonicalInstantlyHtml, fingerprintCampaignSequence, ManagedInstantlyError, type ManagedInstantlyClient } from "./instantly";
import { parseManagedImport, renderManagedBody, type ManagedDispatchConfig } from "./orchestrator";

function data(event: ManagedOutreachEvent): Record<string, unknown> {
  try { return JSON.parse(event.dataJson); } catch { return {}; }
}
/** Provider reads only. An uncertain stage is recoverable only from exact evidence. */
export async function inspectManagedStage(job: ManagedOutreachJob, events: ManagedOutreachEvent[], client: ManagedInstantlyClient, config: ManagedDispatchConfig) {
  if (!job.providerCampaignId) throw new Error("Known provider campaign is required.");
  const reasons: string[] = [];
  if (job.status !== "uncertain" || job.nextStep !== 1 || job.leaseToken || job.leaseUntil) reasons.push("Only an unleased uncertain first stage can be reconciled.");
  if (events.some(event => ["sent", "activation_attempted", "activation_queued", "incoming_received", "replied", "positive_reply", "meeting_request", "demo_booked", "unsubscribed", "unsubscribe", "delivery_failure", "bounced", "complained"].includes(event.type))) reasons.push("Send, activation or stop evidence already exists; stage recovery is not permitted.");
  const stageAttempt = [...events].reverse().find(event => event.type === "preflight_checked" && data(event).action === "stage" && data(event).step === 1);
  if (!stageAttempt) reasons.push("Original stage preflight evidence is missing.");
  const saved = parseManagedImport({ externalId: job.externalId, candidate: JSON.parse(job.candidateJson), steps: JSON.parse(job.stepsJson),
    senderEmail: job.senderEmail, experimentId: job.experimentId, variant: job.variant }, config);
  if (saved.candidate.email.toLowerCase() !== job.email || saved.candidate.companyDomain.toLowerCase() !== job.companyDomain) reasons.push("Saved recipient identity differs from this job.");
  const renderAt = stageAttempt?.occurredAt ?? job.updatedAt;
  const rendered = renderManagedBody(saved.steps[0].body, renderAt, saved.candidate.recipientTimezone, config.footer);
  const [campaign, leads, campaignMail, recipientMail] = await Promise.all([
    client.getCampaign(job.providerCampaignId), client.listCampaignLeads(job.providerCampaignId),
    client.listEmails({ campaignId: job.providerCampaignId }), client.listEmails({ leadEmail: job.email }),
  ]);
  if (campaign.id !== job.providerCampaignId || campaign.name !== `Gather managed ${job.id} ${job.variant}` || campaign.status !== 2
    || campaign.email_list?.length !== 1 || campaign.email_list[0].toLowerCase() !== job.senderEmail
    || (campaign.email_tag_list?.length ?? 0) !== 0 || campaign.stop_on_reply !== true || campaign.stop_on_auto_reply !== true || campaign.stop_for_company !== true) reasons.push("Campaign identity, paused status, sender or stop protections differ from the saved stage.");
  let actualFingerprint: string | null = null;
  let sequenceValidationFailure: string | null = null;
  try { actualFingerprint = fingerprintCampaignSequence(campaign); } catch (error) {
    // These messages are local validation constants, never a provider response body.
    sequenceValidationFailure = error instanceof ManagedInstantlyError ? error.message : "Sequence validation failed.";
    reasons.push("Provider sequence is not a valid managed sequence.");
  }
  const actualStep = campaign.sequences?.[0]?.steps?.[0];
  const expectedFingerprint = fingerprintCampaignSequence({ ...campaign, sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: saved.steps[0].subject, body: rendered.html }] }] }] });
  const expectedSequenceMatches = actualFingerprint === expectedFingerprint;
  const recoverableEmptyStage = reasons.length === 0 && expectedSequenceMatches && !job.sequenceFingerprint && leads.length === 0
    && campaignMail.length === 0 && recipientMail.length === 0
    && !events.some(event => ["stage_resume_authorized", "provider_mutation_diagnostic", "staged"].includes(event.type));
  if (!job.sequenceFingerprint || actualFingerprint !== job.sequenceFingerprint || campaign.sequences?.[0]?.steps?.length !== 1
    || !expectedSequenceMatches) reasons.push("Provider subject, body or sequence fingerprint differs from the saved draft.");
  const lead = leads[0];
  if (leads.length !== 1 || lead?.email?.toLowerCase() !== job.email || lead?.campaign !== job.providerCampaignId || lead?.status !== 1
    || lead?.email_reply_count !== 0 || lead?.timestamp_last_contact || lead?.timestamp_last_reply || [2, 3, 4, -1, -2, -3, -4].includes(lead?.lt_interest_status ?? 999)) reasons.push("Exactly one untouched, eligible verified recipient must already exist; no upload will be retried.");
  const messages = Array.from(new Map([...campaignMail, ...recipientMail].map(mail => [mail.id, mail])).values());
  if (messages.length) reasons.push("Provider message history exists for this campaign or recipient; keep the job held.");
  const stageData = { provider: "instantly", campaignId: job.providerCampaignId, step: 1, experimentId: job.experimentId, variant: job.variant,
    localDate: rendered.localDate, bodyHash: rendered.bodyHash, sequenceFingerprint: actualFingerprint, recovered: true,
    source: "Instantly GET campaign + complete campaign lead and message pagination", providerLeadId: lead?.id ?? null };
  const proofFingerprint = createHash("sha256").update(JSON.stringify({ jobId: job.id, updatedAt: job.updatedAt.toISOString(), stageData, leads: leads.map(item => item.id), messageIds: messages.map(item => item.id) })).digest("hex");
  return { jobId: job.id, status: job.status, providerCampaignId: job.providerCampaignId, reconcilable: reasons.length === 0, recoverableEmptyStage, reasons,
    checkedAt: new Date().toISOString(), proofFingerprint, stageData,
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, senderEmails: campaign.email_list, sequenceFingerprint: actualFingerprint,
      stepCount: campaign.sequences?.[0]?.steps?.length ?? null, subjectMatches: actualStep?.variants?.[0]?.subject === saved.steps[0].subject,
      bodyMatches: typeof actualStep?.variants?.[0]?.body === "string" && canonicalInstantlyHtml(actualStep.variants[0].body) === canonicalInstantlyHtml(rendered.html),
      // Owner-authenticated diagnostics for this job's own outbound copy only.
      sequences: campaign.sequences, expectedFirstStep: { subject: saved.steps[0].subject, body: rendered.html }, sequenceValidationFailure },
    leads: leads.map(item => ({ id: item.id, email: item.email, campaign: item.campaign, status: item.status, email_reply_count: item.email_reply_count,
      timestamp_last_contact: item.timestamp_last_contact, timestamp_last_reply: item.timestamp_last_reply, lt_interest_status: item.lt_interest_status })),
    messageReceipts: messages.map(item => ({ id: item.id, message_id: item.message_id, timestamp_created: item.timestamp_created, ue_type: item.ue_type, campaign_id: item.campaign_id })),
    stageAudit: events.map(event => ({ id: event.id, type: event.type, occurredAt: event.occurredAt.toISOString(), providerMessageId: event.providerMessageId,
      action: data(event).action, step: data(event).step, sequenceFingerprint: data(event).sequenceFingerprint, bodyHash: data(event).bodyHash,
      ...(event.type === "provider_mutation_diagnostic" ? { phase: data(event).phase, errorClass: data(event).errorClass,
        providerCode: data(event).providerCode, providerHttpStatus: data(event).providerHttpStatus,
        providerOutcomeUnknown: data(event).providerOutcomeUnknown, uploadCounts: data(event).uploadCounts } : {}) })) };
}
