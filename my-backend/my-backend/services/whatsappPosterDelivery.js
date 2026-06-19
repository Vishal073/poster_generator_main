const { generatePosterImage } = require("../utils/posterGenerator");
const { uploadPosterToCloudinary } = require("./cloudnaryService");
const {
  formatWhatsAppNumber,
  sendPosterWhatsApp,
} = require("./whatsappService");
const { sendWhatsAppDownloadTemplate } = require("./whatsappTemplateService");

const pendingPosterRequests = new Map();

function getPosterFileName(mobileValue) {
  const normalizedMobile = String(mobileValue || "").replace(/\D/g, "");
  return `${normalizedMobile || `poster-${Date.now()}`}.png`;
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

  pendingPosterRequests.delete(to);

  return {
    mobile: pendingRequest.mobile,
    imageName: posterResult.imageName,
    imageUrl: posterResult.imageUrl,
    cloudinaryPublicId: posterResult.cloudinaryPublicId,
    whatsapp: whatsappResult,
  };
}

/**
 * Poster already generated — send "ready" template with Download button; image on tap.
 */
async function queueReadyPosterForDownload({ toMobile, name, mobile, posterResult, posterPayload }) {
  const to = formatWhatsAppNumber(toMobile);

  pendingPosterRequests.set(to, {
    name: String(name || "Customer").trim() || "Customer",
    mobile: String(mobile || toMobile).trim(),
    posterPayload: posterPayload || null,
    posterResult,
    posterStatus: "ready",
    createdAt: new Date().toISOString(),
  });

  const templateResult = await sendWhatsAppDownloadTemplate({
    toMobile: mobile || toMobile,
    name,
  });

  return {
    mode: "download_button",
    template: templateResult,
    posterStatus: "ready",
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
  getPendingPosterRequest,
};
