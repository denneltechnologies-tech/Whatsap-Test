import assert from 'node:assert';
import { DeduplicationService } from '../src/api/integrations/chatbot/customAi/services/deduplication.service';
import { DocumentParserService } from '../src/api/integrations/chatbot/customAi/services/documentParser.service';
import { RagService } from '../src/api/integrations/chatbot/customAi/services/rag.service';

async function runTests() {
  console.log('--- Running Custom AI Platform Test Suite ---');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}:`, err.message);
      failed++;
    }
  }

  // 1. Deduplication Service Tests
  await test('Deduplication: acquires in-flight lock and rejects duplicates', async () => {
    const dedup = new DeduplicationService();
    const msgId = 'test-msg-123';

    // First acquire should succeed
    const first = await dedup.acquireLock(msgId);
    assert.strictEqual(first, true, 'First lock acquire should succeed');

    // Second acquire while in-flight should fail
    const second = await dedup.acquireLock(msgId);
    assert.strictEqual(second, false, 'Duplicate acquire during in-flight should return false');

    // Mark as processed
    dedup.markProcessed(msgId);

    // Third acquire after being marked processed should still fail
    const third = await dedup.acquireLock(msgId);
    assert.strictEqual(third, false, 'Acquire after processed should return false');
  });

  // 2. Document Parser Tests
  await test('DocumentParser: parses plaintext and markdown accurately', async () => {
    const parser = new DocumentParserService();

    const txtContent = 'Evolution API is a powerful WhatsApp platform.';
    const parsedTxt = parser.parseTextOrMarkdown(Buffer.from(txtContent, 'utf-8'), 'knowledge.txt');
    assert.strictEqual(parsedTxt.content, txtContent);
    assert.strictEqual(parsedTxt.title, 'knowledge');
    assert.strictEqual(parsedTxt.fileType, 'txt');

    const mdContent = '# Business Policies\n\nWe offer a 30-day refund policy on all services.';
    const parsedMd = parser.parseTextOrMarkdown(Buffer.from(mdContent, 'utf-8'), 'policy.md');
    assert.ok(parsedMd.content.includes('Business Policies'));
    assert.strictEqual(parsedMd.fileType, 'md');
  });

  // 3. Security / SSRF Protection Tests
  await test('DocumentParser (SSRF Protection): rejects private/loopback/cloud metadata IP addresses', async () => {
    const parser = new DocumentParserService();

    // Direct IP checks
    assert.strictEqual(parser.isPrivateIP('127.0.0.1'), true, '127.0.0.1 must be private');
    assert.strictEqual(parser.isPrivateIP('10.0.0.1'), true, '10.0.0.1 must be private');
    assert.strictEqual(parser.isPrivateIP('172.16.0.1'), true, '172.16.0.1 must be private');
    assert.strictEqual(parser.isPrivateIP('192.168.1.1'), true, '192.168.1.1 must be private');
    assert.strictEqual(parser.isPrivateIP('169.254.169.254'), true, 'AWS metadata IP must be private');
    assert.strictEqual(parser.isPrivateIP('::1'), true, 'IPv6 loopback must be private');
    assert.strictEqual(parser.isPrivateIP('8.8.8.8'), false, '8.8.8.8 is a public IP');

    // URL validation check
    const dangerousUrls = [
      'http://localhost:8080/secret',
      'http://127.0.0.1:5432/',
      'http://169.254.169.254/latest/meta-data/',
      'ftp://example.com/file.txt',
    ];

    for (const url of dangerousUrls) {
      let rejected = false;
      try {
        await parser.validateUrl(url);
      } catch (err: any) {
        rejected = true;
        assert.ok(
          err.message.includes('forbidden') ||
            err.message.includes('protocols are allowed') ||
            err.message.includes('DNS resolution failed'),
          `Expected SSRF/protocol rejection, got: ${err.message}`,
        );
      }
      assert.strictEqual(rejected, true, `Should have rejected SSRF URL: ${url}`);
    }
  });

  // 4. RAG Chunker & Embedding Tests
  await test('RagService: recursive chunking splits long texts properly with overlap', async () => {
    const mockPrisma = {} as any;
    const rag = new RagService(mockPrisma);

    const longText = Array(15)
      .fill('This is a business sentence explaining customer support and refund policies.')
      .join(' ');

    const chunks = rag.chunkText(longText, 150, 30);
    assert.ok(chunks.length > 1, 'Should create multiple chunks');
    assert.ok(chunks[0].content.length <= 250, 'Chunk size within reasonable limit');
    assert.strictEqual(chunks[0].chunkIndex, 0);
    assert.strictEqual(chunks[1].chunkIndex, 1);
  });

  // 5. Vector Cosine Similarity Tests
  await test('RagService: cosine similarity correctly scores vector alignment', async () => {
    const mockPrisma = {} as any;
    const rag = new RagService(mockPrisma);

    const vecA = [1, 0, 0];
    const vecB = [1, 0, 0];
    const vecC = [0, 1, 0];
    const vecD = [-1, 0, 0];

    const simIdentical = rag.cosineSimilarity(vecA, vecB);
    assert.ok(Math.abs(simIdentical - 1.0) < 0.001, 'Identical vectors should have similarity ~1.0');

    const simOrthogonal = rag.cosineSimilarity(vecA, vecC);
    assert.ok(Math.abs(simOrthogonal - 0.0) < 0.001, 'Orthogonal vectors should have similarity ~0.0');

    const simOpposite = rag.cosineSimilarity(vecA, vecD);
    assert.ok(Math.abs(simOpposite - -1.0) < 0.001, 'Opposite vectors should have similarity ~-1.0');
  });

  // 6. Pluggable Fallback Deterministic Embeddings Test
  await test('RagService: fallback deterministic embeddings produce fixed-size normalized vectors', async () => {
    const mockPrisma = {} as any;
    const rag = new RagService(mockPrisma);

    // Call generateEmbedding without an API key -> falls back to deterministic embedding
    const emb1 = await rag.generateEmbedding('What are your business opening hours?', 'none');
    assert.strictEqual(emb1.length, 384, 'Should produce 384-dimensional embedding');

    // Vector magnitude should be approximately 1.0 (normalized)
    const norm = Math.sqrt(emb1.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1.0) < 0.01, `Embedding norm should be ~1.0, got ${norm}`);

    const emb2 = await rag.generateEmbedding('What are your business opening hours?', 'none');
    // Deterministic test
    assert.deepStrictEqual(emb1, emb2, 'Identical input should produce identical embedding');

    const embDifferent = await rag.generateEmbedding('Completely different query about returns', 'none');
    const sim = rag.cosineSimilarity(emb1, embDifferent);
    assert.ok(sim < 0.95, 'Different text should produce different embedding vectors');
  });

  console.log(`\nTests Completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
