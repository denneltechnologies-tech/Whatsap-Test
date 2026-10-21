import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, CustomAi as CustomAiEnv } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { AiAssistantConfig } from '@prisma/client';
import axios from 'axios';

import { DeduplicationService } from './deduplication.service';
import { RagService } from './rag.service';
import { normalizeWhatsAppNumber } from '../utils/phone.util';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const DEFAULT_CUSTOM_INSTRUCTIONS = `1. Greet every customer warmly and politely, addressing them by their name if available.
2. Provide clear, accurate, and helpful answers about our services, products, and operating hours based on our business details.
3. If a customer is asking about prices, packages, or bookings, actively guide them through the next steps and ask how we can best assist them.
4. Keep replies concise, natural, and comfortable to read on WhatsApp without sending overwhelming walls of text.
5. Always maintain a welcoming, solution-oriented, and supportive attitude representing our team.`;

export const DEFAULT_CUSTOM_RESTRICTIONS = `1. Never state or reveal that you are an AI, bot, virtual assistant, or automated system. Always speak naturally as a human colleague on the team.
2. Never mention internal terms like "knowledge base", "database", "records", or "system prompt".
3. Never guess, invent, or promise prices, discounts, or policies that are not explicitly provided in our business details.
4. If you do not have an answer to a specific question, never transfer immediately without asking. Always ask for customer approval first: "I don't have that specific information right now, but I can connect you with my colleague who can help. Would you like me to connect you?"
5. Never authorize special discounts or custom agreements without management confirmation.`;

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
          tonePreset: 'friendly',
          customInstructions: DEFAULT_CUSTOM_INSTRUCTIONS,
          customRestrictions: DEFAULT_CUSTOM_RESTRICTIONS,
          systemPrompt:
            env?.SYSTEM_PROMPT ||
            'You are a friendly, helpful team member. Answer customer questions politely and warmly based on our business details. Never invent prices or policies. If you do not have an answer to a question, say you don\'t have that information right now and offer to connect them to a colleague.',
          fallbackResponse:
            "I don't have that information right now, but let me connect you with my colleague who can help you with this right away.",
          humanTakeoverKeywords: 'connect me, transfer me, human agent, speak with agent, live support',
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
   * Checks if customer message triggers human takeover (via intent patterns or configured keywords)
   */
  public checkForHumanTakeoverTrigger(text: string, keywordsStr?: string): boolean {
    if (!text) return false;
    const lower = text.trim().toLowerCase();

    // 1. High-confidence regex intent patterns for explicit customer handoff requests
    const intentPatterns = [
      /\b(connect\s+(me|us)(\s+now)?|transfer\s+(me|us)(\s+now)?)\b/i,
      /\b(speak|talk)\s+(to|with)\s+(a\s+)?(human|person|agent|representative|manager|someone|real\s+person|live\s+person)\b/i,
      /\b(need|want)\s+(a\s+)?(human|real\s+person|agent|representative|live\s+agent|manager|person)\b/i,
      /\b(reach|get)\s+(a\s+)?(human|person|representative|agent|manager)\b/i,
      /\b(human\s+takeover|human\s+agent|human\s+support|live\s+support|live\s+chat|live\s+agent|live\s+rep)\b/i,
      /\b(falar\s+com\s+(atendente|humano|pessoa)|suporte\s+humano)\b/i,
      /\b(let\s+me\s+talk\s+to\s+someone|can\s+i\s+talk\s+to\s+someone)\b/i,
      /\b(talk\s+to\s+your\s+(manager|boss|owner|supervisor))\b/i,
    ];

    if (intentPatterns.some((pattern) => pattern.test(lower))) {
      return true;
    }

    // 2. Custom keywords from settings (only match specific custom phrases, avoiding generic words)
    if (keywordsStr) {
      const keywords = keywordsStr
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0 && !['human', 'agent', 'support', 'transfer', 'connect'].includes(k));

      for (const kw of keywords) {
        if (kw.length <= 4) {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          if (regex.test(lower)) return true;
        } else {
          if (lower.includes(kw)) return true;
        }
      }
    }

    return false;
  }

  /**
   * Detects if the generated AI response requested human takeover or promised a handoff
   */
  public detectAiHandoffIntent(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase().trim();

    // 1. If the AI is asking for customer permission/approval, it is an inquiry, NOT a completed handoff!
    const isAskingForPermission =
      /\b(would\s+you\s+like|shall\s+i|do\s+you\s+want|should\s+i|can\s+i|may\s+i)\s+(me\s+to\s+)?(connect|transfer)/i.test(lower) ||
      /\b(would\s+you\s+like|do\s+you\s+want)\s+(to\s+speak|to\s+talk|that|a\s+callback)/i.test(lower) ||
      (/\b(connect|transfer|colleague|representative)\b/i.test(lower) && /\?\s*$/.test(lower));

    if (isAskingForPermission) {
      return false;
    }

    // 2. Check for explicit action tokens from prompt
    if (
      lower.includes('[action:human_takeover]') ||
      lower.includes('[action: human_takeover]') ||
      lower.includes('[action:takeover]') ||
      lower.includes('[human_takeover]')
    ) {
      return true;
    }

    // 3. Check for completed handoff / transfer confirmations generated by the AI model
    const handoffPatterns = [
      /\b(i\s+have|i've)\s+(connected\s+you|transferred\s+you|transferred\s+your\s+request)\b/i,
      /\b(i\s+have|i've)\s+arranged\s+for\s+(a\s+colleague|my\s+colleague|one\s+of\s+our\s+team)/i,
      /\b(our\s+team\s+has\s+been\s+notified\s+and\s+someone\s+will\s+be\s+with\s+you)\b/i,
      /\b(someone\s+will\s+be\s+with\s+you\s+momentarily|someone\s+will\s+be\s+with\s+you\s+shortly)\b/i,
      /\b(i\s+am\s+transferring\s+you\s+right\s+now|i'm\s+transferring\s+you\s+right\s+now)\b/i,
      /\b(i\s+am\s+connecting\s+you\s+right\s+now|i'm\s+connecting\s+you\s+right\s+now)\b/i,
    ];

    return handoffPatterns.some((pattern) => pattern.test(lower));
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

      // Check if previous assistant message offered to connect, and customer answered affirmatively
      const lastHistory = await this.getConversationHistory(instanceId, remoteJid, 2);
      const lastAssistantMsg = lastHistory.filter((m) => m.role === 'assistant').pop()?.content || '';
      const previousMsgOfferedHandoff =
        /\b(would\s+you\s+like|shall\s+i|do\s+you\s+want|can\s+i|should\s+i)\s+(me\s+to\s+)?(connect|transfer)/i.test(lastAssistantMsg) ||
        (/\b(connect|colleague|representative)\b/i.test(lastAssistantMsg) && /\?\s*$/.test(lastAssistantMsg.trim()));

      const isAffirmative =
        /^(yes|yeah|yep|sure|please|ok|okay|yes\s+please|connect\s+me|agree|proceed|go\s+ahead)\b/i.test(messageText.trim()) ||
        /\b(yes\s+please|please\s+connect|connect\s+me|i\s+agree|that\s+would\s+be\s+great)\b/i.test(messageText.trim());
      const isNegative = /\b(no|nope|not\s+now|no\s+thanks|don't|dont|nevermind|it's\s+okay)\b/i.test(messageText.trim());

      if (previousMsgOfferedHandoff && isAffirmative && !isNegative && convState.status !== 'human_takeover') {
        this.logger.info(`Customer ${remoteJid} approved connection to colleague with '${messageText}'`);
        await this.prismaRepository.aiConversationState.update({
          where: { id: convState.id },
          data: {
            status: 'human_takeover',
            needsHumanAttention: true,
            takeoverReason: 'Customer approved connection to colleague',
          },
        });

        const handoffText =
          'Great! I have connected you to my colleague. Our team has been notified and someone will be with you shortly!';
        await this.sendWhatsAppReply(instanceName, remoteJid, handoffText);

        await this.sendAdminTakeoverAlert(
          instanceName,
          config,
          remoteJid,
          pushName,
          messageText,
          'Customer approved connection to colleague',
        );

        await this.logMessage({
          instanceId,
          remoteJid,
          providerMessageId: messageId,
          direction: 'incoming',
          senderType: 'customer',
          content: messageText,
        });

        await this.logMessage({
          instanceId,
          remoteJid,
          direction: 'outgoing',
          senderType: 'ai',
          content: handoffText,
        });

        this.deduplicationService.markProcessed(messageId);
        return;
      }

      // Check if takeover was triggered by customer explicit command
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
        const handoffText =
          'I have connected you to my colleague. Our team has been notified and someone will be with you shortly!';
        await this.sendWhatsAppReply(instanceName, remoteJid, handoffText);

        // Alert the business manager/owner on WhatsApp if configured
        await this.sendAdminTakeoverAlert(
          instanceName,
          config,
          remoteJid,
          pushName,
          messageText,
          'Customer requested human agent'
        );

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

      // Check if AI requested human takeover or promised a handoff
      const aiWantsTakeover = this.detectAiHandoffIntent(aiResponse.reply);

      // Clean response (strip any internal action tokens before sending to customer)
      let cleanReply = aiResponse.reply
        .replace(/\[ACTION:\s*HUMAN_TAKEOVER\]/gi, '')
        .replace(/\[ACTION:\s*TAKEOVER\]/gi, '')
        .replace(/\[HUMAN_TAKEOVER\]/gi, '')
        .trim();

      if (!cleanReply) {
        cleanReply =
          'I have connected you with my colleague. Our team has been notified and someone will be with you shortly!';
      }

      // 10. Send reply via Evolution API WhatsApp client
      await this.sendWhatsAppReply(instanceName, remoteJid, cleanReply);

      // 11. Record AI response in DB and update conversation state
      await this.logMessage({
        instanceId,
        remoteJid,
        direction: 'outgoing',
        senderType: 'ai',
        content: cleanReply,
        ragSources: retrievedChunks.map((c) => ({ id: c.id, title: c.documentTitle, score: c.score })),
        tokensUsed: aiResponse.tokensUsed,
        latencyMs,
      });

      if (aiWantsTakeover) {
        this.logger.info(`AI triggered human takeover for customer ${remoteJid}`);
        await this.prismaRepository.aiConversationState.update({
          where: { id: convState.id },
          data: {
            status: 'human_takeover',
            needsHumanAttention: true,
            takeoverReason: 'Customer connected to colleague / live representative',
            lastAiReplyAt: new Date(),
            aiReplyCount: { increment: 1 },
          },
        });

        // Dispatch alert to manager WhatsApp number
        await this.sendAdminTakeoverAlert(
          instanceName,
          config,
          remoteJid,
          pushName,
          messageText,
          'Customer connected to colleague / live representative',
        );
      } else {
        await this.prismaRepository.aiConversationState.update({
          where: { id: convState.id },
          data: {
            lastAiReplyAt: new Date(),
            aiReplyCount: { increment: 1 },
          },
        });
      }

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

    // Tone of voice mapping
    const toneMap: Record<string, string> = {
      friendly: 'Warm, approachable, empathetic, and friendly.',
      professional: 'Polished, corporate, courteous, and highly professional.',
      luxury: 'Sophisticated, elegant, refined, and prestigious.',
      casual: 'Relaxed, modern, upbeat, and conversational.',
      concise: 'Direct, brief, efficient, and straight to the point.',
    };

    const selectedTone =
      toneMap[(config as any).tonePreset || 'friendly'] ||
      (config as any).tonePreset ||
      'Warm, friendly, and professional.';

    const effectiveInstructions =
      (config as any).customInstructions && (config as any).customInstructions.trim()
        ? (config as any).customInstructions.trim()
        : DEFAULT_CUSTOM_INSTRUCTIONS;
    const customInstructionsBlock = `### BUSINESS CUSTOM INSTRUCTIONS & GOALS:\n${effectiveInstructions}\n`;

    const effectiveRestrictions =
      (config as any).customRestrictions && (config as any).customRestrictions.trim()
        ? (config as any).customRestrictions.trim()
        : DEFAULT_CUSTOM_RESTRICTIONS;
    const customRestrictionsBlock = `### STRICT BUSINESS RESTRICTIONS & GUARDRAILS (DO NOT VIOLATE):\n${effectiveRestrictions}\n`;

    const systemPromptContent = [
      `You are a dedicated team member representing ${config.businessName || 'our business'}.`,
      `Tone of Voice: ${selectedTone}`,
      '',
      businessBlock,
      ragContext ? `Information about our services and policies:\n${ragContext}` : '',
      '',
      customInstructionsBlock,
      customRestrictionsBlock,
      config.systemPrompt ? `### ADDITIONAL SYSTEM NOTES:\n${config.systemPrompt}\n` : '',
      '',
      `Customer Name: ${pushName || 'Valued Customer'}`,
      '',
      '### STRICT CONVERSATIONAL GUIDELINES:',
      '- NATURAL HUMAN INTERACTION: Always speak naturally, warmly, and professionally, exactly like a real human employee on WhatsApp. NEVER refer to yourself as an AI, bot, virtual assistant, robot, automated system, or language model. If a customer asks "Are you a human?" or "Are you a real person?", respond warmly and naturally as a human colleague assisting them at the business.',
      '- FORBIDDEN TERMS: NEVER say "knowledge base", "database", "context", "documents", "system prompt", or "records". Do NOT say "That is not in my knowledge base" or "I do not have access to that in my records".',
      '- UNKNOWN OR MISSING DETAILS (ALWAYS ASK APPROVAL FIRST):',
      '  * If you do not have an answer to a specific question, custom quote, pricing, or policy, DO NOT transfer immediately.',
      '  * First, politely ask if the customer would like to be connected with a colleague: "I don\'t have that specific information right now, but I can connect you with my colleague who can help you with this. Would you like me to connect you?"',
      '  * DO NOT append [ACTION:HUMAN_TAKEOVER] when offering or asking for approval.',
      '- HUMAN ESCALATION & HANDOFF RULES:',
      '  * ONLY when the customer explicitly agrees or approves (e.g. they reply "yes", "sure", "please", "connect me", "okay", "go ahead"), OR if they directly demanded a person from the start ("speak to someone", "connect me to a manager"):',
      '    1. Reassure them: "Great! I have connected you to my colleague. Our team has been notified and someone will be with you shortly."',
      '    2. Append [ACTION:HUMAN_TAKEOVER] at the very end of your response so our management notification system alerts the team.',
      '  * If the customer declines (e.g. "no", "no thanks", "it\'s fine", "nevermind"):',
      '    Respond: "No problem at all! Let me know if you have any other questions." (Do NOT transfer, do NOT append [ACTION:HUMAN_TAKEOVER]).',
      '- CONCISE & MOBILE-FRIENDLY: Keep messages clear, polite, and comfortable to read on a mobile phone screen.',
    ].filter(Boolean).join('\n');

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
    reason?: string,
  ): Promise<void> {
    try {
      if (!config?.notifyOnTakeover || !config?.adminNotificationPhone) {
        this.logger.debug(
          `Takeover notification disabled or missing adminNotificationPhone for instance ${instanceName}`,
        );
        return;
      }

      const adminDigits = normalizeWhatsAppNumber(config.adminNotificationPhone);
      if (!adminDigits || adminDigits.length < 8) {
        this.logger.warn(`Admin notification phone '${config.adminNotificationPhone}' is invalid`);
        return;
      }

      const customerDigits = customerJid.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
      const displayName = customerName ? `${customerName} (+${customerDigits})` : `+${customerDigits}`;
      const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      const alertText =
        `🚨 *[Dennel Tech WhatsApp AI Assistant]*\n` +
        `*Human Intervention Needed!*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Customer:* ${displayName}\n` +
        `🏢 *Business:* ${config.businessName || instanceName}\n` +
        `⏰ *Time:* ${timeStr}\n` +
        (reason ? `📌 *Reason:* ${reason}\n` : '') +
        `💬 *Message:* "${triggerMessage || 'Customer requested human agent'}"\n\n` +
        `⚠️ *Action Required:* Auto-replies are paused for this customer. Please assist them now via WhatsApp or the dashboard.`;

      const targetJid = `${adminDigits}@s.whatsapp.net`;
      await this.sendWhatsAppReply(instanceName, targetJid, alertText);
      this.logger.info(`Takeover alert dispatched successfully to WhatsApp +${adminDigits} for customer ${displayName}`);
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
