const User = require("../models/User");
const {
  sendPosterWhatsApp,
  sendWhatsAppContentTemplate,
  sendWhatsAppText,
  fetchTwilioContentTemplate,
} = require("./whatsappService");

const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

function getMediaTemplateContentSid() {
  return (
    String(process.env.TWILIO_CARD_TEMPLATE_CONTENT_SID || "").trim() ||
    String(process.env.TWILIO_MEDIA_TEMPLATE_CONTENT_SID || "").trim() ||
    String(process.env.TWILIO_DOWNLOAD_TEMPLATE_CONTENT_SID || "").trim()
  );
}

function getDownloadTemplateContentSid() {
  return getMediaTemplateContentSid();
}

function getWhatsAppMediaBaseUrl() {
  const fromEnv = String(process.env.TWILIO_WHATSAPP_MEDIA_BASE_URL || "").trim();
  if (fromEnv) {
    return fromEnv.endsWith("/") ? fromEnv : `${fromEnv}/`;
  }

  const cloudName = String(process.env.CLOUD_NAME || "").trim();
  if (cloudName) {
    return `https://res.cloudinary.com/${cloudName}/image/upload/`;
  }

  return "";
}

function getMediaPathSuffix(imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!url) {
    return "";
  }

  const base = getWhatsAppMediaBaseUrl();
  if (base && url.startsWith(base)) {
    return url.slice(base.length);
  }

  const marker = "/image/upload/";
  const index = url.indexOf(marker);
  if (index !== -1) {
    return url.slice(index + marker.length);
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname.replace(/^\//, "")}${parsed.search}`;
  } catch {
    return url;
  }
}

function getTemplateImageVariable(imageUrl) {
  const useFullUrl =
    String(process.env.TWILIO_MEDIA_TEMPLATE_USE_FULL_IMAGE_URL || "")
      .trim()
      .toLowerCase() === "true";
  if (useFullUrl) {
    return String(imageUrl || "").trim();
  }

  return getMediaPathSuffix(imageUrl);
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

function collectTemplateStrings(types, field) {
  const values = [];
  for (const spec of Object.values(types || {})) {
    if (!spec || typeof spec !== "object") {
      continue;
    }
    const value = spec[field];
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      values.push(...value.filter((item) => typeof item === "string"));
    }
  }
  return values;
}

function variableIndexes(text) {
  return [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((match) => match[1]);
}

function templateHasApproveAction(types) {
  for (const spec of Object.values(types || {})) {
    const actions = spec?.actions;
    if (!Array.isArray(actions)) {
      continue;
    }
    for (const action of actions) {
      const id = String(action?.id || "").trim().toLowerCase();
      const title = String(action?.title || "").trim().toLowerCase();
      if (id === "approve" || title === "approve") {
        return true;
      }
    }
  }
  return false;
}

function mediaValueForPlaceholder(mediaTemplate, imageUrl) {
  const template = String(mediaTemplate || "").trim();
  const url = String(imageUrl || "").trim();
  if (!template || !url) {
    return url;
  }

  if (/^\{\{\d+\}\}$/.test(template)) {
    return url;
  }

  const placeholderIndex = template.indexOf("{{");
  if (placeholderIndex <= 0) {
    return url;
  }

  const prefix = template.slice(0, placeholderIndex);
  if (url.startsWith(prefix)) {
    return url.slice(prefix.length);
  }

  if (prefix.includes("/image/upload/") && url.includes("/image/upload/")) {
    return url.split("/image/upload/")[1] || url;
  }

  return getTemplateImageVariable(url);
}

function buildMediaTemplateVariables({ types, name, eventName, imageUrl }) {
  const eventLabel = String(eventName || "Event").trim() || "Event";
  const displayName = String(name || "Customer").trim() || "Customer";
  const mediaTemplates = collectTemplateStrings(types, "media");
  const bodyTemplates = [
    ...collectTemplateStrings(types, "body"),
    ...collectTemplateStrings(types, "title"),
    ...collectTemplateStrings(types, "subtitle"),
  ];

  const variables = {};
  const bodyVarIndexes = [];
  const seenBodyIndexes = new Set();

  for (const bodyTemplate of bodyTemplates) {
    for (const index of variableIndexes(bodyTemplate)) {
      if (seenBodyIndexes.has(index)) {
        continue;
      }
      seenBodyIndexes.add(index);
      bodyVarIndexes.push(index);
    }
  }

  const bodyValues = [displayName, eventLabel];
  bodyVarIndexes.forEach((index, valueIndex) => {
    variables[index] = bodyValues[valueIndex] || eventLabel;
  });

  const mediaVarIndexes = new Set();
  for (const mediaTemplate of mediaTemplates) {
    for (const index of variableIndexes(mediaTemplate)) {
      mediaVarIndexes.add(index);
      if (seenBodyIndexes.has(index)) {
        continue;
      }
      variables[index] = mediaValueForPlaceholder(mediaTemplate, imageUrl);
    }
  }

  const mediaOnlyIndexes = [...mediaVarIndexes].filter((index) => !seenBodyIndexes.has(index));
  if (imageUrl && mediaVarIndexes.size > 0 && mediaOnlyIndexes.length === 0) {
    console.warn(
      "[WhatsApp] Card media variable overlaps the title. Keep title as {{1}} name, {{2}} event, and set Media URL to {{3}}.",
    );
    if (!variables["3"]) {
      variables["3"] = mediaValueForPlaceholder(mediaTemplates[0], imageUrl);
    }
  }

  if (!Object.keys(variables).length) {
    variables["1"] = displayName;
    variables["2"] = eventLabel;
    if (imageUrl) {
      variables["3"] = String(imageUrl).trim();
    }
  }

  return {
    variables,
    hasMediaVariable: mediaVarIndexes.size > 0,
    mediaTemplates,
    typeKeys: Object.keys(types || {}),
  };
}

/**
 * Poster-ready Card/Media variables:
 * {{1}} = customer name
 * {{2}} = event name
 * {{3}} = poster image URL
 */
function getDownloadTemplateContentVariables({ name, eventName, imageUrl }) {
  const variables = {
    "1": String(name || "Customer").trim() || "Customer",
    "2": String(eventName || "Event").trim() || "Event",
  };

  if (imageUrl && String(imageUrl).trim()) {
    variables["3"] = String(imageUrl).trim();
  }

  return variables;
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

async function sendWhatsAppDownloadTemplate({
  toMobile,
  name,
  eventName,
  imageUrl,
}) {
  const contentSid = imageUrl
    ? getMediaTemplateContentSid()
    : getDownloadTemplateContentSid();

  if (!contentSid) {
    throw new Error(
      "Twilio card template is not configured. Set TWILIO_CARD_TEMPLATE_CONTENT_SID in .env.",
    );
  }

  let contentVariables = getDownloadTemplateContentVariables({
    name,
    eventName,
    imageUrl,
  });
  let hasApproveAction = false;

  try {
    const template = await fetchTwilioContentTemplate(contentSid);
    const mapped = buildMediaTemplateVariables({
      types: template?.types || {},
      name,
      eventName,
      imageUrl,
    });
    contentVariables = mapped.variables;
    hasApproveAction = templateHasApproveAction(template?.types);

    console.log("[WhatsApp] sending poster template", {
      contentSid,
      friendlyName: template?.friendlyName || null,
      typeKeys: mapped.typeKeys,
      mediaTemplates: mapped.mediaTemplates,
      hasMediaVariable: mapped.hasMediaVariable,
      hasApproveAction,
      contentVariables,
    });

    if (imageUrl && !mapped.hasMediaVariable) {
      console.warn(
        "[WhatsApp] Content template has no media {{variable}}. WhatsApp will not show the poster image. Create a Card template with media {{3}} and set TWILIO_CARD_TEMPLATE_CONTENT_SID.",
      );
    }
  } catch (error) {
    console.warn("[WhatsApp] Could not inspect Twilio content template:", error.message);
  }

  const result = await sendWhatsAppContentTemplate({
    toMobile,
    contentSid,
    contentVariables,
  });
  result.hasApproveAction = hasApproveAction;
  return result;
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

function buildPosterReadyMessage({ eventName, body }) {
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }

  const eventLabel = String(eventName || "Event").trim() || "Event";
  return `Your ${eventLabel} poster is ready`;
}

async function sendWhatsAppTemplateThenImage({
  toMobile,
  name,
  imageUrl,
  eventName,
}) {
  const templateResult = await sendWhatsAppDownloadTemplate({
    toMobile,
    name,
    eventName,
    imageUrl,
  });

  return {
    mode: "media_template",
    sessionOpen: false,
    template: templateResult,
  };
}

/**
 * If the user messaged us on WhatsApp within 24h, send the image only.
 * Otherwise send one approved media template that includes the poster image.
 */
async function sendWhatsAppImageSmart({
  toMobile,
  name,
  imageUrl,
  body,
  eventName,
  lastInboundAt,
}) {
  const sessionOpen = isWhatsAppSessionOpen(lastInboundAt);
  const posterBody = buildPosterReadyMessage({ eventName, body });

  if (sessionOpen) {
    const mediaResult = await sendPosterWhatsApp({
      toMobile,
      imageUrl,
      body: posterBody,
    });

    return {
      mode: "direct",
      sessionOpen: true,
      media: mediaResult,
    };
  }

  return sendWhatsAppTemplateThenImage({
    toMobile,
    name,
    imageUrl,
    body: posterBody,
    eventName,
  });
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
  buildPosterReadyMessage,
  sendWhatsAppLoginLink,
  sendWhatsAppPortalLink,
  sendWhatsAppRegisterLink,
  sendWhatsAppTemplateThenImage,
  sendWhatsAppImageSmart,
  resolveLastInboundAt,
};
