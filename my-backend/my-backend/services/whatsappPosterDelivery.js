const { generatePosterImage } = require("../utils/posterGenerator");
const { uploadPosterToCloudinary } = require("./cloudnaryService");
const {
  formatWhatsAppNumber,
  sendPosterWhatsApp,
  sendWhatsAppText,
} = require("./whatsappService");
const { sendWhatsAppDownloadTemplate } = require("./whatsappTemplateService");
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

function preparePosterInBackground({ to, mobile, posterPayload }) {
  const posterPromise = generateAndUploadPoster({ mobile, posterPayload })
    .then((posterResult) => {
      if (!posterResult) {
        return null;
      }

      updatePendingRequest(to, {
        posterResult,
        posterStatus: "ready",
      });
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

async function sendReadyPoster({ to, name, mobile, posterPayload }) {
  const { pendingRequest, posterResult } = await getOrCreatePosterResult({
    to,
    name,
    mobile,
    posterPayload,
  });

  if (!posterResult?.imageUrl) {
    throw new Error("Poster is not ready yet. Please try again in a moment.");
  }

  const whatsappResult = await sendPosterWhatsApp({
    toMobile: to,
    imageUrl: posterResult.imageUrl,
  });

  updatePendingRequest(to, {
    downloadedAt: new Date().toISOString(),
  });

  return {
    mobile: pendingRequest.mobile,
    imageName: posterResult.imageName,
    imageUrl: posterResult.imageUrl,
    cloudinaryPublicId: posterResult.cloudinaryPublicId,
    whatsapp: whatsappResult,
  };
}

function buildApproveConfirmationMessage(result) {
  const pageName = result?.facebook?.pageName || "your Facebook Page";
  let message = `Done! Your poster was posted to Facebook (${pageName}).`;

  if (result?.instagram?.mediaId) {
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

/**
 * Poster already generated — send "ready" template with Download button; Approve when Facebook connected.
 */
async function queueReadyPosterForDownload({
  toMobile,
  name,
  mobile,
  posterResult,
  posterPayload,
  userId,
  caption,
  canApproveSocial = false,
}) {
  const to = formatWhatsAppNumber(toMobile);

  pendingPosterRequests.set(to, {
    name: String(name || "Customer").trim() || "Customer",
    mobile: String(mobile || toMobile).trim(),
    posterPayload: posterPayload || null,
    posterResult,
    posterStatus: "ready",
    userId: userId ? String(userId) : null,
    caption: typeof caption === "string" ? caption.trim() : "",
    canApproveSocial: Boolean(canApproveSocial),
    createdAt: new Date().toISOString(),
  });

  const templateResult = await sendWhatsAppDownloadTemplate({
    toMobile: mobile || toMobile,
    name,
    withApprove: Boolean(canApproveSocial),
  });

  return {
    mode: canApproveSocial ? "download_and_approve" : "download_button",
    template: templateResult,
    posterStatus: "ready",
    canApproveSocial: Boolean(canApproveSocial),
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
  approveReadyPoster,
  sendApproveConfirmation,
  getPendingPosterRequest,
  toTenDigitMobile,
};
