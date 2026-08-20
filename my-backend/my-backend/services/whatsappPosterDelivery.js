const { generatePosterImage } = require("../utils/posterGenerator");
const { uploadPosterToCloudinary } = require("./cloudnaryService");
const {
  formatWhatsAppNumber,
  sendPosterWhatsApp,
  sendWhatsAppText,
  waitForTwilioMessageReady,
} = require("./whatsappService");
const {
  sendWhatsAppPosterCardTemplate,
  sendWhatsAppApprovePostTemplate,
  getApproveAfterImageDelayMs,
  isWhatsAppSessionOpen,
  delay,
  buildPosterReadyMessage,
} = require("./whatsappTemplateService");
const { approvePosterForUser } = require("./facebookPostService");
const { findUserByMobile } = require("../utils/portalAuth");

const pendingPosterRequests = new Map();

function getPosterFileName(mobileValue) {
  const normalizedMobile = String(mobileValue || "").replace(/\D/g, "");
  return `${normalizedMobile || `poster-${Date.now()}`}.png`;
}

function toTenDigitMobile(value) {
  const digits = String(value || "").replace(/^whatsapp:/i, "").replace(/\D/g, "");
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

function updatePendingRequest(to, updates) {
  const existingRequest = pendingPosterRequests.get(to);
  if (!existingRequest) {
    return;
  }

  pendingPosterRequests.set(to, {
    ...existingRequest,
    ...updates,
  });
}

async function generateAndUploadPoster({ mobile, posterPayload }) {
  const posterResult = await generatePosterImage(posterPayload);
  const imageName = getPosterFileName(mobile);
  const uploadResult = await uploadPosterToCloudinary(posterResult.buffer, imageName);

  return {
    imageName,
    imageUrl: uploadResult.imageUrl,
    cloudinaryPublicId: uploadResult.publicId,
  };
}

function preparePosterInBackground({ to, mobile, posterPayload, autoDeliverOnReady = false }) {
  const posterPromise = generateAndUploadPoster({ mobile, posterPayload })
    .then(async (posterResult) => {
      if (!posterResult) {
        return null;
      }

      updatePendingRequest(to, {
        posterResult,
        posterStatus: "ready",
      });

      if (autoDeliverOnReady) {
        const pending = pendingPosterRequests.get(to);
        await deliverReadyPoster({
          to,
          name: pending?.name || "Customer",
          mobile: pending?.mobile || mobile,
          posterPayload,
          sessionOpen: Boolean(pending?.sessionOpen),
          eventName: pending?.eventName,
        });
      }

      return posterResult;
    })
    .catch((error) => {
      updatePendingRequest(to, {
        posterError: error instanceof Error ? error.message : String(error),
        posterStatus: "failed",
      });
      console.error("Poster pre-generation failed:", error);
      return null;
    });

  updatePendingRequest(to, {
    posterPromise,
    posterStatus: "generating",
  });
}

async function getOrCreatePosterResult({ to, name, mobile, posterPayload }) {
  const pendingRequest = pendingPosterRequests.get(to) || {
    name,
    mobile,
    posterPayload,
  };
  const resolvedPosterPayload =
    pendingRequest.posterPayload ||
    posterPayload ||
    null;
  let posterResult =
    pendingRequest.posterResult ||
    (pendingRequest.posterPromise ? await pendingRequest.posterPromise : null);

  if (!posterResult && resolvedPosterPayload) {
    posterResult = await generateAndUploadPoster({
      mobile: pendingRequest.mobile,
      posterPayload: resolvedPosterPayload,
    });
  }

  return {
    pendingRequest,
    posterResult,
  };
}

async function sendReadyPoster({ to, name, mobile, posterPayload, eventName }) {
  const { pendingRequest, posterResult } = await getOrCreatePosterResult({
    to,
    name,
    mobile,
    posterPayload,
  });

  if (!posterResult?.imageUrl) {
    throw new Error("Poster is not ready yet. Please try again in a moment.");
  }

  const resolvedEventName = eventName || pendingRequest.eventName;
  const whatsappResult = await sendPosterWhatsApp({
    toMobile: to,
    imageUrl: posterResult.imageUrl,
    body: buildPosterReadyMessage({
      eventName: resolvedEventName,
    }),
  });

  if (whatsappResult.sid) {
    await waitForTwilioMessageReady(whatsappResult.sid);
  }

  const approveDelayMs = getApproveAfterImageDelayMs();
  if (approveDelayMs > 0) {
    await delay(approveDelayMs);
  }

  updatePendingRequest(to, {
    downloadedAt: new Date().toISOString(),
  });

  let approveOffer = null;
  const latestPending = pendingPosterRequests.get(to) || pendingRequest;
  if (latestPending.canApproveSocial) {
    approveOffer = await sendWhatsAppApprovePostTemplate({
      toMobile: to,
      name: latestPending.name || name,
    });
    if (approveOffer) {
      updatePendingRequest(to, {
        approveOfferedAt: new Date().toISOString(),
      });
    }
  }

  return {
    mobile: pendingRequest.mobile,
    imageName: posterResult.imageName,
    imageUrl: posterResult.imageUrl,
    cloudinaryPublicId: posterResult.cloudinaryPublicId,
    whatsapp: whatsappResult,
    approveOffer,
  };
}

function buildApproveConfirmationMessage(result) {
  const pageName = result?.facebook?.pageName || "your Facebook Page";
  let message = `Done! Your poster was posted to Facebook (${pageName}).`;

  if (result?.instagram?.success || result?.instagram?.mediaId) {
    const handle = result.instagram.username ? `@${result.instagram.username}` : "Instagram";
    message += ` Posted to ${handle} too.`;
  } else if (result?.instagram?.message) {
    message += ` Instagram could not be updated: ${result.instagram.message}`;
  }

  return message;
}

async function resolvePendingUserId(pendingRequest, mobile) {
  if (pendingRequest?.userId) {
    return String(pendingRequest.userId);
  }

  const user = await findUserByMobile(mobile);
  if (!user?._id) {
    throw new Error("Could not find your account for Facebook posting.");
  }

  return String(user._id);
}

/**
 * User tapped Approve — post to Facebook Page (+ Instagram when linked). Download still available until Skip.
 */
async function approveReadyPoster({ to, mobile }) {
  const pendingRequest = pendingPosterRequests.get(to);
  if (!pendingRequest) {
    throw new Error("No pending poster found. Please ask admin to send a new poster.");
  }

  if (!pendingRequest.canApproveSocial) {
    throw new Error("Facebook posting is not available for this poster.");
  }

  if (!pendingRequest.downloadedAt) {
    throw new Error("Please tap Download first to receive your poster.");
  }

  const { posterResult } = await getOrCreatePosterResult({
    to,
    name: pendingRequest.name,
    mobile: pendingRequest.mobile || mobile,
    posterPayload: pendingRequest.posterPayload,
  });

  if (!posterResult?.imageUrl) {
    throw new Error("Poster is not ready yet. Please try again in a moment.");
  }

  const userId = await resolvePendingUserId(pendingRequest, mobile || pendingRequest.mobile);
  const result = await approvePosterForUser({
    userId,
    imageUrl: posterResult.imageUrl,
    caption: pendingRequest.caption || "",
  });

  updatePendingRequest(to, {
    userId,
    approvedAt: new Date().toISOString(),
    lastApproveResult: result,
  });

  return result;
}

async function sendApproveConfirmation({ toMobile, result }) {
  return sendWhatsAppText({
    toMobile,
    body: buildApproveConfirmationMessage(result),
  });
}

async function sendReadyPosterAsMediaTemplate({
  to,
  name,
  mobile,
  posterPayload,
  eventName,
}) {
  const { pendingRequest, posterResult } = await getOrCreatePosterResult({
    to,
    name,
    mobile,
    posterPayload,
  });

  if (!posterResult?.imageUrl) {
    throw new Error("Poster is not ready yet. Please try again in a moment.");
  }

  const resolvedEventName = eventName || pendingRequest.eventName;
  const templateResult = await sendWhatsAppPosterCardTemplate({
    toMobile: to,
    name: pendingRequest.name || name,
    eventName: resolvedEventName,
    imageUrl: posterResult.imageUrl,
  });

  if (templateResult.sid) {
    await waitForTwilioMessageReady(templateResult.sid);
  }

  const whatsappResult = templateResult;

  const approveDelayMs = getApproveAfterImageDelayMs();
  if (approveDelayMs > 0) {
    await delay(approveDelayMs);
  }

  updatePendingRequest(to, {
    downloadedAt: new Date().toISOString(),
  });

  let approveOffer = null;
  const latestPending = pendingPosterRequests.get(to) || pendingRequest;
  if (latestPending.canApproveSocial && !templateResult.hasApproveAction) {
    approveOffer = await sendWhatsAppApprovePostTemplate({
      toMobile: to,
      name: latestPending.name || name,
    });
    if (approveOffer) {
      updatePendingRequest(to, {
        approveOfferedAt: new Date().toISOString(),
      });
    }
  }

  return {
    mobile: pendingRequest.mobile,
    imageName: posterResult.imageName,
    imageUrl: posterResult.imageUrl,
    cloudinaryPublicId: posterResult.cloudinaryPublicId,
    whatsapp: whatsappResult,
    template: templateResult,
    approveOffer,
  };
}

async function deliverReadyPoster({
  to,
  name,
  mobile,
  posterPayload,
  sessionOpen,
  eventName,
}) {
  if (sessionOpen) {
    return sendReadyPoster({
      to,
      name,
      mobile,
      posterPayload,
      eventName,
    });
  }

  return sendReadyPosterAsMediaTemplate({
    to,
    name,
    mobile,
    posterPayload,
    eventName,
  });
}

/**
 * Active 24h WhatsApp session → send image directly.
 * Otherwise send the approved media template with event name + poster image.
 */
async function queueReadyPosterForDownload({
  toMobile,
  name,
  mobile,
  posterResult,
  posterPayload,
  userId,
  caption,
  eventName,
  canApproveSocial = false,
  lastInboundAt = null,
}) {
  const to = formatWhatsAppNumber(toMobile);
  const sessionOpen = isWhatsAppSessionOpen(lastInboundAt);
  const displayName = String(name || "Customer").trim() || "Customer";
  const displayMobile = String(mobile || toMobile).trim();
  const displayEventName = String(eventName || "").trim();

  pendingPosterRequests.set(to, {
    name: displayName,
    mobile: displayMobile,
    eventName: displayEventName,
    posterPayload: posterPayload || null,
    posterResult,
    posterStatus: "ready",
    userId: userId ? String(userId) : null,
    caption: typeof caption === "string" ? caption.trim() : "",
    canApproveSocial: Boolean(canApproveSocial),
    sessionOpen,
    createdAt: new Date().toISOString(),
  });

  if (sessionOpen) {
    const directResult = await sendReadyPoster({
      to,
      name: displayName,
      mobile: displayMobile,
      posterPayload: posterPayload || null,
      eventName: displayEventName,
    });

    return {
      mode: "direct",
      sessionOpen: true,
      posterStatus: "ready",
      canApproveSocial: Boolean(canApproveSocial),
      ...directResult,
    };
  }

  const templateResult = await sendReadyPosterAsMediaTemplate({
    to,
    name: displayName,
    mobile: displayMobile,
    posterPayload: posterPayload || null,
    eventName: displayEventName,
  });

  return {
    mode: "media_template",
    sessionOpen: false,
    posterStatus: "ready",
    canApproveSocial: Boolean(canApproveSocial),
    ...templateResult,
  };
}

function getPendingPosterRequest(toMobile) {
  const to = formatWhatsAppNumber(toMobile);
  return pendingPosterRequests.get(to) || null;
}

module.exports = {
  pendingPosterRequests,
  preparePosterInBackground,
  queueReadyPosterForDownload,
  sendReadyPoster,
  deliverReadyPoster,
  approveReadyPoster,
  sendApproveConfirmation,
  getPendingPosterRequest,
  toTenDigitMobile,
};
