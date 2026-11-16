-- Optional Gather API key per workspace (encrypted), used for synthetic research on landing pages
ALTER TABLE "Workspace" ADD COLUMN "gatherApiKey" TEXT;
