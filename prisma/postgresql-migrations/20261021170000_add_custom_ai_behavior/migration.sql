-- AlterTable
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "tonePreset" VARCHAR(50) DEFAULT 'friendly';
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "customInstructions" TEXT;
ALTER TABLE "AiAssistantConfig" ADD COLUMN IF NOT EXISTS "customRestrictions" TEXT;
