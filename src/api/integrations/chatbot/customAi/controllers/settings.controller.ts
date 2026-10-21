import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';

import { CustomAiService } from '../services/customAi.service';
import { normalizeWhatsAppNumber } from '../utils/phone.util';

export class SettingsController {
  private readonly logger = new Logger('SettingsController');

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly customAiService: CustomAiService,
  ) {}

  /**
   * Helper: Resolves instanceName to instanceId
   */
  private async getInstanceId(instanceName: string): Promise<string> {
    const inst = await this.prismaRepository.instance.findFirst({
      where: { name: instanceName },
      select: { id: true },
    });
    if (!inst) {
      throw new NotFoundException(`Instance '${instanceName}' not found`);
    }
    return inst.id;
  }

  /**
   * Get AI assistant settings for an instance
   */
  public async getSettings(instanceName: string) {
    const instanceId = await this.getInstanceId(instanceName);
    const config = await this.customAiService.getOrCreateConfig(instanceId);

    // Mask sensitive keys for frontend security
    const maskedConfig = {
      ...config,
      apiKey: config.apiKey ? `${config.apiKey.substring(0, 4)}...${config.apiKey.slice(-4)}` : '',
      embeddingApiKey: config.embeddingApiKey ? `${config.embeddingApiKey.substring(0, 4)}...${config.embeddingApiKey.slice(-4)}` : '',
    };

    return maskedConfig;
  }

  /**
   * Update AI assistant settings
   */
  public async updateSettings(instanceName: string, data: any) {
    const instanceId = await this.getInstanceId(instanceName);

    // Existing config
    const existing = await this.customAiService.getOrCreateConfig(instanceId);

    // If masked or empty key provided on update, retain the existing key
    let apiKey = data.apiKey;
    if (apiKey === undefined || apiKey === null || apiKey.includes('...')) {
      apiKey = existing.apiKey;
    }

    let embeddingApiKey = data.embeddingApiKey;
    if (embeddingApiKey === undefined || embeddingApiKey === null || embeddingApiKey.includes('...')) {
      embeddingApiKey = existing.embeddingApiKey;
    }

    const updated = await this.prismaRepository.aiAssistantConfig.update({
      where: { instanceId },
      data: {
        enabled: data.enabled !== undefined ? Boolean(data.enabled) : existing.enabled,
        assistantName: data.assistantName || existing.assistantName,
        businessName: data.businessName || existing.businessName,
        businessDescription: data.businessDescription !== undefined ? data.businessDescription : existing.businessDescription,
        businessHours: data.businessHours !== undefined ? data.businessHours : existing.businessHours,
        supportedLanguages: data.supportedLanguages || existing.supportedLanguages,
        tonePreset: data.tonePreset !== undefined ? data.tonePreset : (existing as any).tonePreset,
        customInstructions: data.customInstructions !== undefined ? data.customInstructions : (existing as any).customInstructions,
        customRestrictions: data.customRestrictions !== undefined ? data.customRestrictions : (existing as any).customRestrictions,
        systemPrompt: data.systemPrompt !== undefined ? data.systemPrompt : existing.systemPrompt,
        fallbackResponse: data.fallbackResponse !== undefined ? data.fallbackResponse : existing.fallbackResponse,
        humanTakeoverKeywords: data.humanTakeoverKeywords !== undefined ? data.humanTakeoverKeywords : existing.humanTakeoverKeywords,
        adminNotificationPhone: data.adminNotificationPhone !== undefined
          ? normalizeWhatsAppNumber(data.adminNotificationPhone)
          : (existing as any).adminNotificationPhone,
        notifyOnTakeover: data.notifyOnTakeover !== undefined ? Boolean(data.notifyOnTakeover) : (existing as any).notifyOnTakeover,
        provider: data.provider || existing.provider,
        model: data.model || existing.model,
        apiUrl: data.apiUrl !== undefined ? data.apiUrl : existing.apiUrl,
        apiKey,
        temperature: data.temperature !== undefined ? Number(data.temperature) : existing.temperature,
        maxTokens: data.maxTokens !== undefined ? Number(data.maxTokens) : existing.maxTokens,
        embeddingProvider: data.embeddingProvider || existing.embeddingProvider,
        embeddingModel: data.embeddingModel || existing.embeddingModel,
        embeddingApiUrl: data.embeddingApiUrl !== undefined ? data.embeddingApiUrl : existing.embeddingApiUrl,
        embeddingApiKey,
        ragTopK: data.ragTopK !== undefined ? Number(data.ragTopK) : existing.ragTopK,
        ragMinScore: data.ragMinScore !== undefined ? Number(data.ragMinScore) : existing.ragMinScore,
        maxContextMessages: data.maxContextMessages !== undefined ? Number(data.maxContextMessages) : existing.maxContextMessages,
      },
    });

    return {
      message: 'Settings updated successfully',
      config: {
        ...updated,
        apiKey: updated.apiKey ? '********' : '',
        embeddingApiKey: updated.embeddingApiKey ? '********' : '',
      },
    };
  }

  /**
   * Dispatches a test alert via WhatsApp to verify the manager's notification phone number
   */
  public async testNotification(instanceName: string, data: { phone?: string }) {
    const instanceId = await this.getInstanceId(instanceName);
    const config = await this.customAiService.getOrCreateConfig(instanceId);
    const targetPhone = data.phone || (config as any).adminNotificationPhone;

    if (!targetPhone) {
      throw new BadRequestException('Please provide a WhatsApp phone number to test');
    }

    const adminDigits = normalizeWhatsAppNumber(targetPhone);
    if (!adminDigits || adminDigits.length < 8) {
      throw new BadRequestException('Phone number must contain at least 8 digits with country code');
    }

    const testMessage =
      `🔔 *[Dennel Tech WhatsApp AI Assistant]*\n` +
      `*Test Notification Received!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏢 *Business:* ${config.businessName || instanceName}\n` +
      `⏰ *Time:* ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}\n\n` +
      `✅ *Success!* Your WhatsApp takeover notifications are configured properly. When a customer requires human attention, an alert will be sent to this number (+${adminDigits}) automatically.`;

    try {
      await this.customAiService.sendWhatsAppReply(instanceName, `${adminDigits}@s.whatsapp.net`, testMessage);
    } catch (err: any) {
      this.logger.error(`Failed to send test alert to ${adminDigits}: ${err?.message || err}`);
      let errorMsg = 'Failed to deliver message via WhatsApp';

      if (err?.response && typeof err.response === 'object') {
        if (err.response.exists === false) {
          errorMsg = `The phone number +${adminDigits} is not registered on WhatsApp. Please check the country code and digits.`;
        } else if (err.response.message) {
          errorMsg = Array.isArray(err.response.message) ? err.response.message.join(', ') : String(err.response.message);
        } else if (err.response.error) {
          errorMsg = String(err.response.error);
        }
      } else if (err?.message) {
        errorMsg = typeof err.message === 'string' ? err.message : JSON.stringify(err.message);
      }

      throw new BadRequestException(errorMsg);
    }

    return {
      message: `Test alert sent successfully to +${adminDigits} via WhatsApp!`,
    };
  }
}
