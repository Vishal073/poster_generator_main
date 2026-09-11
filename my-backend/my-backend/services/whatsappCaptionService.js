const {
  sendWhatsAppText,
  sendPosterWhatsApp,
  sendReelWhatsApp,
  formatWhatsAppNumber,
  downloadTwilioMedia,
} = require("./whatsappService");
const { generateCaption } = require("../utils/captionGenerateService");
const {
  detectOccasion,
  isReelOccasion,
  generateOccasionReel,
} = require("./occasionReelService");
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
  postReelForUser,
  postReelToInstagramForUser,
} = require("./facebookPostService");
const { uploadPosterToCloudinary } = require("./cloudnaryService");

const pendingCaptionSessions = new Map();
const pendingCaptionApprovals = new Map();
const photoBatchTimers = new Map();
const sessionLocks = new Map();
const sessionBusyCount = new Map();

const CAPTION_SESSION_TTL_MS =
  Number(process.env.CAPTION_SESSION_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;
const CAPTION_APPROVE_TTL_MS =
  Number(process.env.CAPTION_APPROVE_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000;
/** After last photo (or caption+photos), wait this long for more photos then generate. */
const PHOTO_BATCH_WAIT_MS = Math.min(
  Math.max(Number(process.env.CAPTION_PHOTO_BATCH_MS || 20000) || 20000, 5000),
  60000,
);
const MAX_CAPTION_PHOTOS = Math.min(
  Number(process.env.CAPTION_MAX_PHOTOS || 5) || 5,
  10,
);

function runExclusive(fromWhatsAppNumber, fn) {
  const key = sessionKey(fromWhatsAppNumber);
  const prev = sessionLocks.get(key) || Promise.resolve();
  sessionBusyCount.set(key, (sessionBusyCount.get(key) || 0) + 1);
  const next = prev.then(fn, fn).finally(() => {
    const remaining = (sessionBusyCount.get(key) || 1) - 1;
    if (remaining <= 0) {
      sessionBusyCount.delete(key);
    } else {
      sessionBusyCount.set(key, remaining);
    }
  });
  sessionLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function isSessionBusy(fromWhatsAppNumber) {
  return (sessionBusyCount.get(sessionKey(fromWhatsAppNumber)) || 0) > 0;
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
  return ["done", "ok", "ready", "bas", "ho gaya", "hogaya", "finish"].includes(
    normalized,
  );
}

/**
 * Every new photo / caption+photos resets a 20s timer.
 * After quiet 20s: generate if caption exists, else ask for caption text.
 */
function schedulePhotoBatchFinalize(fromWhatsAppNumber, user, eligibility) {
  const key = sessionKey(fromWhatsAppNumber);
  clearPhotoBatchTimer(fromWhatsAppNumber);

  const timer = setTimeout(() => {
    photoBatchTimers.delete(key);

    if (isSessionBusy(fromWhatsAppNumber)) {
      const lock = sessionLocks.get(key) || Promise.resolve();
      lock.finally(() => {
        const session = getCaptionSession(fromWhatsAppNumber);
        if (!session?.photos?.length) return;
        schedulePhotoBatchFinalize(fromWhatsAppNumber, user, eligibility);
      });
      return;
    }

    finalizePhotoBatch(fromWhatsAppNumber, user, eligibility).catch(async (error) => {
      console.error("[caption] photo batch finalize failed:", getErrorMessage(error));
      try {
        await sendWhatsAppText({
          toMobile: fromWhatsAppNumber,
          body: `Photo error: ${getErrorMessage(error)}\n\nPhir se photos bhejo.`,
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

  // No caption yet — stay quiet; user can send text anytime.
  return { handled: true, type: "waiting_for_caption", photoCount: photos.length };
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
      const photoUrl = uploaded?.imageUrl || uploaded?.url;
      if (photoUrl) {
        existing.push(photoUrl);
      }
    }

    setCaptionSession(fromWhatsAppNumber, {
      photos: existing,
    });
    return existing;
  });
}

async function offerCaptionFacebookApprove(fromWhatsAppNumber, {
  caption,
  style,
  imageUrls,
  videoUrl,
  mediaType,
  occasion,
  user,
  eligibility,
}) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  const video = typeof videoUrl === "string" ? videoUrl.trim() : "";
  setPendingCaptionApproval(fromWhatsAppNumber, {
    caption: typeof caption === "string" ? caption : "",
    style: style || "normal",
    imageUrls: urls,
    videoUrl: video || "",
    mediaType: mediaType || (video ? "reel" : "photos"),
    occasion: occasion || "",
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
    const kind = video ? "reel" : "photos";
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `Facebook (${page}) pe ${kind} post karne ke liye *Approve* bhejo.\n` +
        `Skip ke liye *Skip*.`,
    });
  }

  return { offered: true };
}

/**
 * Photos ready → preview originals + Approve (caption optional).
 */
async function offerPhotosForApproval(fromWhatsAppNumber, photos, user, eligibility) {
  const urls = Array.isArray(photos) ? photos.filter(Boolean) : [];
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body:
      `${urls.length} photo ready.\n` +
      `Caption text bhejo (AI caption), ya *Approve* se photos Facebook pe post.`,
  });

  // Preview first photo only (originals stay uncropped for FB).
  if (urls[0]) {
    await sendPosterWhatsApp({
      toMobile: fromWhatsAppNumber,
      imageUrl: urls[0],
      body: urls.length > 1 ? `Preview (1/${urls.length}). Approve pe saari photos jayengi.` : undefined,
    });
  }

  await offerCaptionFacebookApprove(fromWhatsAppNumber, {
    caption: "",
    style: "photos_only",
    imageUrls: urls,
    user,
    eligibility,
  });

  return { handled: true, type: "photos_ready", photoCount: urls.length };
}

async function generateAndSendCaption(fromWhatsAppNumber, rawText, photos, user, eligibility) {
  const urls = Array.isArray(photos) ? photos.filter(Boolean) : [];
  const occasion = detectOccasion(rawText);

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body: isReelOccasion(occasion)
      ? `Generating ${occasion} reel…`
      : "Generating…",
  });

  const result = await generateCaption(rawText);

  setCaptionSession(fromWhatsAppNumber, {
    photos: urls,
    lastStyle: result.style,
    lastCaption: result.caption,
    lastRawText: String(rawText).trim(),
    lastOccasion: occasion,
  });

  // Birthday / party / festival → reel with fixed music.
  if (isReelOccasion(occasion) && urls.length > 0) {
    try {
      const reel = await generateOccasionReel({
        occasion,
        imageUrls: urls,
      });

      await sendReelWhatsApp({
        toMobile: fromWhatsAppNumber,
        videoUrl: reel.videoUrl,
        body:
          `${result.caption}\n\n` +
          `${occasion} reel ready. *Approve* se Facebook pe post.`,
      });

      await offerCaptionFacebookApprove(fromWhatsAppNumber, {
        caption: result.caption,
        style: result.style,
        imageUrls: [],
        videoUrl: reel.videoUrl,
        mediaType: "reel",
        occasion,
        user,
        eligibility,
      });

      return {
        handled: true,
        type: "reel_ready",
        style: result.style,
        occasion,
        videoUrl: reel.videoUrl,
      };
    } catch (error) {
      console.error(
        "[caption] occasion reel failed, falling back to photos:",
        getErrorMessage(error),
      );
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body:
          `Reel nahi ban paya (${getErrorMessage(error)}).\n` +
          `Photos + caption se continue…`,
      });
    }
  }

  if (urls[0]) {
    await sendPosterWhatsApp({
      toMobile: fromWhatsAppNumber,
      imageUrl: urls[0],
      body: result.caption,
    });
  } else {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: result.caption,
    });
  }

  await offerCaptionFacebookApprove(fromWhatsAppNumber, {
    caption: result.caption,
    style: result.style,
    imageUrls: urls,
    mediaType: "photos",
    occasion,
    user,
    eligibility,
  });

  return { handled: true, type: "caption_ready", style: result.style, occasion };
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
      `Photos (1–${MAX_CAPTION_PHOTOS}) + caption text bhejo.\n` +
      `Har photo / caption ke baad ~${Math.round(PHOTO_BATCH_WAIT_MS / 1000)}s wait, phir AI caption.\n` +
      `Birthday / party / festival → reel. *Approve* se Facebook.`,
  });
  return { handled: true, type: "caption_prompt" };
}

async function approvePendingCaption({ fromWhatsAppNumber }) {
  const pending = getPendingCaptionApproval(fromWhatsAppNumber);
  const hasImages = Array.isArray(pending?.imageUrls) && pending.imageUrls.length > 0;
  const hasVideo = typeof pending?.videoUrl === "string" && pending.videoUrl.trim().length > 0;
  const hasCaption = typeof pending?.caption === "string" && pending.caption.trim().length > 0;
  if (!pending?.userId || !pending?.canApproveSocial || (!hasImages && !hasVideo && !hasCaption)) {
    return { handled: false, reason: "no_pending_caption" };
  }

  let result;
  if (hasVideo) {
    const facebook = await postReelForUser({
      userId: pending.userId,
      videoUrl: pending.videoUrl,
      caption: pending.caption || "",
    });

    let instagram = null;
    const eligibility = await getUserSocialApproveEligibility(pending.userId);
    if (eligibility.hasInstagram) {
      try {
        const posted = await postReelToInstagramForUser({
          userId: pending.userId,
          videoUrl: pending.videoUrl,
          caption: pending.caption || "",
        });
        instagram = { success: true, ...posted };
      } catch (error) {
        instagram = {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    result = { facebook, instagram };
  } else {
    result = await approveCaptionForUser({
      userId: pending.userId,
      caption: pending.caption || "",
      imageUrls: pending.imageUrls || [],
    });
  }

  clearPendingCaptionApproval(fromWhatsAppNumber);
  clearCaptionSession(fromWhatsAppNumber);

  const pageName = result?.facebook?.pageName || "your Facebook Page";
  let body;
  if (hasVideo) {
    body = `Done! ${pending.occasion || "Occasion"} reel Facebook (${pageName}) pe post ho gaya.`;
  } else if (hasCaption) {
    body = `Done! Photos + caption Facebook (${pageName}) pe post ho gaye.`;
  } else {
    body = `Done! Photos Facebook (${pageName}) pe post ho gaye.`;
  }
  if (result?.instagram?.success || result?.instagram?.mediaId) {
    body += ` Instagram pe bhi post ho gaya.`;
  } else if (result?.instagram?.message) {
    body += ` Instagram: ${result.instagram.message}`;
  }

  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body,
  });

  return { handled: true, type: hasVideo ? "reel_approved" : "caption_approved", result };
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

    // Photos only — each photo resets 20s wait; no status spam.
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
      return { handled: true, type: "photos_collecting", photoCount: photos.length };
    }

    // Text without photos — save caption silently, ask once for photos.
    if (text && photoCount === 0) {
      setCaptionSession(fromWhatsAppNumber, {
        photos: [],
        pendingText: text,
      });
      await sendWhatsAppText({
        toMobile: fromWhatsAppNumber,
        body: `Photos bhejo (1–${MAX_CAPTION_PHOTOS}).`,
      });
      return { handled: true, type: "need_photos" };
    }

    // Text + photos → save caption, 20s more-photos wait, then Generating…
    if (text && photoCount > 0) {
      setCaptionSession(fromWhatsAppNumber, {
        photos,
        pendingText: text,
      });
      clearPendingCaptionApproval(fromWhatsAppNumber);
      schedulePhotoBatchFinalize(fromWhatsAppNumber, gate.user, gate.eligibility);
      return { handled: true, type: "caption_saved_waiting_photos" };
    }

    return { handled: true, type: "need_input" };
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
