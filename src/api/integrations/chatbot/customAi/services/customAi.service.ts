import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, CustomAi as CustomAiEnv } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { AiAssistantConfig } from '@prisma/client';
import axios from 'axios';

import { DeduplicationService } from './deduplication.service';
import { RagService } from './rag.service';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class CustomAiService {
  private readonly logger = new Logger('CustomAiService');
  public readonly ragService: RagService;
  public readonly deduplicationService: DeduplicationService;

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {
    this.ragService = new RagService(prismaRepository);
    this.deduplicationService = new DeduplicationService(prismaRepository);
  }

  /**
   * Loads or creates default assistant configuration for an instance
   */
  public async getOrCreateConfig(instanceId: string): Promise<AiAssistantConfig> {
    let config = await this.prismaRepository.aiAssistantConfig.findUnique({
      where: { instanceId },
    });

    if (!config) {
      const env = this.configService.get<CustomAiEnv>('CUSTOM_AI');
      config = await this.prismaRepository.aiAssistantConfig.create({
        data: {
          instanceId,
          enabled: env?.ENABLED ?? true,
          assistantName: 'Customer Support AI',
          businessName: env?.BUSINESS_NAME || 'Our Business',
          businessDescription: 'Providing quality products and excellent customer care.',
          businessHours: 'Monday - Friday: 9:00 AM - 6:00 PM',
          supportedLanguages: 'en, es, pt',
          systemPrompt:
            env?.SYSTEM_PROMPT ||
            'You are a professional customer support assistant. Answer customer questions accurately using the provided knowledge base facts. Never invent policies, prices, or services. If you cannot answer based on the knowledge base, politely state that you do not have that information and offer to transfer them to a human agent.',
          fallbackResponse:
            "I'm sorry, but I don't have enough information to answer that question accurately. Let me connect you with a member of our team.",
          humanTakeoverKeywords: 'human, agent, attendant, atendente, humano, support, representative',
          adminNotificationPhone: null,
          notifyOnTakeover: true,
          provider: env?.PROVIDER || 'openai',
          model: env?.MODEL || 'gpt-4o-mini',
          apiUrl: env?.API_URL || 'https://api.openai.com/v1',
          apiKey: env?.API_KEY || '',
          temperature: 0.3,
          maxTokens: 600,
          embeddingProvider: env?.EMBEDDING_PROVIDER || 'openai',
          embeddingModel: env?.EMBEDDING_MODEL || 'text-embedding-3-small',
          embeddingApiUrl: env?.EMBEDDING_API_URL || 'https://api.openai.com/v1',
          embeddingApiKey: env?.EMBEDDING_API_KEY || env?.API_KEY || '',
          ragTopK: 4,
          ragMinScore: 0.35,
          maxContextMessages: 8,
        },
      });
    }

    return config;
  }

  /**
   * Checks if customer message triggers human takeover
   */
  public checkForHumanTakeoverTrigger(text: string, keywordsStr?: string): boolean {
    if (!text || !keywordsStr) return false;

    const lower = text.toLowerCase();
    const keywords = keywordsStr
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);

    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Main entrypoint for processing an incoming WhatsApp message
   */
  public async handleIncomingMessage(
    instanceName: string,
    instanceId: string,
    remoteJid: string,
    messageId: string,
    messageText: string,
    pushName?: string,
    fromMe = false,
  ): Promise<void> {
    // 1. Never reply to messages sent by the bot itself
    if (fromMe) {
      this.logger.debug(`Ignoring message from me: ${messageId}`);
      // An admin sent a message from WhatsApp: automatically record and mark human reply
      await this.recordHumanActivity(instanceId, remoteJid, messageText);
      return;
    }

    // 2. Ignore group chats and status broadcasts
    if (remoteJid.endsWith('@g.us') || remoteJid.includes('status@broadcast')) {
      this.logger.debug(`Ignoring group or status message: ${remoteJid}`);
      return;
    }

    // 3. Ignore empty text or media without text
    if (!messageText || messageText.trim() === '') {
      this.logger.debug(`Ignoring empty text message: ${messageId}`);
      return;
    }

    // 4. Deduplicate incoming event by message ID
    const acquired = await this.deduplicationService.acquireLock(messageId);
    if (!acquired) {
      this.logger.warn(`Dropping duplicate event for message ${messageId}`);
      return;
    }

    try {
      // 5. Check if AI assistant is enabled for this instance
      const config = await this.getOrCreateConfig(instanceId);
      if (!config.enabled) {
        this.logger.debug(`AI Assistant is disabled for instance ${instanceName}`);
        this.deduplicationService.markProcessed(messageId);
        return;
      }

      // 6. Check Conversation State (Human Takeover / Paused)
      let convState = await this.prismaRepository.aiConversationState.findUnique({
        where: {
          instanceId_remoteJid: {
            instanceId,
            remoteJid,
          },
        },
      });

      if (!convState) {
        convState = await this.prismaRepository.aiConversationState.create({
          data: {
            instanceId,
            remoteJid,
            status: 'bot',
            lastCustomerMessageAt: new Date(),
          },
        });
      } else {
        await this.prismaRepository.aiConversationState.update({
          where: { id: convState.id },
          data: { lastCustomerMessageAt: new Date() },
        });
      }

      // Check if takeover was triggered by customer keywords
      const requestedHuman = this.checkForHumanTakeoverTrigger(messageText, config.humanTakeoverKeywords);
      if (requestedHuman && convState.status !== 'human_takeover') {
        this.logger.info(`Customer ${remoteJid} requested human takeover`);
        await this.prismaRepository.aiConversationState.update({
          where: { id: convState.id },
          data: {
            status: 'human_takeover',
            needsHumanAttention: true,
            takeoverReason: 'Customer requested human agent',
          },
        });

        // Send handoff acknowledgment to customer
        const handoffText = "I have flagged this conversation for a human team member. Someone will be with you shortly!";
        await this.sendWhatsAppReply(instanceName, remoteJid, handoffText);

        // Alert the business manager/owner on WhatsApp if configured
        await this.sendAdminTakeoverAlert(instanceName, config, remoteJid, pushName, messageText);

        await this.logMessage({
          instanceId,
          remoteJid,
          providerMessageId: messageId,
          direction: 'incoming',
          senderType: 'customer',
          content: messageText,
        });

        this.deduplicationService.markProcessed(messageId);
        return;
      }

      // If conversation is paused or handled by a human, do NOT reply automatically
      if (convState.status === 'human_takeover' || convState.status === 'paused') {
        this.logger.info(`AI reply suppressed for ${remoteJid}: status is ${convState.status}`);
        
        // Ensure needsHumanAttention is kept active for new incoming messages during takeover
        if (convState.status === 'human_takeover') {
          await this.prismaRepository.aiConversationState.update({
            where: { id: convState.id },
            data: {
              needsHumanAttention: true,
              lastCustomerMessageAt: new Date(),
            },
          });
        }

        await this.logMessage({
          instanceId,
          remoteJid,
          providerMessageId: messageId,
          direction: 'incoming',
          senderType: 'customer',
          content: messageText,
        });
        this.deduplicationService.markProcessed(messageId);
        return;
      }

      // 7. Log customer's incoming message
      await this.logMessage({
        instanceId,
        remoteJid,
        providerMessageId: messageId,
        direction: 'incoming',
        senderType: 'customer',
        content: messageText,
      });

      // 8. Retrieve relevant business knowledge (RAG)
      const retrievedChunks = await this.ragService.retrieveRelevantChunks(
        instanceId,
        messageText,
        config.ragTopK || 4,
        config.ragMinScore || 0.35,
        {
          provider: config.embeddingProvider,
          model: config.embeddingModel,
          apiUrl: config.embeddingApiUrl,
          apiKey: config.embeddingApiKey || config.apiKey,
        },
      );

      // 9. Generate AI Response
      const startTime = Date.now();
      const aiResponse = await this.generateAiResponse(config, remoteJid, messageText, pushName, retrievedChunks);
      const latencyMs = Date.now() - startTime;

      // 10. Send reply via Evolution API WhatsApp client
      await this.sendWhatsAppReply(instanceName, remoteJid, aiResponse.reply);

      // 11. Record AI response in DB and update conversation state
      await this.logMessage({
        instanceId,
        remoteJid,
        direction: 'outgoing',
        senderType: 'ai',
        content: aiResponse.reply,
        ragSources: retrievedChunks.map((c) => ({ id: c.id, title: c.documentTitle, score: c.score })),
        tokensUsed: aiResponse.tokensUsed,
        latencyMs,
      });

      await this.prismaRepository.aiConversationState.update({
        where: { id: convState.id },
        data: {
          lastAiReplyAt: new Date(),
          aiReplyCount: { increment: 1 },
        },
      });

      this.deduplicationService.markProcessed(messageId);
    } catch (error: any) {
      this.logger.error(`Error in handleIncomingMessage: ${error.message}`);
      this.deduplicationService.releaseLock(messageId);
    }
  }

  /**
   * When an administrator sends a message directly on WhatsApp, record it and pause AI
   */
  private async recordHumanActivity(instanceId: string, remoteJid: string, text: string): Promise<void> {
    try {
      const convState = await this.prismaRepository.aiConversationState.findUnique({
        where: { instanceId_remoteJid: { instanceId, remoteJid } },
      });

      if (convState) {
        await this.prismaRepository.aiConversationState.update({
          where: { id: convState.id },
          data: {
            status: 'human_takeover',
            lastHumanReplyAt: new Date(),
            humanReplyCount: { increment: 1 },
          },
        });
      }

      await this.logMessage({
        instanceId,
        remoteJid,
        direction: 'outgoing',
        senderType: 'human',
        content: text,
      });
    } catch (err: any) {
      this.logger.error(`Error recording human activity: ${err.message}`);
    }
  }

  /**
   * Generates AI completion using configured provider and RAG context
   */
  private async generateAiResponse(
    config: AiAssistantConfig,
    remoteJid: string,
    userQuery: string,
    pushName?: string,
    chunks: any[] = [],
  ): Promise<{ reply: string; tokensUsed?: number }> {
    const apiKey = config.apiKey || this.configService.get<CustomAiEnv>('CUSTOM_AI')?.API_KEY;
    const apiUrl = config.apiUrl || this.configService.get<CustomAiEnv>('CUSTOM_AI')?.API_URL || 'https://api.openai.com/v1';
    const model = config.model || this.configService.get<CustomAiEnv>('CUSTOM_AI')?.MODEL || 'gpt-4o-mini';

    // Format grounding context
    const ragContext = this.ragService.formatContextForPrompt(chunks);

    // Business identity info
    let businessBlock = `Business Name: ${config.businessName}\n`;
    if (config.businessDescription) businessBlock += `About Us: ${config.businessDescription}\n`;
    if (config.businessHours) businessBlock += `Opening Hours: ${config.businessHours}\n`;
    if (config.supportedLanguages) businessBlock += `Supported Languages: ${config.supportedLanguages}\n`;

    const systemPromptContent = [
      config.systemPrompt || 'You are a helpful customer service representative.',
      '',
      businessBlock,
      ragContext,
      '',
      `Customer Name: ${pushName || 'Valued Customer'}`,
      'Instructions:',
      '- Respond politely, concisely, and warmly in the language used by the customer.',
      '- Keep responses clear, readable on a phone screen, and directly address the question.',
      '- If the customer greets you (e.g. "hello", "hi", "good morning"), welcome them warmly to the business and ask how you can assist them.',
      '- If a specific business question cannot be answered using the Business Knowledge Base above, do not invent answers. State that you do not have that information and offer human assistance.',
    ].join('\n');

    // Retrieve previous conversation context
    const history = await this.getConversationHistory(config.instanceId, remoteJid, config.maxContextMessages || 8);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptContent },
      ...history,
      { role: 'user', content: userQuery },
    ];

    if (!apiKey || apiKey.trim() === '') {
      this.logger.warn('No AI API key configured. Returning knowledge-based answer or fallback.');
      if (chunks.length > 0) {
        return {
          reply: `Based on our business records:\n\n${chunks[0].content}\n\nCan I help you with anything else?`,
        };
      }
      return {
        reply: config.fallbackResponse || "Hello! How can our team assist you today?",
      };
    }

    try {
      const cleanBaseUrl = apiUrl.replace(/\/+$/, '');
      const endpoint = cleanBaseUrl.endsWith('/chat/completions')
        ? cleanBaseUrl
        : `${cleanBaseUrl}/chat/completions`;

      const response = await axios.post(
        endpoint,
        {
          model,
          messages,
          temperature: config.temperature ?? 0.3,
          max_tokens: config.maxTokens ?? 600,
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 25000,
        },
      );

      const reply = response.data?.choices?.[0]?.message?.content?.trim();
      const tokensUsed = response.data?.usage?.total_tokens;

      if (!reply) {
        throw new Error('Empty response from AI chat completions API');
      }

      return { reply, tokensUsed };
    } catch (error: any) {
      this.logger.error(`AI Provider error (${model}): ${error.response?.data?.error?.message || error.message}`);
      return {
        reply:
          config.fallbackResponse ||
          "I apologize, but I am having trouble retrieving that information right now. An agent will follow up with you shortly.",
      };
    }
  }

  /**
   * Retrieves recent message history for context window
   */
  private async getConversationHistory(instanceId: string, remoteJid: string, limit = 8): Promise<ChatMessage[]> {
    try {
      const logs = await (this.prismaRepository as any).aiMessageLog.findMany({
        where: {
          instanceId,
          remoteJid,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      const history: ChatMessage[] = [];
      // reverse to chronological order
      logs.reverse().forEach((log) => {
        if (log.senderType === 'customer') {
          history.push({ role: 'user', content: log.content });
        } else if (log.senderType === 'ai' || log.senderType === 'human') {
          history.push({ role: 'assistant', content: log.content });
        }
      });

      return history;
    } catch {
      return [];
    }
  }

  /**
   * Sends text message to customer via Evolution API instance
   */
  public async sendWhatsAppReply(instanceName: string, remoteJid: string, text: string): Promise<void> {
    const waInstance = this.waMonitor.waInstances[instanceName];
    if (!waInstance) {
      this.logger.error(`WhatsApp instance ${instanceName} not found in waMonitor`);
      return;
    }

    const number = remoteJid.includes('@lid') ? remoteJid : remoteJid.split('@')[0];

    try {
      // 1. Presence indicator: Composing
      if (waInstance.integration === Integration.WHATSAPP_BAILEYS && waInstance.client) {
        try {
          await waInstance.client.presenceSubscribe(remoteJid);
          await waInstance.client.sendPresenceUpdate('composing', remoteJid);
        } catch {
          // Non-critical presence update error
        }
      }

      // 2. Realistic typing delay (min 1s, max 4s)
      const typingDelay = Math.min(Math.max(text.length * 20, 1000), 4000);
      await new Promise((resolve) => setTimeout(resolve, typingDelay));

      // 3. Send message through existing Evolution API channel
      await waInstance.textMessage(
        {
          number,
          text,
          delay: 1000,
          linkPreview: true,
        },
        false,
      );

      // 4. Presence indicator: Paused
      if (waInstance.integration === Integration.WHATSAPP_BAILEYS && waInstance.client) {
        try {
          await waInstance.client.sendPresenceUpdate('paused', remoteJid);
        } catch {
          // Non-critical
        }
      }
    } catch (err: any) {
      this.logger.error(`Failed to send WhatsApp message to ${remoteJid}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Dispatches a WhatsApp notification alert to the configured manager phone number
   * when a customer requests human takeover or flags attention
   */
  public async sendAdminTakeoverAlert(
    instanceName: string,
    config: any,
    customerJid: string,
    customerName?: string,
    triggerMessage?: string,
  ): Promise<void> {
    try {
      if (!config?.notifyOnTakeover || !config?.adminNotificationPhone) {
        return;
      }

      const adminDigits = config.adminNotificationPhone.replace(/\D/g, '');
      if (!adminDigits || adminDigits.length < 8) {
        this.logger.warn(`Admin notification phone '${config.adminNotificationPhone}' is invalid`);
        return;
      }

      // Avoid self-alert loop if admin happens to be chatting with the bot
      const customerDigits = customerJid.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
      if (adminDigits === customerDigits) {
        this.logger.debug(`Skipping admin alert: customer phone is identical to admin notification phone`);
        return;
      }

      const displayName = customerName ? `${customerName} (+${customerDigits})` : `+${customerDigits}`;
      const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      const alertText =
        `🚨 *[Evolution AI Alert] Human Takeover Requested!*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Customer:* ${displayName}\n` +
        `🏢 *Business:* ${config.businessName || instanceName}\n` +
        `⏰ *Time:* ${timeStr}\n` +
        `💬 *Message:* "${triggerMessage || 'Customer requested human agent'}"\n\n` +
        `⚠️ *Action Required:* Auto-replies have been paused for this customer. Log into your dashboard to reply directly.`;

      const targetJid = `${adminDigits}@s.whatsapp.net`;
      await this.sendWhatsAppReply(instanceName, targetJid, alertText);
      this.logger.info(`Takeover alert dispatched to WhatsApp +${adminDigits} for customer ${displayName}`);
    } catch (err: any) {
      this.logger.error(`Failed to send admin takeover alert: ${err.message}`);
    }
  }

  /**
   * Logs a message in the database
   */
  public async logMessage(data: {
    instanceId: string;
    remoteJid: string;
    providerMessageId?: string;
    direction: 'incoming' | 'outgoing';
    senderType: 'customer' | 'ai' | 'human';
    content: string;
    ragSources?: any;
    tokensUsed?: number;
    latencyMs?: number;
    error?: string;
  }): Promise<void> {
    try {
      await (this.prismaRepository as any).aiMessageLog.create({
        data: {
          instanceId: data.instanceId,
          remoteJid: data.remoteJid,
          providerMessageId: data.providerMessageId,
          direction: data.direction,
          senderType: data.senderType,
          content: data.content,
          ragSources: data.ragSources,
          tokensUsed: data.tokensUsed,
          latencyMs: data.latencyMs,
          error: data.error,
          status: 'delivered',
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed to record message log: ${err.message}`);
    }
  }
}
