const User = require("../models/User");
const {
  sendPosterWhatsApp,
  sendWhatsAppContentTemplate,
  sendWhatsAppText,
} = require("./whatsappService");

const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

function getDownloadTemplateContentSid() {
  return String(process.env.TWILIO_DOWNLOAD_TEMPLATE_CONTENT_SID || "").trim();
}

function getDownloadApproveTemplateContentSid() {
  return String(process.env.TWILIO_DOWNLOAD_APPROVE_TEMPLATE_CONTENT_SID || "").trim();
}

function getApprovePostTemplateContentSid() {
  return (
    String(process.env.TWILIO_APPROVE_POST_TEMPLATE_CONTENT_SID || "").trim() ||
    getDownloadApproveTemplateContentSid()
  );
}

function getApprovePostTemplateContentVariables({ name }) {
  return {
    "1": String(name || "Customer"),
  };
}

function getDownloadTemplateContentVariables({ name }) {
  return {
    "1": String(name || "Customer"),
  };
}

function getTemplateBeforeMediaDelayMs() {
  const raw = Number(process.env.WHATSAPP_TEMPLATE_BEFORE_MEDIA_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return 2000;
}

function getApproveAfterImageDelayMs() {
  const raw = Number(process.env.WHATSAPP_APPROVE_AFTER_IMAGE_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  // Default pause so WhatsApp shows the image before the Approve template.
  return 3000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMobileDigits(value) {
  return String(value || "")
    .replace(/^whatsapp:/i, "")
    .replace(/\D/g, "");
}

function toTenDigitMobile(value) {
  const digits = normalizeMobileDigits(value);
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

function isWhatsAppSessionOpen(lastInboundAt) {
  if (!lastInboundAt) {
    return false;
  }

  const timestamp =
    lastInboundAt instanceof Date
      ? lastInboundAt.getTime()
      : new Date(lastInboundAt).getTime();

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return Date.now() - timestamp < WHATSAPP_SESSION_WINDOW_MS;
}

/**
 * Call from the Twilio inbound webhook whenever the user sends any WhatsApp message.
 */
async function recordWhatsAppInbound(fromWhatsAppNumber) {
  const mobileNumber = toTenDigitMobile(fromWhatsAppNumber);
  if (!/^\d{10}$/.test(mobileNumber)) {
    return null;
  }

  const now = new Date();
  await User.updateOne(
    { mobileNumber },
    { $set: { whatsappLastInboundAt: now } },
  );

  return { mobileNumber, whatsappLastInboundAt: now };
}

function getRegisterTemplateContentSid() {
  return String(process.env.TWILIO_REGISTER_TEMPLATE_CONTENT_SID || "").trim();
}

function getLoginTemplateContentSid() {
  return String(process.env.TWILIO_LOGIN_TEMPLATE_CONTENT_SID || "").trim();
}

/**
 * Send a WhatsApp Content template with a URL button, or fall back to plain text.
 */
async function sendWhatsAppPortalLink({
  toMobile,
  contentSid,
  contentVariables,
  fallbackBody,
}) {
  if (contentSid) {
    try {
      return await sendWhatsAppContentTemplate({
        toMobile,
        contentSid,
        contentVariables,
      });
    } catch (error) {
      console.error("WhatsApp portal link template failed, falling back to text:", {
        code: error.code,
        message: error.message,
      });
    }
  }

  return sendWhatsAppText({
    toMobile,
    body: fallbackBody,
  });
}

/**
 * Registration link — template URL should end with /portal/register?token={{1}}.
 */
async function sendWhatsAppRegisterLink({ toMobile, token, registerUrl }) {
  const contentSid = getRegisterTemplateContentSid();

  return sendWhatsAppPortalLink({
    toMobile,
    contentSid,
    contentVariables: {
      "1": String(token),
    },
    fallbackBody:
      `Hi! You're not registered with GCR Graphix yet.\n\n` +
      `Tap to register (opens in browser):\n${registerUrl}`,
  });
}

/**
 * Login link — static template body; URL button ends with /portal/login?token={{1}}.
 */
async function sendWhatsAppLoginLink({ toMobile, name, token, loginUrl }) {
  const contentSid = getLoginTemplateContentSid();

  return sendWhatsAppPortalLink({
    toMobile,
    contentSid,
    contentVariables: {
      "1": String(token),
    },
    fallbackBody:
      `Hi ${name},\n\n` +
      `Tap to open your poster account (opens in browser):\n${loginUrl}\n\n` +
      `To connect Facebook: open in Chrome or Safari (in WhatsApp, tap ⋮ → Open in browser), then tap Connect Facebook.`,
  });
}

async function sendWhatsAppDownloadTemplate({ toMobile, name }) {
  const contentSid = getDownloadTemplateContentSid();

  if (!contentSid) {
    throw new Error(
      "Twilio button template is not configured. Set TWILIO_DOWNLOAD_TEMPLATE_CONTENT_SID in .env.",
    );
  }

  return sendWhatsAppContentTemplate({
    toMobile,
    contentSid,
    contentVariables: getDownloadTemplateContentVariables({ name }),
  });
}

/**
 * After the poster image is sent — offer Approve to post on Facebook/Instagram.
 */
async function sendWhatsAppApprovePostTemplate({ toMobile, name }) {
  const contentSid = getApprovePostTemplateContentSid();
  if (!contentSid) {
    console.warn(
      "Approve post template not configured. Set TWILIO_APPROVE_POST_TEMPLATE_CONTENT_SID in .env.",
    );
    return null;
  }

  return sendWhatsAppContentTemplate({
    toMobile,
    contentSid,
    contentVariables: getApprovePostTemplateContentVariables({ name }),
  });
}

async function sendWhatsAppTemplateThenImage({ toMobile, name, imageUrl, body }) {
  const templateResult = await sendWhatsAppDownloadTemplate({ toMobile, name });

  const delayMs = getTemplateBeforeMediaDelayMs();
  if (delayMs > 0) {
    await delay(delayMs);
  }

  const mediaResult = await sendPosterWhatsApp({
    toMobile,
    imageUrl,
    body,
  });

  return {
    mode: "template_then_image",
    sessionOpen: false,
    template: templateResult,
    media: mediaResult,
  };
}

/**
 * If the user messaged us on WhatsApp within 24h, send the image only.
 * Otherwise send the approved template first, then the image.
 */
async function sendWhatsAppImageSmart({
  toMobile,
  name,
  imageUrl,
  body,
  lastInboundAt,
}) {
  const sessionOpen = isWhatsAppSessionOpen(lastInboundAt);

  if (sessionOpen) {
    const mediaResult = await sendPosterWhatsApp({
      toMobile,
      imageUrl,
      body,
    });

    return {
      mode: "direct",
      sessionOpen: true,
      media: mediaResult,
    };
  }

  return sendWhatsAppTemplateThenImage({ toMobile, name, imageUrl, body });
}

async function resolveLastInboundAt({ userId, mobileNumber }) {
  if (userId && /^[a-f\d]{24}$/i.test(String(userId))) {
    const user = await User.findById(userId).select("whatsappLastInboundAt").lean();
    return user?.whatsappLastInboundAt || null;
  }

  const mobile = toTenDigitMobile(mobileNumber);
  if (!/^\d{10}$/.test(mobile)) {
    return null;
  }

  const user = await User.findOne({ mobileNumber: mobile })
    .select("whatsappLastInboundAt")
    .lean();
  return user?.whatsappLastInboundAt || null;
}

module.exports = {
  WHATSAPP_SESSION_WINDOW_MS,
  isWhatsAppSessionOpen,
  recordWhatsAppInbound,
  sendWhatsAppDownloadTemplate,
  sendWhatsAppApprovePostTemplate,
  getApproveAfterImageDelayMs,
  delay,
  sendWhatsAppLoginLink,
  sendWhatsAppPortalLink,
  sendWhatsAppRegisterLink,
  sendWhatsAppTemplateThenImage,
  sendWhatsAppImageSmart,
  resolveLastInboundAt,
};
