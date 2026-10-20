-- CreateTable
CREATE TABLE "AiAssistantConfig" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "assistantName" VARCHAR(100) NOT NULL DEFAULT 'AI Assistant',
    "businessName" VARCHAR(100) NOT NULL DEFAULT 'My Business',
    "businessDescription" TEXT,
    "businessHours" TEXT,
    "supportedLanguages" VARCHAR(100) DEFAULT 'en, es, pt',
    "systemPrompt" TEXT,
    "fallbackResponse" TEXT,
    "humanTakeoverKeywords" VARCHAR(500) DEFAULT 'human, agent, attendant, atendente, humano, support',
    "provider" VARCHAR(50) NOT NULL DEFAULT 'openai',
    "model" VARCHAR(100) NOT NULL DEFAULT 'gpt-4o-mini',
    "apiUrl" VARCHAR(500),
    "apiKey" VARCHAR(500),
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "maxTokens" INTEGER NOT NULL DEFAULT 600,
    "embeddingProvider" VARCHAR(50) NOT NULL DEFAULT 'openai',
    "embeddingModel" VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
    "embeddingApiUrl" VARCHAR(500),
    "embeddingApiKey" VARCHAR(500),
    "ragTopK" INTEGER NOT NULL DEFAULT 4,
    "ragMinScore" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "maxContextMessages" INTEGER NOT NULL DEFAULT 8,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "AiAssistantConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "fileName" VARCHAR(255),
    "fileType" VARCHAR(50),
    "fileSize" INTEGER,
    "sourceUrl" VARCHAR(1000),
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" JSONB,
    "tokenCount" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversationState" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "remoteJid" VARCHAR(100) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'bot',
    "needsHumanAttention" BOOLEAN NOT NULL DEFAULT false,
    "takeoverReason" VARCHAR(255),
    "lastCustomerMessageAt" TIMESTAMP,
    "lastAiReplyAt" TIMESTAMP,
    "lastHumanReplyAt" TIMESTAMP,
    "aiReplyCount" INTEGER NOT NULL DEFAULT 0,
    "humanReplyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "AiConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessageLog" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "remoteJid" VARCHAR(100) NOT NULL,
    "providerMessageId" VARCHAR(255),
    "direction" VARCHAR(20) NOT NULL,
    "senderType" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL,
    "ragSources" JSONB,
    "tokensUsed" INTEGER,
    "latencyMs" INTEGER,
    "error" TEXT,
    "status" VARCHAR(30) DEFAULT 'delivered',
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAssistantConfig_instanceId_key" ON "AiAssistantConfig"("instanceId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_instanceId_idx" ON "KnowledgeDocument"("instanceId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_instanceId_idx" ON "KnowledgeChunk"("instanceId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "AiConversationState_instanceId_remoteJid_key" ON "AiConversationState"("instanceId", "remoteJid");

-- CreateIndex
CREATE INDEX "AiConversationState_instanceId_idx" ON "AiConversationState"("instanceId");

-- CreateIndex
CREATE INDEX "AiConversationState_remoteJid_idx" ON "AiConversationState"("remoteJid");

-- CreateIndex
CREATE INDEX "AiMessageLog_instanceId_idx" ON "AiMessageLog"("instanceId");

-- CreateIndex
CREATE INDEX "AiMessageLog_remoteJid_idx" ON "AiMessageLog"("remoteJid");

-- CreateIndex
CREATE INDEX "AiMessageLog_providerMessageId_idx" ON "AiMessageLog"("providerMessageId");

-- AddForeignKey
ALTER TABLE "AiAssistantConfig" ADD CONSTRAINT "AiAssistantConfig_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversationState" ADD CONSTRAINT "AiConversationState_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessageLog" ADD CONSTRAINT "AiMessageLog_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
