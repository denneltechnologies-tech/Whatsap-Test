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
        take: 500,
      });
    } catch (err: any) {
      this.logger.warn(`Could not query Chat table: ${err.message}`);
    }

    // 3. Fetch contacts for pushName and profile pictures (up to 3000 to cover full address book)
    let contacts: any[] = [];
    try {
      contacts = await (this.prismaRepository as any).contact.findMany({
        where: { instanceId },
        select: {
          remoteJid: true,
          pushName: true,
          profilePicUrl: true,
        },
        take: 3000,
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

    // 4. Fetch alternate JID links from Message table (LID <-> Phone JID)
    const lidToPhoneMap = new Map<string, string>();
    try {
      const altRows = await (this.prismaRepository as any).message.findMany({
        where: {
          instanceId,
          key: { path: ['remoteJidAlt'], string_contains: '@' },
        },
        select: { key: true },
        take: 200,
      });
      for (const row of altRows) {
        const k = row.key as any;
        if (k?.remoteJid && k?.remoteJidAlt) {
          if (typeof k.remoteJid === 'string' && typeof k.remoteJidAlt === 'string') {
            if (k.remoteJid.endsWith('@lid') && k.remoteJidAlt.endsWith('@s.whatsapp.net')) {
              lidToPhoneMap.set(k.remoteJid, k.remoteJidAlt);
            } else if (k.remoteJidAlt.endsWith('@lid') && k.remoteJid.endsWith('@s.whatsapp.net')) {
              lidToPhoneMap.set(k.remoteJidAlt, k.remoteJid);
            }
          }
        }
      }
    } catch (e: any) {
      this.logger.debug?.(`Alt JID map notice: ${e.message}`);
    }

    // 5. Merge all distinct conversations
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

    // Add contacts from Message table that might not be in Chat
    try {
      const recentMessages = await (this.prismaRepository as any).message.findMany({
        where: { instanceId },
        orderBy: { messageTimestamp: 'desc' },
        take: 300,
        select: { key: true, messageTimestamp: true, message: true },
      });

      for (const m of recentMessages) {
        const rJid = (m.key as any)?.remoteJid;
        if (!rJid || rJid.includes('@broadcast') || rJid.includes('status@broadcast')) continue;

        let existing = convMap.get(rJid);
        const contact = contactMap.get(rJid);
        const name = contact?.pushName || existing?.contactName || rJid.split('@')[0];
        const msgTime = m.messageTimestamp ? new Date(m.messageTimestamp * 1000) : new Date(0);

        if (!existing) {
          existing = {
            remoteJid: rJid,
            instanceId,
            status: 'bot',
            needsHumanAttention: false,
            aiReplyCount: 0,
            humanReplyCount: 0,
            contactName: name,
            profilePicUrl: contact?.profilePicUrl,
            lastMessage: null,
            lastMessageSender: null,
            lastMessageTime: msgTime,
            unreadMessages: 0,
          };
          convMap.set(rJid, existing);
        } else if (msgTime > new Date(existing.lastMessageTime || 0)) {
          existing.lastMessageTime = msgTime;
        }

        if (!existing.lastMessage) {
          let snippet = '';
          const msgObj = m.message as any;
          if (msgObj?.conversation) snippet = msgObj.conversation;
          else if (msgObj?.extendedTextMessage?.text) snippet = msgObj.extendedTextMessage.text;
          else if (msgObj?.imageMessage?.caption) snippet = `📷 ${msgObj.imageMessage.caption}`;
          else if (msgObj?.imageMessage) snippet = '📷 Photo';
          else if (msgObj?.audioMessage) snippet = '🎵 Audio message';
          else if (msgObj?.videoMessage) snippet = '🎥 Video';
          else if (msgObj?.documentMessage) snippet = `📄 ${msgObj.documentMessage.fileName || 'Document'}`;
          const fromMe = Boolean((m.key as any)?.fromMe);
          existing.lastMessage = snippet || 'WhatsApp message';
          existing.lastMessageSender = fromMe ? 'human' : 'customer';
        }
      }
    } catch (e: any) {
      this.logger.warn(`Could not seed messages into conversations: ${e.message}`);
    }

    // Overlay AI Message logs for latest snippets
    try {
      const recentAiLogs = await (this.prismaRepository as any).aiMessageLog.findMany({
        where: { instanceId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { remoteJid: true, content: true, senderType: true, createdAt: true },
      });

      for (const log of recentAiLogs) {
        if (!log.remoteJid) continue;
        const conv = convMap.get(log.remoteJid);
        if (conv) {
          if (!conv.lastMessage || new Date(log.createdAt) > new Date(conv.lastMessageTime || 0)) {
            conv.lastMessage = log.content;
            conv.lastMessageSender = log.senderType;
            conv.lastMessageTime = log.createdAt;
          }
        }
      }
    } catch {}

    // Overlay contacts that might not have a Chat entry yet (seed top 300 contacts)
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

    // Add mapped phone number property for LID conversations
    for (const [jid, conv] of convMap.entries()) {
      if (jid.endsWith('@lid')) {
        const phoneJid = lidToPhoneMap.get(jid);
        if (phoneJid) {
          conv.phoneJid = phoneJid;
        }
      }
    }

    const conversationList = Array.from(convMap.values());

    // Sort by latest message time descending
    conversationList.sort((a, b) => {
      const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return timeB - timeA;
    });

    return conversationList;
  }

  /**
   * Retrieves message log history for a specific customer JID.
   * Merges AI message logs with all native WhatsApp messages,
   * unifying phone JID and LID multi-device streams into a complete conversation history.
   */
  public async getMessages(instanceName: string, remoteJid: string) {
    if (!remoteJid) {
      throw new BadRequestException('remoteJid is required');
    }

    const instanceId = await this.getInstanceId(instanceName);

    // 1. Determine all candidate JIDs for this conversation (e.g. phone @s.whatsapp.net and multi-device @lid)
    const candidateJids = new Set<string>([remoteJid]);

    // Check if there are alternative JIDs in the Message table
    try {
      const altLinks = await (this.prismaRepository as any).message.findMany({
        where: {
          instanceId,
          OR: [
            { key: { path: ['remoteJid'], equals: remoteJid } },
            { key: { path: ['remoteJidAlt'], equals: remoteJid } },
          ],
        },
        select: { key: true },
        take: 50,
      });

      for (const m of altLinks) {
        const k = m.key as any;
        if (k?.remoteJid && typeof k.remoteJid === 'string') candidateJids.add(k.remoteJid);
        if (k?.remoteJidAlt && typeof k.remoteJidAlt === 'string') candidateJids.add(k.remoteJidAlt);
      }
    } catch (e: any) {
      this.logger.warn(`Could not fetch alt JIDs from message table: ${e.message}`);
    }

    const jidList = Array.from(candidateJids);

    // 2. Fetch AI Message Logs for all candidate JIDs
    let aiLogs: any[] = [];
    try {
      aiLogs = await (this.prismaRepository as any).aiMessageLog.findMany({
        where: {
          instanceId,
          remoteJid: { in: jidList },
        },
        orderBy: { createdAt: 'asc' },
        take: 300,
      });
    } catch (e: any) {
      this.logger.warn(`Could not query aiMessageLog: ${e.message}`);
    }

    // 3. Fetch native WhatsApp messages from Message table for all candidate JIDs
    let nativeMessages: any[] = [];
    try {
      nativeMessages = await (this.prismaRepository as any).message.findMany({
        where: {
          instanceId,
          OR: jidList.flatMap((j) => [
            { key: { path: ['remoteJid'], equals: j } },
            { key: { path: ['remoteJidAlt'], equals: j } },
          ]),
        },
        orderBy: { messageTimestamp: 'asc' },
        take: 300,
      });
    } catch (e: any) {
      this.logger.warn(`Could not query message table: ${e.message}`);
    }

    // 4. Format native messages
    const formattedNative = (nativeMessages || []).map((m: any) => {
      let content = '';
      const msgObj = m.message as any;
      if (msgObj?.conversation) content = msgObj.conversation;
      else if (msgObj?.extendedTextMessage?.text) content = msgObj.extendedTextMessage.text;
      else if (msgObj?.imageMessage?.caption) content = `📷 ${msgObj.imageMessage.caption}`;
      else if (msgObj?.imageMessage) content = '📷 Photo';
      else if (msgObj?.audioMessage) content = '🎵 Audio message';
      else if (msgObj?.videoMessage?.caption) content = `🎥 ${msgObj.videoMessage.caption}`;
      else if (msgObj?.videoMessage) content = '🎥 Video';
      else if (msgObj?.documentMessage) content = `📄 ${msgObj.documentMessage.fileName || 'Document'}`;
      else if (msgObj?.contactMessage) content = `👤 Contact Card: ${msgObj.contactMessage.displayName || ''}`;
      else if (msgObj?.locationMessage) content = `📍 Location`;
      else content = '[Media Message]';

      const fromMe = Boolean((m.key as any)?.fromMe);
      const timestamp = m.messageTimestamp ? new Date(m.messageTimestamp * 1000) : m.createdAt || new Date();

      return {
        id: m.id || (m.key as any)?.id,
        instanceId,
        remoteJid: (m.key as any)?.remoteJid || remoteJid,
        direction: fromMe ? 'outgoing' : 'incoming',
        senderType: fromMe ? 'human' : 'customer',
        content,
        createdAt: timestamp,
      };
    });

    // 5. Merge AI logs and native messages chronologically with deduplication
    const mergedList: any[] = [...aiLogs];

    for (const nm of formattedNative) {
      // Deduplicate if matching content and sender within 8 seconds
      const exists = aiLogs.some((al) => {
        const timeDiff = Math.abs(new Date(al.createdAt).getTime() - new Date(nm.createdAt).getTime());
        if (timeDiff < 8000 && al.content?.trim() === nm.content?.trim()) {
          return true;
        }
        return false;
      });

      if (!exists) {
        mergedList.push(nm);
      }
    }

    mergedList.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // 6. Get latest conversation state across candidate JIDs
    let state = await (this.prismaRepository as any).aiConversationState.findFirst({
      where: {
        instanceId,
        remoteJid: { in: jidList },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!state) {
      state = { status: 'bot', needsHumanAttention: false };
    }

    return {
      remoteJid,
      candidateJids: jidList,
      state,
      messages: mergedList,
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
