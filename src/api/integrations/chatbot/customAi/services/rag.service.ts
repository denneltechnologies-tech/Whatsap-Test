import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { sanitizeUnicode } from '../utils/unicode.util';

export interface Chunk {
  chunkIndex: number;
  content: string;
  tokenCount?: number;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
}

export class RagService {
  private readonly logger = new Logger('RagService');

  constructor(private readonly prismaRepository: PrismaRepository) {}

  /**
   * Recursively splits text into chunks with overlap while preserving Unicode surrogate pairs
   */
  public chunkText(text: string, chunkSize = 600, chunkOverlap = 100): Chunk[] {
    const cleanText = sanitizeUnicode(text.replace(/\r\n/g, '\n')).trim();
    if (!cleanText) return [];

    if (cleanText.length <= chunkSize) {
      return [{ chunkIndex: 0, content: cleanText, tokenCount: Math.ceil(cleanText.length / 4) }];
    }

    const chunks: Chunk[] = [];
    const separators = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

    let start = 0;
    let chunkIndex = 0;

    while (start < cleanText.length) {
      // Prevent start from splitting a surrogate pair (if start lands on low surrogate, move back 1)
      if (start > 0 && start < cleanText.length) {
        const code = cleanText.charCodeAt(start);
        if (code >= 0xdc00 && code <= 0xdfff) {
          start = Math.max(0, start - 1);
        }
      }

      let end = Math.min(start + chunkSize, cleanText.length);

      if (end < cleanText.length) {
        // Find best split point near end
        let splitFound = false;
        for (const sep of separators) {
          const lastIdx = cleanText.lastIndexOf(sep, end);
          if (lastIdx > start + chunkOverlap) {
            end = lastIdx + sep.length;
            splitFound = true;
            break;
          }
        }
      }

      // Prevent end from splitting a surrogate pair (if end - 1 is high surrogate, include low surrogate)
      if (end > 0 && end < cleanText.length) {
        const code = cleanText.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          end = Math.min(cleanText.length, end + 1);
        }
      }

      const chunkContent = sanitizeUnicode(cleanText.substring(start, end).trim());
      if (chunkContent.length > 20) {
        chunks.push({
          chunkIndex,
          content: chunkContent,
          tokenCount: Math.ceil(chunkContent.length / 4),
        });
        chunkIndex++;
      }

      // Advance with overlap
      let nextStart = end - chunkOverlap;
      if (nextStart <= start) {
        start = end;
      } else {
        // Prevent nextStart from splitting a surrogate pair
        if (nextStart < cleanText.length) {
          const code = cleanText.charCodeAt(nextStart);
          if (code >= 0xdc00 && code <= 0xdfff) {
            nextStart = Math.max(0, nextStart - 1);
          }
        }
        start = nextStart;
      }
    }

    return chunks;
  }

  /**
   * Generates embedding vector for a single string using configured provider
   */
  public async generateEmbedding(
    text: string,
    provider = 'openai',
    model = 'text-embedding-3-small',
    apiUrl = 'https://api.openai.com/v1',
    apiKey?: string,
  ): Promise<number[]> {
    if (!text || text.trim() === '') {
      return [];
    }

    // Trim text and ensure valid Unicode encoding
    const input = sanitizeUnicode(text.substring(0, 8000));

    // If an API key is provided, use the remote embedding provider
    if (apiKey && apiKey.trim() !== '') {
      try {
        const cleanBaseUrl = apiUrl ? apiUrl.replace(/\/+$/, '') : 'https://api.openai.com/v1';
        const endpoint = cleanBaseUrl.endsWith('/embeddings') ? cleanBaseUrl : `${cleanBaseUrl}/embeddings`;

        const response = await axios.post(
          endpoint,
          {
            input,
            model: model || 'text-embedding-3-small',
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          },
        );

        if (response.data?.data?.[0]?.embedding) {
          return response.data.data[0].embedding;
        }
      } catch (err: any) {
        this.logger.warn(`Remote embedding API error: ${err.response?.data?.error?.message || err.message}. Falling back to semantic vector hash.`);
      }
    }

    // Deterministic semantic feature vector fallback (384-dimensional normalized vector)
    return this.createFallbackEmbedding(input, 384);
  }

  /**
   * Fallback deterministic embedding based on ngram hashing and token distributions
   * Guarantees that similar texts have high cosine similarity even without remote API keys
   */
  public createFallbackEmbedding(text: string, dimensions = 384): number[] {
    const vector = new Array(dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ');
    const tokens = normalized.split(/\s+/).filter(Boolean);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      let hash = 0;
      for (let j = 0; j < token.length; j++) {
        hash = (hash << 5) - hash + token.charCodeAt(j);
        hash |= 0;
      }
      const index = Math.abs(hash) % dimensions;
      vector[index] += 1;

      // Bigram feature
      if (i < tokens.length - 1) {
        const bigram = token + '_' + tokens[i + 1];
        let biHash = 0;
        for (let j = 0; j < bigram.length; j++) {
          biHash = (biHash << 5) - biHash + bigram.charCodeAt(j);
          biHash |= 0;
        }
        const biIndex = Math.abs(biHash) % dimensions;
        vector[biIndex] += 1.5;
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map((val) => val / norm);
  }

  /**
   * Calculates cosine similarity between two numeric vectors
   */
  public cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Retrieves top-K knowledge chunks for a query
   */
  public async retrieveRelevantChunks(
    instanceId: string,
    query: string,
    topK = 4,
    minScore = 0.35,
    embeddingConfig?: {
      provider?: string;
      model?: string;
      apiUrl?: string;
      apiKey?: string;
    },
  ): Promise<RetrievedChunk[]> {
    const cleanQuery = sanitizeUnicode(query).trim();
    if (!cleanQuery) return [];

    try {
      // 1. Generate query embedding
      const queryEmbedding = await this.generateEmbedding(
        cleanQuery,
        embeddingConfig?.provider,
        embeddingConfig?.model,
        embeddingConfig?.apiUrl,
        embeddingConfig?.apiKey,
      );

      // 2. Fetch chunks with their parent document
      const chunks = await (this.prismaRepository as any).knowledgeChunk.findMany({
        where: {
          instanceId,
        },
        include: {
          Document: {
            select: {
              title: true,
              status: true,
            },
          },
        },
      });

      if (!chunks || chunks.length === 0) {
        return [];
      }

      // 3. Compute cosine similarity for each chunk
      const scoredChunks: RetrievedChunk[] = [];

      for (const chunk of chunks) {
        // Skip chunks from documents that failed or were deleted
        if (chunk.Document?.status === 'error') continue;

        let score = 0;
        const chunkEmbedding = chunk.embedding as number[];

        if (chunkEmbedding && Array.isArray(chunkEmbedding) && chunkEmbedding.length === queryEmbedding.length) {
          score = this.cosineSimilarity(queryEmbedding, chunkEmbedding);
        }

        const kwScore = this.keywordOverlapScore(query, chunk.content);
        // Hybrid score combines semantic vector score with keyword match
        const finalScore = Math.max(score, kwScore);

        scoredChunks.push({
          id: chunk.id,
          documentId: chunk.documentId,
          documentTitle: chunk.Document?.title || 'Document',
          content: chunk.content,
          score: finalScore,
        });
      }

      // 4. Sort descending by score
      scoredChunks.sort((a, b) => b.score - a.score);

      // If top chunks meet threshold, return them
      const passing = scoredChunks.filter((c) => c.score >= minScore);
      if (passing.length > 0) {
        return passing.slice(0, topK);
      }

      // If query is broad (e.g. 'what are your services', 'about') and nothing cleared minScore,
      // return the best available chunks so the AI has real business facts to ground its response
      if (scoredChunks.length > 0) {
        return scoredChunks.slice(0, topK);
      }

      return [];
    } catch (error: any) {
      this.logger.error(`Error retrieving knowledge chunks: ${error.message}`);
      return [];
    }
  }

  /**
   * Fallback lexical overlap score
   */
  private keywordOverlapScore(query: string, content: string): number {
    const qWords = new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (qWords.size === 0) return 0;

    const cWords = new Set(content.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    let matches = 0;

    qWords.forEach((word) => {
      if (cWords.has(word)) matches++;
    });

    return matches / qWords.size;
  }

  /**
   * Formats retrieved chunks into a prompt context section
   */
  public formatContextForPrompt(chunks: RetrievedChunk[]): string {
    if (!chunks || chunks.length === 0) {
      return '';
    }

    let context = '### BUSINESS KNOWLEDGE BASE (GROUNDING FACTS):\n';
    context += 'Use ONLY the verified facts below to answer the user inquiry. Do not invent details.\n\n';

    chunks.forEach((chunk, index) => {
      context += `[Source ${index + 1}: ${chunk.documentTitle} (relevance: ${(chunk.score * 100).toFixed(0)}%)]\n`;
      context += `${chunk.content}\n\n`;
    });

    return context.trim();
  }
}
