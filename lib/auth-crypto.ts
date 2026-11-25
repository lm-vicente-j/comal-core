export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < length; i++) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}
import { createHmac } from "node:crypto";


export function createPinLookupHash(pin: string): string {
  if (!/^\d{6}$/.test(pin)) throw new Error("PIN must contain exactly six digits");
  const secret = process.env.PIN_LOOKUP_SECRET;
  if (!secret || secret.length < 32) throw new Error("PIN_LOOKUP_SECRET must contain at least 32 characters");
  return createHmac("sha256", secret).update(pin).digest("hex");
}
