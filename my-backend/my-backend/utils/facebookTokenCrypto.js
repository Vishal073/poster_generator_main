const crypto = require("crypto");

const TOKEN_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey = null;

function parseEncryptionKey(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }

  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, "hex");
  }

  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) {
    return base64;
  }

  const error = new Error(
    "FACEBOOK_TOKEN_ENCRYPTION_KEY must be 32 bytes (use `openssl rand -base64 32`).",
  );
  error.statusCode = 500;
  throw error;
}

function getEncryptionKey() {
  if (cachedKey) {
    return cachedKey;
  }

  const fromEnv = parseEncryptionKey(process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY);
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  if (process.env.NODE_ENV === "production") {
    const error = new Error(
      "FACEBOOK_TOKEN_ENCRYPTION_KEY is required in production.",
    );
    error.statusCode = 500;
    throw error;
  }

  console.warn(
    "[Facebook tokens] FACEBOOK_TOKEN_ENCRYPTION_KEY is not set — using a dev-only derived key. Set a 32-byte key before production.",
  );
  cachedKey = crypto
    .createHash("sha256")
    .update(String(process.env.FACEBOOK_APP_SECRET || "dev-facebook-token-key"))
    .digest();
  return cachedKey;
}

function isEncryptedToken(value) {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX);
}

function encryptToken(plainText) {
  if (!plainText || typeof plainText !== "string") {
    return plainText || "";
  }

  if (isEncryptedToken(plainText)) {
    return plainText;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${TOKEN_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptToken(stored) {
  if (!stored || typeof stored !== "string") {
    return stored || "";
  }

  if (!isEncryptedToken(stored)) {
    return stored;
  }

  const body = stored.slice(TOKEN_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    const error = new Error("Stored Facebook token has invalid encrypted format.");
    error.statusCode = 500;
    throw error;
  }

  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const encrypted = Buffer.from(dataB64, "base64url");

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (error) {
    console.warn(
      "[Facebook tokens] Failed to decrypt stored token — reconnect Facebook if posting fails:",
      error instanceof Error ? error.message : String(error),
    );
    return "";
  }
}

module.exports = {
  encryptToken,
  decryptToken,
  isEncryptedToken,
  getEncryptionKey,
};
