import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';

import { CustomAiService } from '../services/customAi.service';
import { documentParserService } from '../services/documentParser.service';
import { RagService } from '../services/rag.service';
import { cleanTitle, sanitizeUnicode } from '../utils/unicode.util';

export class KnowledgeController {
  private readonly logger = new Logger('KnowledgeController');

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly ragService: RagService,
    private readonly customAiService?: CustomAiService,
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
   * Helper: Fetch assistant config to obtain embedding settings
   * Auto-provisions default assistant configuration for new companies if not yet initialized
   */
  private async getEmbeddingSettings(instanceId: string) {
    let config = await this.prismaRepository.aiAssistantConfig.findUnique({
      where: { instanceId },
    });

    if (!config && this.customAiService) {
      try {
        config = await this.customAiService.getOrCreateConfig(instanceId);
      } catch (err: any) {
        this.logger.warn(`Failed to auto-create assistant config for ${instanceId}: ${err.message}`);
      }
    }

    return {
      provider: config?.embeddingProvider,
      model: config?.embeddingModel,
      apiUrl: config?.embeddingApiUrl,
      apiKey: config?.embeddingApiKey || config?.apiKey,
    };
  }

  /**
   * Get all documents for an instance
   */
  public async getDocuments(instanceName: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const documents = await (this.prismaRepository as any).knowledgeDocument.findMany({
      where: { instanceId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { chunks: true },
        },
      },
    });

    return documents;
  }

  /**
   * Ingest an uploaded file (.pdf, .docx, .txt, .md)
   */
  public async uploadFile(
    instanceName: string,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('No file uploaded');
    }

    const instanceId = await this.getInstanceId(instanceName);
    const ext = file.originalname.split('.').pop()?.toLowerCase();

    // 1. Parse content based on file type
    let parsed: { title: string; content: string; fileType?: string; metadata?: any };

    if (ext === 'txt' || ext === 'md') {
      parsed = documentParserService.parseTextOrMarkdown(file.buffer, file.originalname);
    } else if (ext === 'pdf') {
      parsed = await documentParserService.parsePdf(file.buffer, file.originalname);
    } else if (ext === 'docx') {
      parsed = await documentParserService.parseDocx(file.buffer, file.originalname);
    } else {
      throw new BadRequestException(`Unsupported file type: .${ext}. Only PDF, DOCX, TXT, and Markdown files are supported.`);
    }

    if (!parsed.content || parsed.content.trim() === '') {
      throw new BadRequestException('Could not extract text from document or file is empty');
    }

    // 2. Create document record
    const title = cleanTitle(parsed.title || file.originalname);
    const content = sanitizeUnicode(parsed.content);

    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title,
        type: 'file',
        fileName: file.originalname,
        fileType: ext,
        fileSize: file.size,
        content,
        metadata: parsed.metadata,
        status: 'processing',
      },
    });

    // 3. Process chunks and embeddings asynchronously
    this.indexDocument(document.id, instanceId, content).catch((err) => {
      this.logger.error(`Error indexing document ${document.id}: ${err.message}`);
    });

    return document;
  }

  /**
   * Add manual FAQ
   */
  public async addFaq(instanceName: string, data: { question: string; answer: string; title?: string }) {
    if (!data.question || !data.answer) {
      throw new BadRequestException('Both question and answer are required');
    }

    const instanceId = await this.getInstanceId(instanceName);
    const title = cleanTitle(data.title || `FAQ: ${data.question.substring(0, 50)}...`);
    const content = sanitizeUnicode(`Question: ${data.question}\nAnswer: ${data.answer}`);

    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title,
        type: 'faq',
        content,
        metadata: { question: sanitizeUnicode(data.question), answer: sanitizeUnicode(data.answer) },
        status: 'processing',
      },
    });

    this.indexDocument(document.id, instanceId, content).catch((err) => {
      this.logger.error(`Error indexing FAQ ${document.id}: ${err.message}`);
    });

    return document;
  }

  /**
   * Ingest website URL with SSRF protection
   */
  public async addUrl(instanceName: string, urlString: string) {
    if (!urlString) {
      throw new BadRequestException('URL is required');
    }

    const instanceId = await this.getInstanceId(instanceName);

    // SSRF safe parse
    const parsed = await documentParserService.parseUrl(urlString);
    const title = cleanTitle(parsed.title || urlString);
    const content = sanitizeUnicode(parsed.content);

    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title,
        type: 'url',
        sourceUrl: urlString,
        content,
        metadata: parsed.metadata,
        status: 'processing',
      },
    });

    this.indexDocument(document.id, instanceId, content).catch((err) => {
      this.logger.error(`Error indexing URL ${document.id}: ${err.message}`);
    });

    return document;
  }

  /**
   * Add or update business info block (products, prices, policies, opening hours)
   */
  public async saveBusinessInfo(
    instanceName: string,
    data: {
      category: 'hours' | 'policies' | 'services' | 'prices' | 'about';
      title: string;
      content: string;
    },
  ) {
    if (!data.title || !data.content) {
      throw new BadRequestException('Title and content are required');
    }

    const instanceId = await this.getInstanceId(instanceName);
    const title = cleanTitle(`[Business ${data.category.toUpperCase()}] ${data.title}`);
    const content = sanitizeUnicode(data.content);

    // Upsert or create
    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title,
        type: 'business_info',
        content,
        metadata: { category: data.category },
        status: 'processing',
      },
    });

    this.indexDocument(document.id, instanceId, content).catch((err) => {
      this.logger.error(`Error indexing business info ${document.id}: ${err.message}`);
    });

    return document;
  }

  /**
   * Indexes a document: chunks text, computes embeddings, and stores chunks
   */
  public async indexDocument(documentId: string, instanceId: string, content: string): Promise<void> {
    try {
      // 1. Delete any existing chunks for document
      await (this.prismaRepository as any).knowledgeChunk.deleteMany({
        where: { documentId },
      });

      // 2. Chunk text with surrogate safety
      const chunks = this.ragService.chunkText(content);
      if (chunks.length === 0) {
        await (this.prismaRepository as any).knowledgeDocument.update({
          where: { id: documentId },
          data: { status: 'indexed', chunkCount: 0 },
        });
        return;
      }

      // 3. Fetch embedding settings (auto-creates default assistant config if missing)
      const embSettings = await this.getEmbeddingSettings(instanceId);

      // 4. Generate embeddings and persist chunks
      for (const chunk of chunks) {
        const sanitizedChunkContent = sanitizeUnicode(chunk.content);
        const embedding = await this.ragService.generateEmbedding(
          sanitizedChunkContent,
          embSettings.provider,
          embSettings.model,
          embSettings.apiUrl,
          embSettings.apiKey,
        );

        await (this.prismaRepository as any).knowledgeChunk.create({
          data: {
            documentId,
            instanceId,
            chunkIndex: chunk.chunkIndex,
            content: sanitizedChunkContent,
            embedding,
            tokenCount: chunk.tokenCount,
          },
        });
      }

      // 5. Update document status
      await (this.prismaRepository as any).knowledgeDocument.update({
        where: { id: documentId },
        data: {
          status: 'indexed',
          chunkCount: chunks.length,
          errorMessage: null,
        },
      });

      this.logger.info(`Successfully indexed document ${documentId} with ${chunks.length} chunks`);
    } catch (error: any) {
      this.logger.error(`Failed to index document ${documentId}: ${error.message}`);
      await (this.prismaRepository as any).knowledgeDocument.update({
        where: { id: documentId },
        data: {
          status: 'error',
          errorMessage: error.message,
        },
      });
    }
  }

  /**
   * Reprocesses an existing document
   */
  public async reprocessDocument(instanceName: string, documentId: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const doc = await (this.prismaRepository as any).knowledgeDocument.findFirst({
      where: { id: documentId, instanceId },
    });

    if (!doc) {
      throw new NotFoundException('Document not found');
    }

    const cleanDocTitle = cleanTitle(doc.title);
    const cleanDocContent = sanitizeUnicode(doc.content);

    await (this.prismaRepository as any).knowledgeDocument.update({
      where: { id: documentId },
      data: {
        title: cleanDocTitle,
        content: cleanDocContent,
        status: 'processing',
      },
    });

    await this.indexDocument(documentId, instanceId, cleanDocContent);

    return { message: 'Document reprocessed successfully' };
  }

  /**
   * Delete a document and its chunks
   */
  public async deleteDocument(instanceName: string, documentId: string) {
    const instanceId = await this.getInstanceId(instanceName);

    const doc = await (this.prismaRepository as any).knowledgeDocument.findFirst({
      where: { id: documentId, instanceId },
    });

    if (!doc) {
      throw new NotFoundException('Document not found');
    }

    await (this.prismaRepository as any).knowledgeDocument.delete({
      where: { id: documentId },
    });

    return { message: 'Document deleted successfully' };
  }

  /**
   * Test knowledge search
   */
  public async searchKnowledge(instanceName: string, query: string, topK = 4) {
    if (!query) {
      throw new BadRequestException('Search query is required');
    }

    const instanceId = await this.getInstanceId(instanceName);
    const embSettings = await this.getEmbeddingSettings(instanceId);

    const results = await this.ragService.retrieveRelevantChunks(
      instanceId,
      query,
      topK,
      0.1, // lower threshold for search preview
      embSettings,
    );

    return results;
  }
}
