import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';

import { documentParserService } from '../services/documentParser.service';
import { RagService } from '../services/rag.service';

export class KnowledgeController {
  private readonly logger = new Logger('KnowledgeController');

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly ragService: RagService,
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
   */
  private async getEmbeddingSettings(instanceId: string) {
    const config = await this.prismaRepository.aiAssistantConfig.findUnique({
      where: { instanceId },
    });
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
    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title: parsed.title,
        type: 'file',
        fileName: file.originalname,
        fileType: ext,
        fileSize: file.size,
        content: parsed.content,
        metadata: parsed.metadata,
        status: 'processing',
      },
    });

    // 3. Process chunks and embeddings asynchronously
    this.indexDocument(document.id, instanceId, parsed.content).catch((err) => {
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
    const title = data.title || `FAQ: ${data.question.substring(0, 50)}...`;
    const content = `Question: ${data.question}\nAnswer: ${data.answer}`;

    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title,
        type: 'faq',
        content,
        metadata: { question: data.question, answer: data.answer },
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

    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title: parsed.title || urlString,
        type: 'url',
        sourceUrl: urlString,
        content: parsed.content,
        metadata: parsed.metadata,
        status: 'processing',
      },
    });

    this.indexDocument(document.id, instanceId, parsed.content).catch((err) => {
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

    // Upsert or create
    const document = await (this.prismaRepository as any).knowledgeDocument.create({
      data: {
        instanceId,
        title: `[Business ${data.category.toUpperCase()}] ${data.title}`,
        type: 'business_info',
        content: data.content,
        metadata: { category: data.category },
        status: 'processing',
      },
    });

    this.indexDocument(document.id, instanceId, data.content).catch((err) => {
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

      // 2. Chunk text
      const chunks = this.ragService.chunkText(content);
      if (chunks.length === 0) {
        await (this.prismaRepository as any).knowledgeDocument.update({
          where: { id: documentId },
          data: { status: 'indexed', chunkCount: 0 },
        });
        return;
      }

      // 3. Fetch embedding settings
      const embSettings = await this.getEmbeddingSettings(instanceId);

      // 4. Generate embeddings and persist chunks
      for (const chunk of chunks) {
        const embedding = await this.ragService.generateEmbedding(
          chunk.content,
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
            content: chunk.content,
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

    await (this.prismaRepository as any).knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'processing' },
    });

    await this.indexDocument(documentId, instanceId, doc.content);

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
