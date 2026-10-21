import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';

const DEFAULT_JWT_SECRET = 'evolution-ai-default-secret-key-change-in-prod';

/**
 * Hashes password using Node.js crypto.scrypt with a cryptographic salt
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plain text password against a stored salt:hash string
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash || !storedHash.includes(':')) {
    return false;
  }
  try {
    const [salt, key] = storedHash.split(':');
    const derivedKey = scryptSync(password, salt, 64);
    const keyBuffer = Buffer.from(key, 'hex');
    return timingSafeEqual(derivedKey, keyBuffer);
  } catch {
    return false;
  }
}

/**
 * Generates signed JWT token for authenticated session
 */
export function generateToken(payload: Record<string, any>, secret = DEFAULT_JWT_SECRET, expiresIn = '7d'): string {
  return jwt.sign(payload, secret, { expiresIn: expiresIn as any });
}

/**
 * Verifies and decodes JWT token
 */
export function verifyToken(token: string, secret = DEFAULT_JWT_SECRET): any {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}
