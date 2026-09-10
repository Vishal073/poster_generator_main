const { sendWhatsAppText } = require("./whatsappService");
const { generateCaption } = require("../utils/captionGenerateService");
const { isGcrGraphixGreeting } = require("../utils/portalAuth");

/** Optional session after greeting; free text also works without it. */
const pendingCaptionSessions = new Map();

const CAPTION_SESSION_TTL_MS =
  Number(process.env.CAPTION_SESSION_TTL_MS || 30 * 60 * 1000) || 30 * 60 * 1000;

function normalizeChatText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function sessionKey(fromWhatsAppNumber) {
  return String(fromWhatsAppNumber || "").trim().toLowerCase();
}

function getCaptionSession(fromWhatsAppNumber) {
  const key = sessionKey(fromWhatsAppNumber);
  const session = pendingCaptionSessions.get(key);
  if (!session) {
    return null;
  }
  if (Date.now() - session.updatedAt > CAPTION_SESSION_TTL_MS) {
    pendingCaptionSessions.delete(key);
    return null;
  }
  return session;
}

function setCaptionSession(fromWhatsAppNumber, updates) {
  const key = sessionKey(fromWhatsAppNumber);
  const existing = pendingCaptionSessions.get(key) || {};
  pendingCaptionSessions.set(key, {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  });
}

function clearCaptionSession(fromWhatsAppNumber) {
  pendingCaptionSessions.delete(sessionKey(fromWhatsAppNumber));
}

function hasActiveCaptionSession(fromWhatsAppNumber) {
  return Boolean(getCaptionSession(fromWhatsAppNumber));
}

/** Short commands that must not become captions (menu / control). */
function isReservedChatCommand(text) {
  const normalized = normalizeChatText(text);
  if (!normalized) {
    return true;
  }

  if (isGcrGraphixGreeting(text)) {
    return true;
  }

  const reserved = new Set([
    "cancel",
    "stop",
    "exit",
    "menu",
    "hi",
    "hello",
    "hey",
    "hii",
    "hiii",
    "namaste",
    "namaskar",
    "help",
    "start",
    "1",
    "2",
    "3",
    "4",
    "5",
    "register",
    "login",
    "account",
    "facebook",
    "instagram",
    "fb",
    "ig",
    "support",
    "download",
    "approve",
    "skip",
  ]);

  return reserved.has(normalized);
}

async function startCaptionFlow(fromWhatsAppNumber, options = {}) {
  setCaptionSession(fromWhatsAppNumber, {
    status: "awaiting_text",
  });

  if (options.silent) {
    return { handled: true, type: "caption_session_started" };
  }

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body:
      `Event / post ka text bhejo — main Hindi caption banaunga.\n` +
      `Band: *cancel*`,
  });
  return { handled: true, type: "caption_prompt" };
}

async function generateAndSendCaption(fromWhatsAppNumber, rawText) {
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: "Caption bana raha hoon…",
  });

  const result = await generateCaption(rawText);
  setCaptionSession(fromWhatsAppNumber, {
    status: "awaiting_text",
    lastStyle: result.style,
  });

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: result.caption,
  });

  return { handled: true, type: "caption_ready", style: result.style };
}

/**
 * Free-text → AI caption (no Hi / menu required).
 * Reserved commands and greetings are left for the chatbot.
 */
async function handleWhatsAppCaption({ fromWhatsAppNumber, bodyText }) {
  const text = String(bodyText || "").trim();
  if (!text) {
    return { handled: false };
  }

  if (isGcrGraphixGreeting(text)) {
    return { handled: false, reason: "greeting" };
  }

  const normalized = normalizeChatText(text);

  if (["cancel", "stop", "exit"].includes(normalized)) {
    if (hasActiveCaptionSession(fromWhatsAppNumber)) {
      clearCaptionSession(fromWhatsAppNumber);
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body: "Caption mode band.",
      });
      return { handled: true, type: "caption_cancelled" };
    }
    return { handled: false };
  }

  if (isReservedChatCommand(text)) {
    return { handled: false, reason: "reserved" };
  }

  try {
    return await generateAndSendCaption(fromWhatsAppNumber, text);
  } catch (error) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: `Caption nahi bani: ${getErrorMessage(error)}\n\nPhir se text bhejo.`,
    });
    return { handled: true, type: "caption_error" };
  }
}

module.exports = {
  handleWhatsAppCaption,
  startCaptionFlow,
  hasActiveCaptionSession,
  clearCaptionSession,
  pendingCaptionSessions,
  isReservedChatCommand,
};
