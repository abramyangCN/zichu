const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveKey(secret: string, purpose: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  const algorithm: AesDerivedKeyParams | HmacImportParams = usage.includes("sign")
    ? { name: "HMAC", hash: "SHA-256", length: 256 }
    : { name: "AES-GCM", length: 256 };
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("izchu:v1"),
      info: encoder.encode(purpose),
    },
    material,
    algorithm,
    false,
    usage,
  );
}

export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret, "database encryption", ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  const output = new Uint8Array(iv.length + ciphertext.length);
  output.set(iv);
  output.set(ciphertext, iv.length);
  return toBase64Url(output);
}

export async function decrypt(secret: string, value: string): Promise<string> {
  const bytes = fromBase64Url(value);
  const key = await deriveKey(secret, "database encryption", ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return decoder.decode(plaintext);
}

async function signature(secret: string, value: string): Promise<string> {
  const key = await deriveKey(secret, "session signing", ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function createSession(secret: string): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })),
  );
  return `${payload}.${await signature(secret, payload)}`;
}

export async function verifySession(secret: string, session: string | undefined): Promise<boolean> {
  if (!session) return false;
  const [payload, suppliedSignature] = session.split(".");
  if (!payload || !suppliedSignature) return false;
  const expectedSignature = await signature(secret, payload);
  if (!(await safeEqual(expectedSignature, suppliedSignature))) return false;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as { expiresAt: number };
    return Number.isFinite(parsed.expiresAt) && parsed.expiresAt > Date.now();
  } catch {
    return false;
  }
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0 && left.length === right.length;
}
