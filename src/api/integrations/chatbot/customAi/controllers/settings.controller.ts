import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { NotFoundException } from '@exceptions';

import { CustomAiService } from '../services/customAi.service';

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
        systemPrompt: data.systemPrompt !== undefined ? data.systemPrompt : existing.systemPrompt,
        fallbackResponse: data.fallbackResponse !== undefined ? data.fallbackResponse : existing.fallbackResponse,
        humanTakeoverKeywords: data.humanTakeoverKeywords !== undefined ? data.humanTakeoverKeywords : existing.humanTakeoverKeywords,
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
}
