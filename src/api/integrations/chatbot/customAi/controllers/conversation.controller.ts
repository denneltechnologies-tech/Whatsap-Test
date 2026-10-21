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
   * Lists conversations for an instance with contact names, phone numbers, and latest activity.
   * Merges all WhatsApp chats, contacts, and AI states so EVERY chat with every number is visible.
   */
  public async getConversations(instanceName: string) {
    const instanceId = await this.getInstanceId(instanceName);

    // 1. Fetch AI conversation states
    const aiStates = await (this.prismaRepository as any).aiConversationState.findMany({
      where: { instanceId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });

    // 2. Fetch all WhatsApp chats stored by Evolution API / Baileys
    let chats: any[] = [];
    try {
      chats = await (this.prismaRepository as any).chat.findMany({
        where: { instanceId },
        orderBy: { updatedAt: 'desc' },
        take: 300,
      });
    } catch (err: any) {
      this.logger.warn(`Could not query Chat table: ${err.message}`);
    }

    // 3. Fetch contacts for pushName and profile pictures
    let contacts: any[] = [];
    try {
      contacts = await (this.prismaRepository as any).contact.findMany({
        where: { instanceId },
        select: {
          remoteJid: true,
          pushName: true,
          profilePicUrl: true,
        },
        take: 300,
      });
    } catch (err: any) {
      this.logger.warn(`Could not query Contact table: ${err.message}`);
    }

    const contactMap = new Map<string, { pushName?: string; profilePicUrl?: string }>();
    for (const c of contacts) {
      if (c.remoteJid) {
        contactMap.set(c.remoteJid, c);
      }
    }

    // 4. Merge all distinct conversations
    const convMap = new Map<string, any>();

    // Seed from WhatsApp native chats
    for (const ch of chats) {
      if (!ch.remoteJid || ch.remoteJid.includes('@broadcast') || ch.remoteJid.includes('status@broadcast')) {
        continue;
      }
      const contact = contactMap.get(ch.remoteJid);
      const name = contact?.pushName || ch.name || ch.remoteJid.split('@')[0];

      convMap.set(ch.remoteJid, {
        remoteJid: ch.remoteJid,
        instanceId,
        status: 'bot',
        needsHumanAttention: false,
        aiReplyCount: 0,
        humanReplyCount: 0,
        contactName: name,
        profilePicUrl: contact?.profilePicUrl,
        lastMessage: null,
        lastMessageSender: null,
        lastMessageTime: ch.updatedAt || ch.createdAt || new Date(0),
        unreadMessages: ch.unreadMessages || 0,
      });
    }

    // Overlay AI conversation states
    for (const state of aiStates) {
      if (!state.remoteJid || state.remoteJid.includes('@broadcast') || state.remoteJid.includes('status@broadcast')) {
        continue;
      }
      const existing = convMap.get(state.remoteJid);
      const contact = contactMap.get(state.remoteJid);
      const name = contact?.pushName || existing?.contactName || state.remoteJid.split('@')[0];

      convMap.set(state.remoteJid, {
        ...existing,
        ...state,
        remoteJid: state.remoteJid,
        contactName: name,
        profilePicUrl: contact?.profilePicUrl || existing?.profilePicUrl,
        status: state.status || 'bot',
        needsHumanAttention: Boolean(state.needsHumanAttention),
        lastCustomerMessageAt: state.lastCustomerMessageAt,
        lastMessageTime:
          state.updatedAt > (existing?.lastMessageTime || new Date(0))
            ? state.updatedAt
            : existing?.lastMessageTime || new Date(0),
      });
    }

    // Overlay contacts that might not have a Chat entry yet
    for (const [jid, contact] of contactMap.entries()) {
      if (!jid || jid.includes('@broadcast') || jid.includes('status@broadcast') || convMap.has(jid)) {
        continue;
      }
      convMap.set(jid, {
        remoteJid: jid,
        instanceId,
        status: 'bot',
        needsHumanAttention: false,
        aiReplyCount: 0,
        humanReplyCount: 0,
        contactName: contact.pushName || jid.split('@')[0],
        profilePicUrl: contact.profilePicUrl,
        lastMessage: null,
        lastMessageSender: null,
        lastMessageTime: new Date(0),
        unreadMessages: 0,
      });
    }

    // 5. Enrich with latest message
    const conversationList = Array.from(convMap.values());
    const enriched = await Promise.all(
      conversationList.map(async (conv) => {
        // Priority 1: Check aiMessageLog
        const lastLog = await (this.prismaRepository as any).aiMessageLog.findFirst({
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

        if (lastLog) {
          return {
            ...conv,
            lastMessage: lastLog.content,
            lastMessageSender: lastLog.senderType,
            lastMessageTime: lastLog.createdAt,
          };
        }

        // Priority 2: Fallback to WhatsApp native message table
        try {
          const lastMsg = await (this.prismaRepository as any).message.findFirst({
            where: {
              instanceId,
              key: { path: ['remoteJid'], equals: conv.remoteJid },
            },
            orderBy: { messageTimestamp: 'desc' },
            select: {
              message: true,
              messageTimestamp: true,
              key: true,
            },
          });

          if (lastMsg) {
            let snippet = '';
            const m = lastMsg.message as any;
            if (m?.conversation) snippet = m.conversation;
            else if (m?.extendedTextMessage?.text) snippet = m.extendedTextMessage.text;
            else if (m?.imageMessage?.caption) snippet = `📷 ${m.imageMessage.caption}`;
            else if (m?.imageMessage) snippet = '📷 Photo';
            else if (m?.audioMessage) snippet = '🎵 Voice message';
            else if (m?.videoMessage) snippet = '🎥 Video';
            else if (m?.documentMessage) snippet = `📄 ${m.documentMessage.fileName || 'Document'}`;

            const fromMe = Boolean((lastMsg.key as any)?.fromMe);
            return {
              ...conv,
              lastMessage: snippet || 'WhatsApp Message',
              lastMessageSender: fromMe ? 'human' : 'customer',
              lastMessageTime: new Date(lastMsg.messageTimestamp * 1000),
            };
          }
        } catch {
          // Ignore JSON path error
        }

        return conv;
      }),
    );

    // Sort by latest message time descending
    enriched.sort((a, b) => {
      const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return timeB - timeA;
    });

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

    let messages = await (this.prismaRepository as any).aiMessageLog.findMany({
      where: {
        instanceId,
        remoteJid,
      },
      orderBy: { createdAt: 'asc' },
      take: 150,
    });

    // Fallback to native WhatsApp messages if aiMessageLog is empty
    if (!messages || messages.length === 0) {
      try {
        const nativeMessages = await (this.prismaRepository as any).message.findMany({
          where: {
            instanceId,
            key: { path: ['remoteJid'], equals: remoteJid },
          },
          orderBy: { messageTimestamp: 'asc' },
          take: 150,
        });

        if (nativeMessages && nativeMessages.length > 0) {
          messages = nativeMessages.map((m: any) => {
            let content = '';
            const msgObj = m.message as any;
            if (msgObj?.conversation) content = msgObj.conversation;
            else if (msgObj?.extendedTextMessage?.text) content = msgObj.extendedTextMessage.text;
            else if (msgObj?.imageMessage?.caption) content = `📷 ${msgObj.imageMessage.caption}`;
            else if (msgObj?.imageMessage) content = '📷 Photo';
            else if (msgObj?.audioMessage) content = '🎵 Audio message';
            else if (msgObj?.videoMessage) content = '🎥 Video';
            else if (msgObj?.documentMessage) content = `📄 ${msgObj.documentMessage.fileName || 'Document'}`;
            else content = '[Media Message]';

            const fromMe = Boolean((m.key as any)?.fromMe);
            return {
              id: m.id,
              instanceId,
              remoteJid,
              direction: fromMe ? 'outgoing' : 'incoming',
              senderType: fromMe ? 'human' : 'customer',
              content,
              createdAt: new Date(m.messageTimestamp * 1000),
            };
          });
        }
      } catch {
        // Ignore fallback error
      }
    }

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
      messages: messages || [],
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
