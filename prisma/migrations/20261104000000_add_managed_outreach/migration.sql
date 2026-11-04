-- Additive managed-outreach state; existing application tables are unchanged.
CREATE TABLE "ManagedOutreachJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyDomain" TEXT NOT NULL,
    "candidateJson" TEXT NOT NULL,
    "stepsJson" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "providerCampaignId" TEXT,
    "sequenceFingerprint" TEXT,
    "nextStep" INTEGER NOT NULL DEFAULT 1,
    "dueAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ManagedOutreachJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManagedOutreachEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagedOutreachEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManagedOutreachJob_providerCampaignId_key" ON "ManagedOutreachJob"("providerCampaignId");
CREATE UNIQUE INDEX "ManagedOutreachJob_workspaceId_externalId_key" ON "ManagedOutreachJob"("workspaceId", "externalId");
CREATE UNIQUE INDEX "ManagedOutreachJob_workspaceId_email_key" ON "ManagedOutreachJob"("workspaceId", "email");
CREATE INDEX "ManagedOutreachJob_workspaceId_status_dueAt_idx" ON "ManagedOutreachJob"("workspaceId", "status", "dueAt");
CREATE INDEX "ManagedOutreachEvent_workspaceId_type_occurredAt_idx" ON "ManagedOutreachEvent"("workspaceId", "type", "occurredAt");
CREATE INDEX "ManagedOutreachEvent_jobId_occurredAt_idx" ON "ManagedOutreachEvent"("jobId", "occurredAt");

ALTER TABLE "ManagedOutreachJob" ADD CONSTRAINT "ManagedOutreachJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagedOutreachEvent" ADD CONSTRAINT "ManagedOutreachEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ManagedOutreachJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ManagedOutreachEvent" ADD CONSTRAINT "ManagedOutreachEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
