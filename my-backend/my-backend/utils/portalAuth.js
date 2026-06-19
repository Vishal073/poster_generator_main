const crypto = require("crypto");
const LoginToken = require("../models/LoginToken");
const RegistrationToken = require("../models/RegistrationToken");
const User = require("../models/User");
const { sendWhatsAppText } = require("../services/whatsappService");

const LOGIN_TOKEN_TTL_MS =
  Number(process.env.LOGIN_TOKEN_TTL_HOURS || 48) * 60 * 60 * 1000;
const REGISTRATION_TOKEN_TTL_MS =
  Number(process.env.REGISTRATION_TOKEN_TTL_HOURS || 48) * 60 * 60 * 1000;

function getPortalBaseUrl() {
  return (process.env.USER_FRONTEND_URL || process.env.FRONTEND_URL || "http://localhost:5173")
    .replace(/\/$/, "");
}

function buildPortalLoginUrl(token) {
  return `${getPortalBaseUrl()}/portal/login?token=${encodeURIComponent(token)}`;
}

function buildPortalRegisterUrl(token) {
  return `${getPortalBaseUrl()}/portal/register?token=${encodeURIComponent(token)}`;
}

function createTokenValue() {
  return crypto.randomBytes(32).toString("hex");
}

function toTenDigitMobile(value) {
  const digits = String(value || "").replace(/^whatsapp:/i, "").replace(/\D/g, "");
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

async function findUserByMobile(value) {
  const tenDigit = toTenDigitMobile(value);
  if (!/^\d{10}$/.test(tenDigit)) {
    return null;
  }

  const directMatch = await User.findOne({ mobileNumber: tenDigit }).lean();
  if (directMatch) {
    return directMatch;
  }

  // Fallback for legacy rows stored with a country prefix or extra characters.
  return User.findOne({ mobileNumber: new RegExp(`${tenDigit}$`) }).lean();
}

function normalizeGreetingText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGcrGraphixGreeting(body) {
  const normalized = normalizeGreetingText(body);
  if (!normalized) {
    return false;
  }

  const phrases = [
    "hi gcr graphix",
    "hello gcr graphix",
    "hey gcr graphix",
    "namaste gcr graphix",
  ];

  return phrases.some(
    (phrase) =>
      normalized === phrase ||
      normalized.startsWith(`${phrase} `) ||
      normalized.endsWith(` ${phrase}`),
  );
}

async function createRegistrationToken(mobileNumber) {
  const token = createTokenValue();
  const expiresAt = new Date(Date.now() + REGISTRATION_TOKEN_TTL_MS);

  await RegistrationToken.create({
    token,
    mobileNumber,
    expiresAt,
  });

  return {
    token,
    expiresAt,
    registerUrl: buildPortalRegisterUrl(token),
  };
}

async function getValidRegistrationToken(token) {
  const doc = await RegistrationToken.findOne({ token: String(token || "").trim() });
  if (!doc || doc.usedAt || doc.expiresAt.getTime() < Date.now()) {
    return null;
  }
  return doc;
}

async function markRegistrationTokenUsed(token) {
  await RegistrationToken.updateOne(
    { token: String(token || "").trim() },
    { $set: { usedAt: new Date() } },
  );
}

async function createLoginLinkForUser(user) {
  const token = createTokenValue();
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS);

  await LoginToken.create({
    token,
    userId: user._id,
    expiresAt,
  });

  return {
    loginUrl: buildPortalLoginUrl(token),
    expiresAt,
  };
}

async function handleGcrGraphixGreeting(fromWhatsAppNumber) {
  const mobileNumber = toTenDigitMobile(fromWhatsAppNumber);
  if (!/^\d{10}$/.test(mobileNumber)) {
    return { handled: false, reason: "invalid_mobile" };
  }

  const user = await findUserByMobile(fromWhatsAppNumber);

  if (user) {
    await sendWhatsAppText({
      toMobile: mobileNumber,
      body: `Hi ${user.name}! Welcome to GCR Graphix.`,
    });
    return { handled: true, type: "existing_user", mobileNumber, name: user.name };
  }

  const { registerUrl } = await createRegistrationToken(mobileNumber);
  await sendWhatsAppText({
    toMobile: mobileNumber,
    body:
      `Hi! You're not registered with GCR Graphix yet.\n\n` +
      `Complete your registration here:\n${registerUrl}`,
  });
  return { handled: true, type: "registration_link", mobileNumber, registerUrl };
}

module.exports = {
  buildPortalLoginUrl,
  buildPortalRegisterUrl,
  createLoginLinkForUser,
  createRegistrationToken,
  findUserByMobile,
  getValidRegistrationToken,
  handleGcrGraphixGreeting,
  isGcrGraphixGreeting,
  markRegistrationTokenUsed,
  toTenDigitMobile,
};
