import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';

export class DeduplicationService {
  private readonly logger = new Logger('DeduplicationService');
  private readonly processedIds = new Map<string, number>();
  private readonly inFlightIds = new Set<string>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly prismaRepository?: PrismaRepository) {
    const timer = setInterval(() => {
      this.cleanup();
    }, 2 * 60 * 1000);
    if (timer.unref) {
      timer.unref();
    }
  }

  /**
   * Cleans up expired message IDs from cache
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.processedIds.entries()) {
      if (now - timestamp > this.TTL_MS) {
        this.processedIds.delete(id);
      }
    }
  }

  /**
   * Attempts to acquire a processing lock for a message ID.
   * Returns true if this is the first time seeing this message and it is now locked for processing.
   * Returns false if it is a duplicate or currently in-flight.
   */
  public async acquireLock(messageId: string): Promise<boolean> {
    if (!messageId) return true;

    // Check memory cache
    if (this.processedIds.has(messageId)) {
      this.logger.warn(`Duplicate message dropped (already processed): ${messageId}`);
      return false;
    }

    if (this.inFlightIds.has(messageId)) {
      this.logger.warn(`Duplicate message dropped (currently in-flight): ${messageId}`);
      return false;
    }

    // Check DB if prismaRepository is available
    if (this.prismaRepository) {
      try {
        const existing = await (this.prismaRepository as any).aiMessageLog.findFirst({
          where: {
            providerMessageId: messageId,
          },
          select: { id: true },
        });

        if (existing) {
          this.processedIds.set(messageId, Date.now());
          this.logger.warn(`Duplicate message dropped (found in DB logs): ${messageId}`);
          return false;
        }
      } catch (err: any) {
        this.logger.debug(`DB deduplication check skipped: ${err.message}`);
      }
    }

    // Lock acquired
    this.inFlightIds.add(messageId);
    return true;
  }

  /**
   * Releases lock and marks message as processed
   */
  public markProcessed(messageId: string): void {
    if (!messageId) return;
    this.inFlightIds.delete(messageId);
    this.processedIds.set(messageId, Date.now());
  }

  /**
   * Releases lock in case of an early unrecoverable error so it can be retried if needed
   */
  public releaseLock(messageId: string): void {
    if (!messageId) return;
    this.inFlightIds.delete(messageId);
  }
}
