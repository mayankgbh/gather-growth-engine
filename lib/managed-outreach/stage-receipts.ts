import type { ManagedOutreachEvent, ManagedOutreachJob } from "@prisma/client";

/** Select an immutable receipt for the actual saved sequence, including refreshed first drafts. */
export function selectManagedStageReceipt(events: ManagedOutreachEvent[], job: Pick<ManagedOutreachJob, "id" | "nextStep" | "providerCampaignId" | "sequenceFingerprint" | "experimentId" | "variant">) {
  const base = `managed:staged:${job.id}:${job.nextStep}`;
  return events.filter(event => {
    if (event.type !== "staged" || (event.id !== base && !(job.nextStep === 1 && event.id.startsWith(`${base}:refresh:`)
      && /^\d{4}-\d{2}-\d{2}:[a-f0-9]{64}$/.test(event.id.slice(`${base}:refresh:`.length))))) return false;
    try {
      const data = JSON.parse(event.dataJson);
      return data.provider === "instantly" && data.campaignId === job.providerCampaignId && data.step === job.nextStep
        && data.sequenceFingerprint === job.sequenceFingerprint && data.experimentId === job.experimentId && data.variant === job.variant;
    } catch { return false; }
  }).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))[0];
}
