const {
  sendWhatsAppText,
  sendPosterWhatsApp,
  formatWhatsAppNumber,
  downloadTwilioMedia,
} = require("./whatsappService");
const { generateCaption } = require("../utils/captionGenerateService");
const { buildReferenceCollage } = require("../utils/shareAiComposeService");
const { downloadImageBuffer } = require("../utils/shareAiFalClient");
const {
  isGcrGraphixGreeting,
  findUserByMobile,
  toTenDigitMobile,
  handleGcrGraphixGreeting,
  createLoginLinkForUser,
} = require("../utils/portalAuth");
const {
  sendWhatsAppApprovePostTemplate,
} = require("./whatsappTemplateService");
const {
  getUserSocialApproveEligibility,
  approveCaptionForUser,
} = require("./facebookPostService");
const {
  uploadPosterToCloudinary,
  uploadBufferToCloudinary,
} = require("./cloudnaryService");

const CAPTION_COLLAGE_FOLDER =
  process.env.CLOUDINARY_CAPTION_COLLAGE_FOLDER || "caption-collage";

const pendingCaptionSessions = new Map();
const pendingCaptionApprovals = new Map();
const photoBatchTimers = new Map();
const sessionLocks = new Map();

const CAPTION_SESSION_TTL_MS =
  Number(process.env.CAPTION_SESSION_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;
const CAPTION_APPROVE_TTL_MS =
  Number(process.env.CAPTION_APPROVE_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;
/** WhatsApp often delivers multi-select photos as separate webhooks — wait to batch. */
const PHOTO_BATCH_WAIT_MS = Math.min(
  Math.max(Number(process.env.CAPTION_PHOTO_BATCH_MS || 6500) || 6500, 2000),
  20000,
);
const MAX_CAPTION_PHOTOS = Math.min(
  Number(process.env.CAPTION_MAX_PHOTOS || 5) || 5,
  10,
);

function runExclusive(fromWhatsAppNumber, fn) {
  const key = sessionKey(fromWhatsAppNumber);
  const prev = sessionLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  sessionLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

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
  clearPhotoBatchTimer(fromWhatsAppNumber);
  pendingCaptionSessions.delete(sessionKey(fromWhatsAppNumber));
}

function clearPhotoBatchTimer(fromWhatsAppNumber) {
  const key = sessionKey(fromWhatsAppNumber);
  const timer = photoBatchTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    photoBatchTimers.delete(key);
  }
}

function isPhotoBatchDoneCommand(text) {
  const normalized = normalizeChatText(text);
  return ["done", "ok", "ready", "bas", "ho gaya", "hogaya", "finish", "collage"].includes(
    normalized,
  );
}

/**
 * Debounce collage/caption until WhatsApp finishes delivering separate photo messages.
 */
function schedulePhotoBatchFinalize(fromWhatsAppNumber, user, eligibility) {
  const key = sessionKey(fromWhatsAppNumber);
  clearPhotoBatchTimer(fromWhatsAppNumber);

  const timer = setTimeout(() => {
    photoBatchTimers.delete(key);
    finalizePhotoBatch(fromWhatsAppNumber, user, eligibility).catch(async (error) => {
      console.error(
        "[caption] photo batch finalize failed:",
        getErrorMessage(error),
      );
      try {
        await sendWhatsAppText({
          toMobile: fromWhatsAppNumber,
          body: `Collage error: ${getErrorMessage(error)}\n\nPhir se photos bhejo.`,
        });
      } catch {
        // ignore
      }
    });
  }, PHOTO_BATCH_WAIT_MS);

  photoBatchTimers.set(key, timer);
}

async function finalizePhotoBatch(fromWhatsAppNumber, user, eligibility) {
  const session = getCaptionSession(fromWhatsAppNumber);
  const photos = Array.isArray(session?.photos) ? session.photos : [];
  if (photos.length === 0) {
    return { handled: true, type: "photos_empty" };
  }

  clearPendingCaptionApproval(fromWhatsAppNumber);

  const waitingText = String(session?.pendingText || "").trim();
  if (waitingText) {
    setCaptionSession(fromWhatsAppNumber, { photos, pendingText: "" });
    return generateAndSendCaption(
      fromWhatsAppNumber,
      waitingText,
      photos,
      user,
      eligibility,
    );
  }

  return sendCollageForApproval(fromWhatsAppNumber, photos, user, eligibility);
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
    await handleGcrGraphixGreeting(fromWhatsAppNumber);
    return { ok: false, reason: "not_registered" };
  }

  const eligibility = await getUserSocialApproveEligibility(String(user._id));
  if (!eligibility.canApprove) {
    const { loginUrl } = await createLoginLinkForUser(user);
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Hi ${user.name || "there"},\n\n` +
        `Please connect Facebook to continue:\n${loginUrl}`,
    });
    return { ok: false, reason: "facebook_not_linked", user };
  }

  return { ok: true, user, eligibility };
}

async function ingestWhatsAppPhotos(fromWhatsAppNumber, inboundMedia = []) {
  return runExclusive(fromWhatsAppNumber, async () => {
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
        body: `Maximum ${MAX_CAPTION_PHOTOS} photos. Ab caption text bhejo ya *done*.`,
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
      const photoUrl = uploaded?.imageUrl || uploaded?.url;
      if (photoUrl) {
        existing.push(photoUrl);
      }
    }

    setCaptionSession(fromWhatsAppNumber, { photos: existing, collageUrl: "" });
    return existing;
  });
}

/**
 * Plain sharp collage (no AI image polish). Caption AI stays separate.
 */
async function buildAndUploadCaptionCollage(imageUrls = []) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error("At least one photo is required for collage.");
  }

  const buffers = [];
  for (const url of urls.slice(0, MAX_CAPTION_PHOTOS)) {
    buffers.push(await downloadImageBuffer(url));
  }

  const collageBuffer = await buildReferenceCollage(buffers);
  const uploaded = await uploadBufferToCloudinary(
    collageBuffer,
    `caption-collage-${Date.now()}.jpg`,
    { folder: CAPTION_COLLAGE_FOLDER },
  );

  if (!uploaded?.imageUrl) {
    throw new Error("Collage upload failed.");
  }

  return { collageUrl: uploaded.imageUrl, photoCount: urls.length };
}

async function ensureSessionCollage(fromWhatsAppNumber, photos) {
  const session = getCaptionSession(fromWhatsAppNumber);
  const photoKey = photos.join("|");
  if (
    session?.collageUrl &&
    session?.collagePhotoKey === photoKey &&
    photos.length > 0
  ) {
    return session.collageUrl;
  }

  const built = await buildAndUploadCaptionCollage(photos);
  setCaptionSession(fromWhatsAppNumber, {
    photos,
    collageUrl: built.collageUrl,
    collagePhotoKey: photoKey,
  });
  return built.collageUrl;
}

async function offerCaptionFacebookApprove(fromWhatsAppNumber, {
  caption,
  style,
  imageUrls,
  user,
  eligibility,
}) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  setPendingCaptionApproval(fromWhatsAppNumber, {
    caption: typeof caption === "string" ? caption : "",
    style: style || "normal",
    imageUrls: urls,
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
    const page = eligibility?.pageName || "Page";
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Facebook (${page}) pe collage post karne ke liye *Approve* bhejo.\n` +
        `Skip ke liye *Skip*.`,
    });
  }

  return { offered: true };
}

/**
 * Photos only → collage → WhatsApp preview + Approve (caption optional later).
 */
async function sendCollageForApproval(fromWhatsAppNumber, photos, user, eligibility) {
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: photos.length > 1 ? "Collage bana raha hoon…" : "Photo ready kar raha hoon…",
  });

  const collageUrl = await ensureSessionCollage(fromWhatsAppNumber, photos);

  await sendPosterWhatsApp({
    toMobile: fromWhatsAppNumber,
    imageUrl: collageUrl,
    body:
      `Collage ready (${photos.length} photo${photos.length > 1 ? "s" : ""}).\n` +
      `Caption text bhejo (AI caption), ya *Approve* se sirf collage post.`,
  });

  await offerCaptionFacebookApprove(fromWhatsAppNumber, {
    caption: "",
    style: "photos_only",
    imageUrls: [collageUrl],
    user,
    eligibility,
  });

  return { handled: true, type: "collage_ready", collageUrl, photoCount: photos.length };
}

async function generateAndSendCaption(fromWhatsAppNumber, rawText, photos, user, eligibility) {
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: "AI caption + collage bana raha hoon…",
  });

  const [result, collageUrl] = await Promise.all([
    generateCaption(rawText),
    ensureSessionCollage(fromWhatsAppNumber, photos),
  ]);

  setCaptionSession(fromWhatsAppNumber, {
    photos,
    collageUrl,
    lastStyle: result.style,
    lastCaption: result.caption,
    lastRawText: String(rawText).trim(),
  });

  await sendPosterWhatsApp({
    toMobile: fromWhatsAppNumber,
    imageUrl: collageUrl,
    body: result.caption,
  });

  await offerCaptionFacebookApprove(fromWhatsAppNumber, {
    caption: result.caption,
    style: result.style,
    imageUrls: [collageUrl],
    user,
    eligibility,
  });

  return { handled: true, type: "caption_ready", style: result.style, collageUrl };
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
      `Photos (1–${MAX_CAPTION_PHOTOS}) ek saath ya ek-ek karke bhejo.\n` +
      `Sab aane ke baad ek collage banega (~${Math.round(PHOTO_BATCH_WAIT_MS / 1000)}s), ya *done* likho.\n` +
      `Caption text bhejo to AI caption + collage.`,
  });
  return { handled: true, type: "caption_prompt" };
}

async function approvePendingCaption({ fromWhatsAppNumber }) {
  const pending = getPendingCaptionApproval(fromWhatsAppNumber);
  const hasImages = Array.isArray(pending?.imageUrls) && pending.imageUrls.length > 0;
  const hasCaption = typeof pending?.caption === "string" && pending.caption.trim().length > 0;
  if (!pending?.userId || !pending?.canApproveSocial || (!hasImages && !hasCaption)) {
    return { handled: false, reason: "no_pending_caption" };
  }

  const result = await approveCaptionForUser({
    userId: pending.userId,
    caption: pending.caption || "",
    imageUrls: pending.imageUrls || [],
  });

  clearPendingCaptionApproval(fromWhatsAppNumber);
  clearCaptionSession(fromWhatsAppNumber);

  const pageName = result?.facebook?.pageName || "your Facebook Page";
  let body = hasCaption
    ? `Done! Collage + caption Facebook (${pageName}) pe post ho gaye.`
    : `Done! Collage Facebook (${pageName}) pe post ho gaya.`;
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

  // Menu/commands without media → chatbot (except done/bas while collecting photos)
  if (text && isReservedChatCommand(text) && !hasMedia) {
    const sessionPeek = getCaptionSession(fromWhatsAppNumber);
    const collecting =
      Array.isArray(sessionPeek?.photos) && sessionPeek.photos.length > 0;
    if (!(collecting && isPhotoBatchDoneCommand(text))) {
      return { handled: false, reason: "reserved" };
    }
  }

  // Case 1 & 2: register / Facebook first — do not generate caption.
  const gate = await ensureCaptionEligibility(fromWhatsAppNumber);
  if (!gate.ok) {
    return { handled: true, type: gate.reason };
  }

  try {
    const photos = await ingestWhatsAppPhotos(fromWhatsAppNumber, mediaList);
    const photoCount = photos.length;

    // Photos arriving (often 1-per-webhook) — batch, then one collage.
    if (hasMedia && !text) {
      if (photos.length === 0) {
        await sendWhatsAppText({
          toMobile: fromWhatsAppNumber,
          body: "Photo save nahi hui. Phir se bhejo.",
        });
        return { handled: true, type: "photos_failed" };
      }

      clearPendingCaptionApproval(fromWhatsAppNumber);
      schedulePhotoBatchFinalize(fromWhatsAppNumber, gate.user, gate.eligibility);

      const waitSec = Math.round(PHOTO_BATCH_WAIT_MS / 1000);
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body:
          `${photos.length} photo save.\n` +
          (photos.length < MAX_CAPTION_PHOTOS
            ? `Aur photos bhej sakte ho (max ${MAX_CAPTION_PHOTOS}).\n`
            : "") +
          `${waitSec} sec wait → ek collage banega.\n` +
          `Jaldi chahiye to *done* ya caption text bhejo.`,
      });
      return { handled: true, type: "photos_collecting", photoCount: photos.length };
    }

    // Explicit done while photos are collected → collage now.
    if (text && !hasMedia && isPhotoBatchDoneCommand(text) && photoCount > 0) {
      clearPhotoBatchTimer(fromWhatsAppNumber);
      return await finalizePhotoBatch(
        fromWhatsAppNumber,
        gate.user,
        gate.eligibility,
      );
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
          `Photos se collage banega; text se caption + *Approve* se Facebook pe post.`,
      });
      return { handled: true, type: "need_photos" };
    }

    // Text + photos (or text after photos already saved) → caption + collage.
    const session = getCaptionSession(fromWhatsAppNumber);
    const captionText = text || session?.pendingText || "";
    if (!captionText) {
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body: "Caption ke liye event text bhejo.",
      });
      return { handled: true, type: "need_text" };
    }

    clearPhotoBatchTimer(fromWhatsAppNumber);
    clearPendingCaptionApproval(fromWhatsAppNumber);
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
