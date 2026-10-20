import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';

import { CustomAiService } from '../services/customAi.service';

export class ConversationController {
  private readonly logger = new Logger('ConversationController');

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
   * Lists conversations for an instance with contact names and latest activity
   */
  public async getConversations(instanceName: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const conversations = await (this.prismaRepository as any).aiConversationState.findMany({
      where: { instanceId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    // Enrich with WhatsApp contact details if available
    const enriched = await Promise.all(
      conversations.map(async (conv: any) => {
        const contact = await this.prismaRepository.contact.findFirst({
          where: {
            instanceId,
            remoteJid: conv.remoteJid,
          },
          select: {
            pushName: true,
            profilePicUrl: true,
          },
        });

        const lastMessage = await (this.prismaRepository as any).aiMessageLog.findFirst({
          where: {
            instanceId,
            remoteJid: conv.remoteJid,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            content: true,
            senderType: true,
            createdAt: true,
          },
        });

        return {
          ...conv,
          contactName: contact?.pushName || conv.remoteJid.split('@')[0],
          profilePicUrl: contact?.profilePicUrl,
          lastMessage: lastMessage?.content,
          lastMessageSender: lastMessage?.senderType,
          lastMessageTime: lastMessage?.createdAt,
        };
      }),
    );

    return enriched;
  }

  /**
   * Retrieves message log history for a specific customer JID
   */
  public async getMessages(instanceName: string, remoteJid: string) {
    if (!remoteJid) {
      throw new BadRequestException('remoteJid is required');
    }

    const instanceId = await this.getInstanceId(instanceName);

    const messages = await (this.prismaRepository as any).aiMessageLog.findMany({
      where: {
        instanceId,
        remoteJid,
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    const state = await (this.prismaRepository as any).aiConversationState.findUnique({
      where: {
        instanceId_remoteJid: {
          instanceId,
          remoteJid,
        },
      },
    });

    return {
      remoteJid,
      state: state || { status: 'bot', needsHumanAttention: false },
      messages,
    };
  }

  /**
   * Pause AI replies for a conversation
   */
  public async pauseAi(instanceName: string, remoteJid: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const updated = await (this.prismaRepository as any).aiConversationState.upsert({
      where: {
        instanceId_remoteJid: {
          instanceId,
          remoteJid,
        },
      },
      update: {
        status: 'paused',
      },
      create: {
        instanceId,
        remoteJid,
        status: 'paused',
      },
    });

    return { message: 'AI paused for this conversation', state: updated };
  }

  /**
   * Resume AI replies for a conversation
   */
  public async resumeAi(instanceName: string, remoteJid: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const updated = await (this.prismaRepository as any).aiConversationState.upsert({
      where: {
        instanceId_remoteJid: {
          instanceId,
          remoteJid,
        },
      },
      update: {
        status: 'bot',
        needsHumanAttention: false,
        takeoverReason: null,
      },
      create: {
        instanceId,
        remoteJid,
        status: 'bot',
      },
    });

    return { message: 'AI resumed for this conversation', state: updated };
  }

  /**
   * Mark conversation as needing human takeover
   */
  public async markHumanTakeover(instanceName: string, remoteJid: string, reason?: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const updated = await (this.prismaRepository as any).aiConversationState.upsert({
      where: {
        instanceId_remoteJid: {
          instanceId,
          remoteJid,
        },
      },
      update: {
        status: 'human_takeover',
        needsHumanAttention: true,
        takeoverReason: reason || 'Marked by administrator',
      },
      create: {
        instanceId,
        remoteJid,
        status: 'human_takeover',
        needsHumanAttention: true,
        takeoverReason: reason || 'Marked by administrator',
      },
    });

    return { message: 'Conversation marked for human takeover', state: updated };
  }

  /**
   * Sends a human agent reply directly to WhatsApp and pauses AI
   */
  public async sendHumanReply(instanceName: string, remoteJid: string, text: string) {
    if (!text || text.trim() === '') {
      throw new BadRequestException('Message text cannot be empty');
    }

    const instanceId = await this.getInstanceId(instanceName);

    // 1. Dispatch through Evolution API
    await this.customAiService.sendWhatsAppReply(instanceName, remoteJid, text);

    // 2. Automatically assign to human takeover so AI doesn't reply
    await (this.prismaRepository as any).aiConversationState.upsert({
      where: {
        instanceId_remoteJid: {
          instanceId,
          remoteJid,
        },
      },
      update: {
        status: 'human_takeover',
        lastHumanReplyAt: new Date(),
        humanReplyCount: { increment: 1 },
      },
      create: {
        instanceId,
        remoteJid,
        status: 'human_takeover',
        lastHumanReplyAt: new Date(),
        humanReplyCount: 1,
      },
    });

    // 3. Log human message
    await this.customAiService.logMessage({
      instanceId,
      remoteJid,
      direction: 'outgoing',
      senderType: 'human',
      content: text,
    });

    return { message: 'Human reply sent successfully' };
  }
}
