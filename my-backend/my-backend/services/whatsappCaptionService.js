const { sendWhatsAppText, formatWhatsAppNumber, downloadTwilioMedia } = require("./whatsappService");
const { generateCaption } = require("../utils/captionGenerateService");
const {
  isGcrGraphixGreeting,
  findUserByMobile,
  toTenDigitMobile,
  handleGcrGraphixGreeting,
  createLoginLinkForUser,
} = require("../utils/portalAuth");
const {
  sendWhatsAppApprovePostTemplate,
  sendWhatsAppLoginLink,
} = require("./whatsappTemplateService");
const {
  getUserSocialApproveEligibility,
  approveCaptionForUser,
} = require("./facebookPostService");
const { uploadPosterToCloudinary } = require("./cloudnaryService");

const pendingCaptionSessions = new Map();
const pendingCaptionApprovals = new Map();

const CAPTION_SESSION_TTL_MS =
  Number(process.env.CAPTION_SESSION_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;
const CAPTION_APPROVE_TTL_MS =
  Number(process.env.CAPTION_APPROVE_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;
const MAX_CAPTION_PHOTOS = Math.min(
  Number(process.env.CAPTION_MAX_PHOTOS || 5) || 5,
  10,
);

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
    photos: Array.isArray(existing.photos) ? existing.photos : [],
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
  pendingCaptionApprovals.set(approvalKey(fromWhatsAppNumber), {
    ...data,
    createdAt: Date.now(),
  });
}

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

function extensionForContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Ensure user is registered + Facebook linked before caption work.
 * @returns {Promise<{ ok: boolean, user?: object, eligibility?: object }>}
 */
async function ensureCaptionEligibility(fromWhatsAppNumber) {
  const user = await findUserByMobile(fromWhatsAppNumber);
  if (!user?._id) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Pehle register / login karein.\n` +
        `Register link bhej raha hoon…`,
    });
    await handleGcrGraphixGreeting(fromWhatsAppNumber);
    return { ok: false, reason: "not_registered" };
  }

  const eligibility = await getUserSocialApproveEligibility(String(user._id));
  if (!eligibility.canApprove) {
    const { token, loginUrl } = await createLoginLinkForUser(user);
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Hi ${user.name || "there"},\n\n` +
        `Caption / Facebook post se pehle *Facebook + Instagram* connect karein.\n` +
        `Link open karke *Connect Facebook* tap karein (Chrome/Safari use karein).`,
    });
    await sendWhatsAppLoginLink({
      toMobile: toTenDigitMobile(fromWhatsAppNumber),
      name: user.name,
      token,
      loginUrl,
    });
    return { ok: false, reason: "facebook_not_linked", user };
  }

  return { ok: true, user, eligibility };
}

async function ingestWhatsAppPhotos(fromWhatsAppNumber, inboundMedia = []) {
  const session = getCaptionSession(fromWhatsAppNumber) || { photos: [] };
  const existing = Array.isArray(session.photos) ? [...session.photos] : [];
  const incoming = Array.isArray(inboundMedia) ? inboundMedia : [];
  if (incoming.length === 0) {
    return existing;
  }

  const room = Math.max(0, MAX_CAPTION_PHOTOS - existing.length);
  if (room <= 0) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: `Maximum ${MAX_CAPTION_PHOTOS} photos. Ab caption text bhejo.`,
    });
    return existing;
  }

  const toSave = incoming.slice(0, room);
  for (let i = 0; i < toSave.length; i += 1) {
    const item = toSave[i];
    const mediaUrl = typeof item === "string" ? item : item?.url;
    if (!mediaUrl) continue;

    const downloaded = await downloadTwilioMedia(mediaUrl);
    const ext = extensionForContentType(downloaded.contentType || item?.contentType);
    const fileName = `caption-${toTenDigitMobile(fromWhatsAppNumber)}-${Date.now()}-${i}.${ext}`;
    const uploaded = await uploadPosterToCloudinary(downloaded.buffer, fileName);
    if (uploaded?.url) {
      existing.push(uploaded.url);
    }
  }

  setCaptionSession(fromWhatsAppNumber, { photos: existing });
  return existing;
}

async function offerCaptionFacebookApprove(fromWhatsAppNumber, {
  caption,
  style,
  imageUrls,
  user,
  eligibility,
}) {
  setPendingCaptionApproval(fromWhatsAppNumber, {
    caption,
    style: style || "normal",
    imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
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
        `Facebook (${eligibility.pageName || "Page"}) pe photos + caption post karne ke liye *Approve* bhejo.\n` +
        `Skip ke liye *Skip*.`,
    });
  }

  return { offered: true };
}

async function generateAndSendCaption(fromWhatsAppNumber, rawText, photos, user, eligibility) {
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: "Caption bana raha hoon…",
  });

  const result = await generateCaption(rawText);
  setCaptionSession(fromWhatsAppNumber, {
    photos,
    lastStyle: result.style,
    lastCaption: result.caption,
    lastRawText: String(rawText).trim(),
  });

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: result.caption,
  });

  await offerCaptionFacebookApprove(fromWhatsAppNumber, {
    caption: result.caption,
    style: result.style,
    imageUrls: photos,
    user,
    eligibility,
  });

  return { handled: true, type: "caption_ready", style: result.style };
}

async function startCaptionFlow(fromWhatsAppNumber, options = {}) {
  setCaptionSession(fromWhatsAppNumber, {
    photos: [],
  });

  if (options.silent) {
    return { handled: true, type: "caption_session_started" };
  }

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body:
      `Photos (1–${MAX_CAPTION_PHOTOS}) bhejo + event text.\n` +
      `Caption banegi, phir *Approve* se Facebook pe photos + caption post hongi.`,
  });
  return { handled: true, type: "caption_prompt" };
}

async function approvePendingCaption({ fromWhatsAppNumber }) {
  const pending = getPendingCaptionApproval(fromWhatsAppNumber);
  if (!pending?.caption || !pending?.userId || !pending?.canApproveSocial) {
    return { handled: false, reason: "no_pending_caption" };
  }

  const result = await approveCaptionForUser({
    userId: pending.userId,
    caption: pending.caption,
    imageUrls: pending.imageUrls || [],
  });

  clearPendingCaptionApproval(fromWhatsAppNumber);

  const pageName = result?.facebook?.pageName || "your Facebook Page";
  let body = `Done! Photos + caption Facebook (${pageName}) pe post ho gaye.`;
  if (result?.instagram?.success || result?.instagram?.mediaId) {
    body += ` Instagram pe bhi post ho gaya.`;
  } else if (result?.instagram?.message) {
    body += ` Instagram: ${result.instagram.message}`;
  }

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body,
  });

  return { handled: true, type: "caption_approved", result };
}

/**
 * Caption flow with gates:
 * 1) not registered → register link (no caption)
 * 2) registered, no FB → FB/IG connect link (no caption)
 * 3) both OK → accept photos + text → caption → Approve → FB upload
 */
async function handleWhatsAppCaption({
  fromWhatsAppNumber,
  bodyText,
  inboundMedia = [],
}) {
  const text = String(bodyText || "").trim();
  const mediaList = Array.isArray(inboundMedia) ? inboundMedia : [];
  const hasMedia = mediaList.length > 0;

  if (!text && !hasMedia) {
    return { handled: false };
  }

  if (text && isGcrGraphixGreeting(text) && !hasMedia) {
    return { handled: false, reason: "greeting" };
  }

  const normalized = normalizeChatText(text);

  if (["cancel", "stop", "exit"].includes(normalized)) {
    clearPendingCaptionApproval(fromWhatsAppNumber);
    clearCaptionSession(fromWhatsAppNumber);
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: "Caption flow band.",
    });
    return { handled: true, type: "caption_cancelled" };
  }

  // Menu/commands without media → chatbot
  if (text && isReservedChatCommand(text) && !hasMedia) {
    return { handled: false, reason: "reserved" };
  }

  // Case 1 & 2: register / Facebook first — do not generate caption.
  const gate = await ensureCaptionEligibility(fromWhatsAppNumber);
  if (!gate.ok) {
    return { handled: true, type: gate.reason };
  }

  try {
    const photos = await ingestWhatsAppPhotos(fromWhatsAppNumber, mediaList);
    const photoCount = photos.length;

    // Photos only — save; if text was waiting, generate now.
    if (hasMedia && !text) {
      const session = getCaptionSession(fromWhatsAppNumber);
      const waitingText = String(session?.pendingText || "").trim();
      if (waitingText && photos.length > 0) {
        setCaptionSession(fromWhatsAppNumber, {
          photos,
          pendingText: "",
        });
        return await generateAndSendCaption(
          fromWhatsAppNumber,
          waitingText,
          photos,
          gate.user,
          gate.eligibility,
        );
      }

      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body:
          `${photos.length} photo save.\n` +
          (photos.length < MAX_CAPTION_PHOTOS
            ? `Aur photos bhej sakte ho (max ${MAX_CAPTION_PHOTOS}), ya ab caption text bhejo.`
            : `Ab caption / event text bhejo.`),
      });
      return { handled: true, type: "photos_saved", photoCount: photos.length };
    }

    // Text without photos — ask for photos first.
    if (text && photoCount === 0) {
      setCaptionSession(fromWhatsAppNumber, {
        photos: [],
        pendingText: text,
      });
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body:
          `Pehle 1–${MAX_CAPTION_PHOTOS} photos bhejo.\n` +
          `Photos ke baad caption banakar *Approve* se Facebook pe post hogi.`,
      });
      return { handled: true, type: "need_photos" };
    }

    // Text + photos (or text after photos already saved) → generate.
    const session = getCaptionSession(fromWhatsAppNumber);
    const captionText = text || session?.pendingText || "";
    if (!captionText) {
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body: "Caption ke liye event text bhejo.",
      });
      return { handled: true, type: "need_text" };
    }

    return await generateAndSendCaption(
      fromWhatsAppNumber,
      captionText,
      photos,
      gate.user,
      gate.eligibility,
    );
  } catch (error) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: `Caption flow error: ${getErrorMessage(error)}\n\nPhir se try karein.`,
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
  ensureCaptionEligibility,
  isReservedChatCommand,
};
