import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Performs a constant-time comparison of two strings to prevent timing attack vulnerabilities.
 * Hashes both strings with SHA-256 before invoking timingSafeEqual, guaranteeing equal-length
 * buffers and eliminating both length-based and character-by-character timing leaks.
 */
export function safeCompare(a?: string | null, b?: string | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }

  const hashA = createHash('sha256').update(a, 'utf-8').digest();
  const hashB = createHash('sha256').update(b, 'utf-8').digest();

  return timingSafeEqual(hashA, hashB);
}
