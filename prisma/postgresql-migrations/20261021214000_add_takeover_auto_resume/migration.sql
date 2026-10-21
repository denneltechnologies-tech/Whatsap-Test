-- AlterTable
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "autoResumeMinutes" INTEGER DEFAULT 10;
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "autoResumeMessage" TEXT;

-- AlterTable
ALTER TABLE "AiConversationState" ADD COLUMN IF NOT EXISTS "takeoverAt" TIMESTAMP;
