const { sendWhatsAppText } = require("./whatsappService");
const { generateCaptions } = require("../utils/captionGenerateService");
const {
  setPendingPosterCaption,
  getPendingPosterRequest,
} = require("./whatsappPosterDelivery");

/** In-memory caption sessions (awaiting rough text or choice 1/2/3). */
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

function isCaptionIntent(text) {
  const normalized = normalizeChatText(text);
  if (!normalized) {
    return false;
  }

  return (
    ["6", "caption", "captions", "ai caption", "shayari"].includes(normalized) ||
    normalized.includes("caption") ||
    normalized.includes("shayari")
  );
}

function isMenuExitIntent(text) {
  const normalized = normalizeChatText(text);
  if (!normalized) {
    return false;
  }

  const triggers = [
    "menu",
    "hi",
    "hello",
    "hey",
    "namaste",
    "start",
    "help",
  ];

  return triggers.some(
    (trigger) =>
      normalized === trigger ||
      normalized.startsWith(`${trigger} `),
  );
}

function buildCaptionPromptMessage() {
  return (
    `*AI Caption*\n\n` +
    `Send a short note about your post (Hindi or English).\n\n` +
    `Example:\n` +
    `जय जगदम्बे ब्लड कैंप में गया, 50 लोगों ने रक्तदान किया\n\n` +
    `I will reply with 3 options:\n` +
    `1 Hindi · 2 English · 3 Shayari (leader style)\n\n` +
    `Reply *cancel* to stop.`
  );
}

function buildCaptionOptionsMessage(captions) {
  return (
    `*Caption options:*\n\n` +
    `*1 (Hindi)*\n${captions.hindi}\n\n` +
    `*2 (English)*\n${captions.english}\n\n` +
    `*3 (Shayari)*\n${captions.shayari}\n\n` +
    `Reply *1*, *2* or *3* to choose.\n` +
    `Reply *again* to regenerate, or *cancel* to stop.`
  );
}

async function startCaptionFlow(fromWhatsAppNumber) {
  setCaptionSession(fromWhatsAppNumber, {
    status: "awaiting_text",
    captions: null,
    rawText: "",
  });
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: buildCaptionPromptMessage(),
  });
  return { handled: true, type: "caption_prompt" };
}

async function generateAndSendCaptionOptions(fromWhatsAppNumber, rawText) {
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: "Generating captions… please wait.",
  });

  const captions = await generateCaptions(rawText);
  setCaptionSession(fromWhatsAppNumber, {
    status: "awaiting_choice",
    captions,
    rawText: String(rawText).trim(),
  });

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: buildCaptionOptionsMessage(captions),
  });

  return { handled: true, type: "caption_options" };
}

async function applyChosenCaption(fromWhatsAppNumber, choiceKey) {
  const session = getCaptionSession(fromWhatsAppNumber);
  if (!session?.captions?.[choiceKey]) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: "No caption options found. Reply *6* or *caption* to start again.",
    });
    clearCaptionSession(fromWhatsAppNumber);
    return { handled: true, type: "caption_missing" };
  }

  const chosen = session.captions[choiceKey];
  const labels = { hindi: "Hindi", english: "English", shayari: "Shayari" };
  const attached = setPendingPosterCaption(fromWhatsAppNumber, chosen);
  clearCaptionSession(fromWhatsAppNumber);

  const pending = getPendingPosterRequest(fromWhatsAppNumber);
  let nextStep =
    `Caption saved.\n\n` +
    `*${labels[choiceKey]}*\n${chosen}\n\n`;

  if (attached && pending?.canApproveSocial) {
    nextStep +=
      `This caption will be used when you tap *Approve* on your poster.\n` +
      `If you have not received the poster yet, wait for admin to send it.`;
  } else if (attached) {
    nextStep +=
      `Caption is attached to your pending poster.\n` +
      `Connect Facebook (menu *2*) to enable Approve posting.`;
  } else {
    nextStep +=
      `No pending poster yet — caption is ready when admin sends one in this chat session.\n` +
      `(For now, copy it from above if you need it.)`;
  }

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: nextStep,
  });

  return { handled: true, type: "caption_selected", choice: choiceKey };
}

/**
 * Active caption session: collect text / choice.
 * Returns { handled: false, reason: "exit_to_menu" } when user wants main menu.
 */
async function handleCaptionSession({ fromWhatsAppNumber, bodyText }) {
  const session = getCaptionSession(fromWhatsAppNumber);
  if (!session) {
    return { handled: false };
  }

  const normalized = normalizeChatText(bodyText);
  if (!normalized) {
    return { handled: true, type: "caption_empty" };
  }

  if (["cancel", "stop", "exit"].includes(normalized)) {
    clearCaptionSession(fromWhatsAppNumber);
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: "Caption cancelled. Type *menu* for options.",
    });
    return { handled: true, type: "caption_cancelled" };
  }

  if (isMenuExitIntent(bodyText)) {
    clearCaptionSession(fromWhatsAppNumber);
    return { handled: false, reason: "exit_to_menu" };
  }

  if (session.status === "awaiting_text") {
    try {
      return await generateAndSendCaptionOptions(fromWhatsAppNumber, bodyText);
    } catch (error) {
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body:
          `Could not generate captions: ${getErrorMessage(error)}\n\n` +
          `Send your note again, or reply *cancel*.`,
      });
      return { handled: true, type: "caption_error" };
    }
  }

  if (session.status === "awaiting_choice") {
    if (["again", "retry", "regenerate", "new"].includes(normalized)) {
      const raw = session.rawText || bodyText;
      try {
        return await generateAndSendCaptionOptions(fromWhatsAppNumber, raw);
      } catch (error) {
        await sendWhatsAppText({
          toMobile: fromWhatsAppNumber,
          body: `Could not regenerate: ${getErrorMessage(error)}`,
        });
        return { handled: true, type: "caption_error" };
      }
    }

    if (normalized === "1") {
      return applyChosenCaption(fromWhatsAppNumber, "hindi");
    }
    if (normalized === "2") {
      return applyChosenCaption(fromWhatsAppNumber, "english");
    }
    if (normalized === "3") {
      return applyChosenCaption(fromWhatsAppNumber, "shayari");
    }

    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: "Reply *1*, *2* or *3* to choose a caption (or *again* / *cancel*).",
    });
    return { handled: true, type: "caption_choice_hint" };
  }

  clearCaptionSession(fromWhatsAppNumber);
  return { handled: false };
}

/**
 * Entry point for WhatsApp caption service.
 * Handles start intent (*6* / caption) and active sessions.
 */
async function handleWhatsAppCaption({ fromWhatsAppNumber, bodyText }) {
  const sessionResult = await handleCaptionSession({
    fromWhatsAppNumber,
    bodyText,
  });
  if (sessionResult.handled || sessionResult.reason === "exit_to_menu") {
    return sessionResult;
  }

  if (isCaptionIntent(bodyText)) {
    return startCaptionFlow(fromWhatsAppNumber);
  }

  return { handled: false };
}

module.exports = {
  handleWhatsAppCaption,
  startCaptionFlow,
  handleCaptionSession,
  isCaptionIntent,
  hasActiveCaptionSession,
  clearCaptionSession,
  pendingCaptionSessions,
};
