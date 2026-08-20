const User = require("../models/User");
const {
  sendPosterWhatsApp,
  sendWhatsAppContentTemplate,
  sendWhatsAppText,
  fetchTwilioContentTemplate,
} = require("./whatsappService");

const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

function getPosterCardTemplateContentSid() {
  return (
    String(process.env.TWILIO_CARD_TEMPLATE_CONTENT_SID || "").trim() ||
    String(process.env.TWILIO_MEDIA_TEMPLATE_CONTENT_SID || "").trim()
  );
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

function getApprovePostTemplateContentSid() {
  return (
    String(process.env.TWILIO_APPROVE_POST_TEMPLATE_CONTENT_SID || "").trim() ||
    String(process.env.TWILIO_DOWNLOAD_APPROVE_TEMPLATE_CONTENT_SID || "").trim()
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

function collectAllVariableIndexes(types) {
  const indexes = new Set();

  const walk = (value) => {
    if (typeof value === "string") {
      for (const index of variableIndexes(value)) {
        indexes.add(index);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };

  walk(types || {});
  return [...indexes].sort((left, right) => Number(left) - Number(right));
}

function sanitizeTemplateVariableValue(value, fallback = "") {
  const normalized = String(value ?? fallback).trim();
  if (!normalized) {
    return String(fallback || "Customer").trim() || "Customer";
  }
  return normalized.slice(0, 1600);
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

  // Template media is exactly {{N}} → Twilio expects the full public https URL.
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function buildMediaTemplateVariables({
  types,
  declaredVariables,
  name,
  eventName,
  imageUrl,
}) {
  const eventLabel = sanitizeTemplateVariableValue(eventName, "Event");
  const displayName = sanitizeTemplateVariableValue(name, "Customer");
  const mediaTemplates = collectTemplateStrings(types, "media");
  const bodyTemplates = [
    ...collectTemplateStrings(types, "body"),
    ...collectTemplateStrings(types, "title"),
    ...collectTemplateStrings(types, "subtitle"),
  ];

  const indexesFromTypes = collectAllVariableIndexes(types);
  const indexesFromDeclared = Object.keys(declaredVariables || {}).map(String);
  const requiredIndexes = [
    ...new Set(
      (indexesFromDeclared.length > 0 ? indexesFromDeclared : indexesFromTypes).sort(
        (left, right) => Number(left) - Number(right),
      ),
    ),
  ];

  const mediaVarIndexes = new Set();
  for (const mediaTemplate of mediaTemplates) {
    for (const index of variableIndexes(mediaTemplate)) {
      mediaVarIndexes.add(index);
    }
  }

  const bodyVarIndexes = [];
  const seenBodyIndexes = new Set();
  for (const bodyTemplate of bodyTemplates) {
    for (const index of variableIndexes(bodyTemplate)) {
      if (seenBodyIndexes.has(index) || mediaVarIndexes.has(index)) {
        // Media placeholders must stay URLs — never fill them with name/event.
        if (mediaVarIndexes.has(index)) {
          seenBodyIndexes.add(index);
        }
        continue;
      }
      seenBodyIndexes.add(index);
      bodyVarIndexes.push(index);
    }
  }

  const variables = {};
  const bodyValues = [displayName, eventLabel];
  bodyVarIndexes.forEach((index, valueIndex) => {
    variables[index] = sanitizeTemplateVariableValue(
      bodyValues[valueIndex],
      valueIndex === 0 ? displayName : eventLabel,
    );
  });

  for (const mediaTemplate of mediaTemplates) {
    for (const index of variableIndexes(mediaTemplate)) {
      const mediaValue = mediaValueForPlaceholder(mediaTemplate, imageUrl);
      // WhatsApp media vars must be public https URLs (not Cloudinary path-only).
      variables[index] = isHttpUrl(mediaValue)
        ? mediaValue
        : sanitizeTemplateVariableValue(String(imageUrl || "").trim(), "");
    }
  }

  // Single-variable templates (old download-style body {{1}} only)
  if (requiredIndexes.length === 1 && !mediaVarIndexes.size) {
    variables[requiredIndexes[0]] = displayName;
  }

  const filteredVariables = {};
  if (requiredIndexes.length > 0) {
    for (const index of requiredIndexes) {
      if (variables[index] != null && String(variables[index]).trim()) {
        filteredVariables[index] = variables[index];
      }
    }
  } else {
    Object.assign(filteredVariables, variables);
  }

  if (!Object.keys(filteredVariables).length) {
    filteredVariables["1"] = displayName;
  }

  return {
    variables: filteredVariables,
    requiredIndexes,
    hasMediaVariable: mediaVarIndexes.size > 0,
    mediaTemplates,
    typeKeys: Object.keys(types || {}),
  };
}

/**
 * Poster card template variables:
 * {{1}} = customer name
 * {{2}} = event name
 * {{3}} = poster image URL (full https URL)
 */
function getPosterCardTemplateContentVariables({ name, eventName, imageUrl }) {
  const variables = {
    "1": sanitizeTemplateVariableValue(name, "Customer"),
    "2": sanitizeTemplateVariableValue(eventName, "Event"),
  };

  if (imageUrl && String(imageUrl).trim()) {
    variables["3"] = sanitizeTemplateVariableValue(String(imageUrl).trim(), "");
  }

  return variables;
}

function getApproveAfterImageDelayMs() {
  const raw = Number(process.env.WHATSAPP_APPROVE_AFTER_IMAGE_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
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

async function sendWhatsAppPosterCardTemplate({
  toMobile,
  name,
  eventName,
  imageUrl,
}) {
  const contentSid = getPosterCardTemplateContentSid();
  if (!contentSid) {
    throw new Error(
      "Twilio card template is not configured. Set TWILIO_CARD_TEMPLATE_CONTENT_SID in .env.",
    );
  }

  let contentVariables = getPosterCardTemplateContentVariables({
    name,
    eventName,
    imageUrl,
  });
  let hasApproveAction = false;
  let hasMediaVariable = false;
  let requiredIndexes = collectAllVariableIndexes({});

  try {
    const template = await fetchTwilioContentTemplate(contentSid);
    const mapped = buildMediaTemplateVariables({
      types: template?.types || {},
      declaredVariables: template?.variables || {},
      name,
      eventName,
      imageUrl,
    });
    contentVariables = mapped.variables;
    requiredIndexes = mapped.requiredIndexes;
    hasApproveAction = templateHasApproveAction(template?.types);
    hasMediaVariable = mapped.hasMediaVariable;

    console.log("[WhatsApp] sending poster card template", {
      contentSid,
      friendlyName: template?.friendlyName || null,
      typeKeys: mapped.typeKeys,
      mediaTemplates: mapped.mediaTemplates,
      requiredIndexes,
      hasMediaVariable,
      hasApproveAction,
      contentVariables,
    });

    if (imageUrl && !hasMediaVariable) {
      console.warn(
        "[WhatsApp] Template has no media {{variable}}. Use poster_ready_media (body {{1}}/{{2}}, media {{3}}) as TWILIO_CARD_TEMPLATE_CONTENT_SID.",
      );
    }

    const missing = requiredIndexes.filter(
      (index) => !contentVariables[index] || !String(contentVariables[index]).trim(),
    );
    if (missing.length) {
      throw new Error(
        `WhatsApp template ${contentSid} is missing content variables: ${missing.join(", ")}.`,
      );
    }
  } catch (error) {
    console.warn("[WhatsApp] Could not inspect Twilio content template:", error.message);
    if (requiredIndexes.length > 0) {
      const filtered = {};
      for (const index of requiredIndexes) {
        if (contentVariables[index] != null) {
          filtered[index] = contentVariables[index];
        }
      }
      contentVariables = filtered;
    } else if (!imageUrl) {
      delete contentVariables["3"];
    }
  }

  const result = await sendWhatsAppContentTemplate({
    toMobile,
    contentSid,
    contentVariables,
  });
  result.hasApproveAction = hasApproveAction;
  return result;
}

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
  const templateResult = await sendWhatsAppPosterCardTemplate({
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

/** @deprecated Use sendWhatsAppPosterCardTemplate */
async function sendWhatsAppDownloadTemplate(options) {
  return sendWhatsAppPosterCardTemplate(options);
}

module.exports = {
  WHATSAPP_SESSION_WINDOW_MS,
  isWhatsAppSessionOpen,
  recordWhatsAppInbound,
  getPosterCardTemplateContentSid,
  getPosterCardTemplateContentVariables,
  sendWhatsAppPosterCardTemplate,
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
