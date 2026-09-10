const { sendWhatsAppText } = require("./whatsappService");
const { generateCaption } = require("../utils/captionGenerateService");
const { isGcrGraphixGreeting } = require("../utils/portalAuth");

/** Active after "Hi GCR Graphix" — next free-text messages become captions. */
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

function buildCaptionPromptMessage() {
  return (
    `*AI Caption ready*\n\n` +
    `Ab apne post / event ka short text bhejo.\n` +
    `Main seedha *Hindi caption* banaunga.\n` +
    `(Blood donation, birthday, sports, khushi — shayari; simple update — normal text. AI decide karega.)\n\n` +
    `Example:\n` +
    `जय जगदम्बे ब्लड कैंप में गया, 50 लोगों ने रक्तदान किया\n\n` +
    `Band karne ke liye *cancel* likho.`
  );
}

/**
 * Start caption mode after Hi GCR Graphix (no menu / no 1-2-3).
 */
async function startCaptionFlow(fromWhatsAppNumber, options = {}) {
  setCaptionSession(fromWhatsAppNumber, {
    status: "awaiting_text",
  });

  if (options.silent) {
    return { handled: true, type: "caption_session_started" };
  }

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: buildCaptionPromptMessage(),
  });
  return { handled: true, type: "caption_prompt" };
}

async function generateAndSendCaption(fromWhatsAppNumber, rawText) {
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: "Caption bana raha hoon…",
  });

  const result = await generateCaption(rawText);
  // Keep session open so user can send another note anytime.
  setCaptionSession(fromWhatsAppNumber, {
    status: "awaiting_text",
    lastStyle: result.style,
  });

  const styleLabel = result.style === "shayari" ? "Shayari" : "Normal";
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body:
      `*Caption (${styleLabel})*\n\n` +
      `${result.caption}\n\n` +
      `Aur text bhejo naya caption ke liye, ya *cancel*.`,
  });

  return { handled: true, type: "caption_ready", style: result.style };
}

/**
 * Active caption session after greeting.
 */
async function handleCaptionSession({ fromWhatsAppNumber, bodyText }) {
  const session = getCaptionSession(fromWhatsAppNumber);
  if (!session) {
    return { handled: false };
  }

  // New greeting should be handled by chatbot (re-login + refresh session).
  if (isGcrGraphixGreeting(bodyText)) {
    return { handled: false, reason: "exit_to_greeting" };
  }

  const normalized = normalizeChatText(bodyText);
  if (!normalized) {
    return { handled: true, type: "caption_empty" };
  }

  if (["cancel", "stop", "exit"].includes(normalized)) {
    clearCaptionSession(fromWhatsAppNumber);
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: "Caption band. Dubara shuru: *Hi GCR Graphix*",
    });
    return { handled: true, type: "caption_cancelled" };
  }

  // Plain hi/menu → leave caption mode for chatbot menu.
  if (
    ["menu", "hi", "hello", "hey", "namaste", "help"].includes(normalized)
  ) {
    clearCaptionSession(fromWhatsAppNumber);
    return { handled: false, reason: "exit_to_menu" };
  }

  try {
    return await generateAndSendCaption(fromWhatsAppNumber, bodyText);
  } catch (error) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Caption nahi bani: ${getErrorMessage(error)}\n\n` +
        `Phir se text bhejo, ya *cancel*.`,
    });
    return { handled: true, type: "caption_error" };
  }
}

/**
 * Caption service entry: only active sessions (started by Hi GCR Graphix).
 */
async function handleWhatsAppCaption({ fromWhatsAppNumber, bodyText }) {
  return handleCaptionSession({
    fromWhatsAppNumber,
    bodyText,
  });
}

module.exports = {
  handleWhatsAppCaption,
  startCaptionFlow,
  handleCaptionSession,
  hasActiveCaptionSession,
  clearCaptionSession,
  pendingCaptionSessions,
};
