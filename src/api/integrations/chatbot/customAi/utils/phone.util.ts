/**
 * Phone number normalization utilities for WhatsApp messaging
 */

export function normalizeWhatsAppNumber(phone: string): string {
  if (!phone) return '';
  let digits = phone.trim().replace(/\D/g, '');

  // Strip international dialing prefixes (e.g., 00)
  if (digits.startsWith('00')) {
    digits = digits.substring(2);
  }

  // Ghana local 10-digit mobile numbers starting with '0'
  // (e.g., 024..., 027..., 050..., 054..., 055..., 059..., 020..., 026..., 028...)
  if (digits.startsWith('0') && digits.length === 10) {
    digits = '233' + digits.substring(1);
  }

  // Ghana 13-digit format with country code and redundant local 0 (e.g., 2330273557256)
  if (digits.startsWith('2330') && digits.length === 13) {
    digits = '233' + digits.substring(4);
  }

  // UK local 11-digit mobile format starting with '07'
  if (digits.startsWith('07') && digits.length === 11) {
    digits = '44' + digits.substring(1);
  }

  return digits;
}
