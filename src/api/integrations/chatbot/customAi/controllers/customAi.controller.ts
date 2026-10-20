import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { getConversationMessage } from '@utils/getConversationMessage';

import { CustomAiService } from '../services/customAi.service';

export class CustomAiController {
  private readonly logger = new Logger('CustomAiController');

  constructor(
    public readonly customAiService: CustomAiService,
    private readonly prismaRepository: PrismaRepository,
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Called by ChatbotController.emit({ instance, remoteJid, msg, pushName })
   */
  public async emit({
    instance,
    remoteJid,
    msg,
    pushName,
  }: {
    instance: InstanceDto;
    remoteJid: string;
    msg: any;
    pushName?: string;
  }): Promise<void> {
    try {
      if (!msg || !msg.key) return;

      const messageId = msg.key.id;
      const fromMe = Boolean(msg.key.fromMe);

      // Extract text content
      const content = getConversationMessage(msg);
      if (!content && !fromMe) {
        return;
      }

      // Ensure instanceId is available
      let instanceId = instance.instanceId;
      if (!instanceId && instance.instanceName) {
        const found = await this.prismaRepository.instance.findFirst({
          where: { name: instance.instanceName },
          select: { id: true },
        });
        instanceId = found?.id;
      }

      if (!instanceId) {
        this.logger.warn(`Instance not found for name: ${instance.instanceName}`);
        return;
      }

      // Hand off to service
      await this.customAiService.handleIncomingMessage(
        instance.instanceName,
        instanceId,
        remoteJid,
        messageId,
        content || '',
        pushName || msg.pushName,
        fromMe,
      );
    } catch (error: any) {
      this.logger.error(`Error in CustomAiController.emit: ${error.message}`);
    }
  }

  /**
   * Retrieves dashboard metrics & statistics
   */
  public async getDashboardStats(instanceName?: string) {
    try {
      let targetInstanceId: string | undefined;

      if (instanceName) {
        const inst = await this.prismaRepository.instance.findFirst({
          where: { name: instanceName },
          select: { id: true },
        });
        targetInstanceId = inst?.id;
      }

      const instanceWhere = targetInstanceId ? { instanceId: targetInstanceId } : {};

      // 1. Total conversations
      const totalConversations = await this.prismaRepository.aiConversationState.count({
        where: instanceWhere,
      });

      // 2. Active human takeover count
      const humanTakeoverCount = await this.prismaRepository.aiConversationState.count({
        where: {
          ...instanceWhere,
          status: 'human_takeover',
        },
      });

      // 3. Total messages logged
      const totalMessages = await this.prismaRepository.aiMessageLog.count({
        where: instanceWhere,
      });

      // 4. AI-generated messages
      const totalAiReplies = await this.prismaRepository.aiMessageLog.count({
        where: {
          ...instanceWhere,
          senderType: 'ai',
        },
      });

      // 5. Total knowledge documents
      const totalDocuments = await this.prismaRepository.knowledgeDocument.count({
        where: instanceWhere,
      });

      // 6. Total knowledge chunks indexed
      const totalChunks = await this.prismaRepository.knowledgeChunk.count({
        where: instanceWhere,
      });

      // 7. Recent conversations
      const recentConversations = await this.prismaRepository.aiConversationState.findMany({
        where: instanceWhere,
        orderBy: { updatedAt: 'desc' },
        take: 10,
        include: {
          Instance: {
            select: { name: true },
          },
        },
      });

      // 8. WhatsApp instance connection states
      const waInstances = Object.entries(this.waMonitor.waInstances || {}).map(([name, inst]) => ({
        instanceName: name,
        state: inst?.connectionStatus?.state || 'closed',
        profileName: inst?.instance?.profileName,
        profilePicUrl: inst?.instance?.profilePicUrl,
        number: inst?.instance?.number,
      }));

      return {
        totalConversations,
        humanTakeoverCount,
        totalMessages,
        totalAiReplies,
        totalDocuments,
        totalChunks,
        recentConversations,
        waInstances,
      };
    } catch (error: any) {
      this.logger.error(`Error calculating dashboard stats: ${error.message}`);
      throw error;
    }
  }
}
