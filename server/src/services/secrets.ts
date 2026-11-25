import { createHash, timingSafeEqual } from "node:crypto";

/** Whether two secrets are the same, in time that doesn't depend on where they differ. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
