interface RandomSource {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

/**
 * Collision-resistant opaque ID (Prototype Profile §11). `randomUUID` is unavailable in insecure browser
 * contexts (e.g. plain HTTP on a LAN address), so fall back to a v4 UUID built from `getRandomValues`.
 */
export function randomId(prefix: string): string {
  const crypto = (globalThis as { crypto?: RandomSource }).crypto;
  if (crypto === undefined) throw new Error("No Web Crypto random source available.");
  if (typeof crypto.randomUUID === "function") return `${prefix}:${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
