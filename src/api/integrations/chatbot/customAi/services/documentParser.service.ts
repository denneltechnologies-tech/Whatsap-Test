import { Logger } from '@config/logger.config';
import axios from 'axios';
import dns from 'dns';
import net from 'net';

import { cleanTitle, decodeHtmlEntities, sanitizeUnicode } from '../utils/unicode.util';

export interface ParsedDocument {
  title: string;
  content: string;
  fileType?: string;
  metadata?: Record<string, any>;
}

export class DocumentParserService {
  private readonly logger = new Logger('DocumentParserService');

  /**
   * SSRF Protection: Checks if an IP is within private/reserved ranges
   */
  public isPrivateIP(ip: string): boolean {
    if (!net.isIP(ip)) return true;

    // IPv4 checks
    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map(Number);
      // 127.0.0.0/8 (Loopback)
      if (parts[0] === 127) return true;
      // 10.0.0.0/8 (Private)
      if (parts[0] === 10) return true;
      // 172.16.0.0/12 (Private)
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      // 192.168.0.0/16 (Private)
      if (parts[0] === 192 && parts[1] === 168) return true;
      // 169.254.0.0/16 (Link-local / AWS metadata)
      if (parts[0] === 169 && parts[1] === 254) return true;
      // 0.0.0.0/8
      if (parts[0] === 0) return true;
      return false;
    }

    // IPv6 checks
    if (net.isIPv6(ip)) {
      const lower = ip.toLowerCase();
      if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc00:') || lower.startsWith('fd')) {
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Validates a URL for SSRF vulnerabilities
   */
  public async validateUrl(urlString: string): Promise<URL> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      throw new Error('Invalid URL format');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS protocols are allowed');
    }

    const hostname = parsedUrl.hostname;
    if (hostname.toLowerCase() === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      throw new Error('Access to local address is forbidden');
    }

    // Resolve DNS and verify IP
    try {
      const lookup = await dns.promises.lookup(hostname, { all: true });
      for (const address of lookup) {
        if (this.isPrivateIP(address.address)) {
          throw new Error(`Access to private IP address (${address.address}) is forbidden`);
        }
      }
    } catch (err: any) {
      if (err.message && err.message.includes('forbidden')) {
        throw err;
      }
      throw new Error(`DNS resolution failed for hostname: ${hostname}`);
    }

    return parsedUrl;
  }

  /**
   * Parses uploaded text or markdown buffer
   */
  public parseTextOrMarkdown(buffer: Buffer, filename: string): ParsedDocument {
    const rawContent = buffer.toString('utf-8');
    const content = sanitizeUnicode(rawContent).trim();
    const title = cleanTitle(filename.replace(/\.[^/.]+$/, ''));
    return {
      title,
      content,
      fileType: filename.endsWith('.md') ? 'md' : 'txt',
      metadata: { length: content.length, filename },
    };
  }

  /**
   * Parses PDF file buffer
   */
  public async parsePdf(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const title = cleanTitle(filename.replace(/\.[^/.]+$/, ''));
    try {
      // Dynamic import to handle optional dependency gracefully
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = (pdfParseModule as any).default || pdfParseModule;
      const data = await pdfParse(buffer);
      const content = sanitizeUnicode(data.text ? data.text.trim() : '');

      return {
        title,
        content,
        fileType: 'pdf',
        metadata: {
          pages: data.numpages,
          info: data.info,
          filename,
        },
      };
    } catch (error: any) {
      this.logger.error(`Error parsing PDF ${filename}: ${error.message}`);
      // Fallback: extract visible ASCII text from buffer
      const text = buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
      const content = sanitizeUnicode(text.length > 50 ? text : `[PDF content could not be fully parsed: ${error.message}]`);
      return {
        title,
        content,
        fileType: 'pdf',
        metadata: { filename, error: error.message },
      };
    }
  }

  /**
   * Parses Word DOCX file buffer
   */
  public async parseDocx(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const title = cleanTitle(filename.replace(/\.[^/.]+$/, ''));
    try {
      const mammothModule = await import('mammoth');
      const mammoth = (mammothModule as any).default || mammothModule;
      const result = await mammoth.extractRawText({ buffer });
      const content = sanitizeUnicode(result.value ? result.value.trim() : '');

      return {
        title,
        content,
        fileType: 'docx',
        metadata: {
          warnings: result.messages,
          filename,
        },
      };
    } catch (error: any) {
      this.logger.error(`Error parsing DOCX ${filename}: ${error.message}`);
      throw new Error(`Failed to parse DOCX document: ${error.message}`);
    }
  }

  /**
   * Fetches and extracts textual content from a webpage with SSRF guard
   */
  public async parseUrl(urlString: string): Promise<ParsedDocument> {
    const validatedUrl = await this.validateUrl(urlString);

    try {
      const response = await axios.get(validatedUrl.toString(), {
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024, // 5MB limit
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 BusinessBot/1.0',
          'Accept': 'text/html,application/xhtml+xml,text/plain',
        },
      });

      const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const text = this.stripHtml(html);

      // Extract and clean page title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const rawTitle = titleMatch ? titleMatch[1].trim() : validatedUrl.hostname;
      const title = cleanTitle(rawTitle);

      return {
        title,
        content: text,
        fileType: 'url',
        metadata: {
          url: validatedUrl.toString(),
          hostname: validatedUrl.hostname,
          fetchedAt: new Date().toISOString(),
        },
      };
    } catch (error: any) {
      this.logger.error(`Error fetching URL ${urlString}: ${error.message}`);
      throw new Error(`Failed to ingest URL content: ${error.message}`);
    }
  }

  /**
   * Strips HTML tags, styles, scripts, decodes entities, and normalizes text
   */
  public stripHtml(html: string): string {
    const stripped = html
      // Remove head, script, style, noscript tags and their contents
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Replace block tags with newlines
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    const decoded = decodeHtmlEntities(stripped);

    // Clean up excess whitespace and sanitize Unicode
    const normalized = decoded
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();

    return sanitizeUnicode(normalized);
  }
}

export const documentParserService = new DocumentParserService();
