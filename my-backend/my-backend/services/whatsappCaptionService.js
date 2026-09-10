const { sendWhatsAppText, formatWhatsAppNumber } = require("./whatsappService");
const { generateCaption } = require("../utils/captionGenerateService");
const {
  isGcrGraphixGreeting,
  findUserByMobile,
  toTenDigitMobile,
} = require("../utils/portalAuth");
const { sendWhatsAppApprovePostTemplate } = require("./whatsappTemplateService");
const {
  getUserSocialApproveEligibility,
  approveCaptionForUser,
} = require("./facebookPostService");

/** Optional session after greeting; free text also works without it. */
const pendingCaptionSessions = new Map();

/** Caption waiting for WhatsApp Approve → Facebook text post. */
const pendingCaptionApprovals = new Map();

const CAPTION_SESSION_TTL_MS =
  Number(process.env.CAPTION_SESSION_TTL_MS || 30 * 60 * 1000) || 30 * 60 * 1000;
const CAPTION_APPROVE_TTL_MS =
  Number(process.env.CAPTION_APPROVE_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;

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

function approvalKey(fromWhatsAppNumber) {
  try {
    return formatWhatsAppNumber(fromWhatsAppNumber).toLowerCase();
  } catch {
    return sessionKey(fromWhatsAppNumber);
  }
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

function getPendingCaptionApproval(fromWhatsAppNumber) {
  const key = approvalKey(fromWhatsAppNumber);
  const pending = pendingCaptionApprovals.get(key);
  if (!pending) {
    return null;
  }
  if (Date.now() - pending.createdAt > CAPTION_APPROVE_TTL_MS) {
    pendingCaptionApprovals.delete(key);
    return null;
  }
  return pending;
}

function clearPendingCaptionApproval(fromWhatsAppNumber) {
  pendingCaptionApprovals.delete(approvalKey(fromWhatsAppNumber));
}

function setPendingCaptionApproval(fromWhatsAppNumber, data) {
  const key = approvalKey(fromWhatsAppNumber);
  pendingCaptionApprovals.set(key, {
    ...data,
    createdAt: Date.now(),
  });
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

async function offerCaptionFacebookApprove(fromWhatsAppNumber, caption, style) {
  const user = await findUserByMobile(fromWhatsAppNumber);
  if (!user?._id) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Facebook pe post karne ke liye pehle *Hi GCR Graphix* se register/login karein, ` +
        `phir Page connect karein (menu *2*).`,
    });
    return { offered: false, reason: "no_user" };
  }

  const eligibility = await getUserSocialApproveEligibility(String(user._id));
  if (!eligibility.canApprove) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Caption ready. Facebook Page connect nahi hai.\n` +
        `Connect ke liye *Hi GCR Graphix* → login → Connect Facebook, ` +
        `ya menu *2*.`,
    });
    return { offered: false, reason: "no_facebook" };
  }

  setPendingCaptionApproval(fromWhatsAppNumber, {
    caption,
    style: style || "normal",
    userId: String(user._id),
    name: user.name || "Customer",
    mobile: toTenDigitMobile(fromWhatsAppNumber),
    canApproveSocial: true,
  });

  const templateResult = await sendWhatsAppApprovePostTemplate({
    toMobile: fromWhatsAppNumber,
    name: user.name || "Customer",
  });

  if (!templateResult) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Facebook (${eligibility.pageName || "Page"}) pe post karne ke liye *Approve* likh kar bhejo.\n` +
        `Skip ke liye *Skip*.`,
    });
  }

  return { offered: true, pageName: eligibility.pageName, templateResult };
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
    lastCaption: result.caption,
  });

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: result.caption,
  });

  // Approve card / button for Facebook upload.
  await offerCaptionFacebookApprove(
    fromWhatsAppNumber,
    result.caption,
    result.style,
  );

  return { handled: true, type: "caption_ready", style: result.style };
}

/**
 * User tapped Approve for an AI caption → Facebook Page text post.
 */
async function approvePendingCaption({ fromWhatsAppNumber }) {
  const pending = getPendingCaptionApproval(fromWhatsAppNumber);
  if (!pending?.caption || !pending?.userId || !pending?.canApproveSocial) {
    return { handled: false, reason: "no_pending_caption" };
  }

  const result = await approveCaptionForUser({
    userId: pending.userId,
    caption: pending.caption,
  });

  clearPendingCaptionApproval(fromWhatsAppNumber);

  const pageName = result?.facebook?.pageName || "your Facebook Page";
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: `Done! Caption Facebook (${pageName}) pe post ho gayi.`,
  });

  return { handled: true, type: "caption_approved", result };
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
    clearPendingCaptionApproval(fromWhatsAppNumber);
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
  pendingCaptionApprovals,
  getPendingCaptionApproval,
  clearPendingCaptionApproval,
  approvePendingCaption,
  isReservedChatCommand,
};
