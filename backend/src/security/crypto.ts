import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

export type EncryptedValue = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export function decodeKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return key;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function randomOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function encrypt(value: string | Buffer, key: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const input = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decrypt(value: EncryptedValue, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, value.iv);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}

export function encryptPacked(value: string, key: Buffer): Buffer {
  const encrypted = encrypt(value, key);
  return Buffer.concat([encrypted.iv, encrypted.authTag, encrypted.ciphertext]);
}
