-- AlterTable
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "adminNotificationPhone" VARCHAR(50);
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "notifyOnTakeover" BOOLEAN NOT NULL DEFAULT true;
