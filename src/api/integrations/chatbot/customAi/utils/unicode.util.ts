/**
 * Unicode and Text Sanitization Utilities for AI Knowledge Base & Embeddings
 * Prevents PostgreSQL database encoding errors caused by unpaired UTF-16 surrogates,
 * null characters (\0), or invalid characters.
 */

/**
 * Strips lone/unpaired UTF-16 surrogates and PostgreSQL-incompatible null bytes (\0)
 */
export function sanitizeUnicode(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // 1. Remove null bytes (\u0000) which cause PostgreSQL text fields to crash
  let clean = text.replace(/\0/g, '');

  // 2. Remove unpaired high surrogates (\uD800-\uDBFF not followed by \uDC00-\uDFFF)
  // and unpaired low surrogates (\uDC00-\uDFFF not preceded by \uD800-\uDBFF)
  clean = clean.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  // 3. In Node 20+, native toWellFormed ensures all code points are valid
  if (typeof (clean as any).toWellFormed === 'function') {
    clean = (clean as any).toWellFormed();
  }

  // 4. Double check: remove any leftover lone surrogates or replacement char from malformed bytes
  clean = clean.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  return clean;
}

/**
 * Decodes HTML entities into human-readable characters
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    });
}

/**
 * Cleans, decodes entities, and sanitizes document titles
 */
export function cleanTitle(title: string): string {
  if (!title || typeof title !== 'string') {
    return 'Untitled Document';
  }

  let cleaned = decodeHtmlEntities(title);
  cleaned = sanitizeUnicode(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || 'Untitled Document';
}
