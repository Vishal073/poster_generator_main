const mongoose = require("mongoose");
const User = require("../../models/User");
const {
  postReelForUser,
  postReelToInstagramForUser,
  postCarouselForUser,
  postCarouselToInstagramForUser,
  postPosterForUser,
  postPosterToInstagramForUser,
} = require("../../services/facebookPostService");
const { queueReadyReelForDownload } = require("../../services/whatsappReelDelivery");
const { sendPosterWhatsApp } = require("../../services/whatsappService");

function isTruthyParam(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
  }
  return value === 1;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function loadUserForDelivery(userId) {
  if (!userId || typeof userId !== "string" || !mongoose.Types.ObjectId.isValid(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId)
    .select("name mobileNumber whatsappLastInboundAt")
    .lean();

  if (!user) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }

  if (!user.mobileNumber || !String(user.mobileNumber).trim()) {
    const error = new Error("User does not have a mobile number for WhatsApp delivery.");
    error.statusCode = 400;
    throw error;
  }

  return user;
}

async function deliverGeneratedReel({
  userId,
  videoUrl,
  caption = "",
  sendWhatsApp = false,
  uploadToFacebook = false,
  uploadToInstagram = false,
  whatsappMessage = "",
}) {
  const resolvedCaption = typeof caption === "string" ? caption.trim() : "";
  const resolvedMessage =
    typeof whatsappMessage === "string" && whatsappMessage.trim()
      ? whatsappMessage.trim()
      : resolvedCaption || "Here is your reel";

  let whatsappResult;
  let facebookResult;
  let instagramResult;

  if (sendWhatsApp) {
    const user = await loadUserForDelivery(userId);
    try {
      whatsappResult = await queueReadyReelForDownload({
        toMobile: user.mobileNumber,
        name: user.name || "Customer",
        mobile: user.mobileNumber,
        reelResult: { videoUrl },
        lastInboundAt: user.whatsappLastInboundAt || null,
        message: resolvedMessage,
      });
    } catch (error) {
      const deliveryError = new Error(getErrorMessage(error));
      deliveryError.statusCode = error?.statusCode || 502;
      throw deliveryError;
    }
  }

  if (uploadToFacebook) {
    try {
      const posted = await postReelForUser({
        userId,
        videoUrl,
        caption: resolvedCaption,
      });
      facebookResult = {
        success: true,
        ...posted,
      };
    } catch (error) {
      facebookResult = {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  if (uploadToInstagram) {
    try {
      const posted = await postReelToInstagramForUser({
        userId,
        videoUrl,
        caption: resolvedCaption,
      });
      instagramResult = {
        success: true,
        ...posted,
      };
    } catch (error) {
      instagramResult = {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  let message = "Reel generated successfully.";
  if (sendWhatsApp && whatsappResult) {
    message = "Reel generated and sent to WhatsApp.";
  }
  if (uploadToFacebook && facebookResult?.success) {
    message = sendWhatsApp
      ? "Reel generated, sent to WhatsApp, and posted to Facebook."
      : "Reel generated and posted to Facebook.";
  }
  if (uploadToInstagram && instagramResult?.success) {
    message = `${message.replace(/\.$/, "")} and posted to Instagram.`;
  }

  return {
    message,
    whatsapp: whatsappResult,
    facebook: facebookResult,
    instagram: instagramResult,
  };
}

async function deliverGeneratedCarousel({
  userId,
  imageUrls = [],
  caption = "",
  sendWhatsApp = false,
  uploadToFacebook = false,
  uploadToInstagram = false,
  whatsappMessage = "",
}) {
  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const resolvedCaption = typeof caption === "string" ? caption.trim() : "";
  const resolvedMessage =
    typeof whatsappMessage === "string" && whatsappMessage.trim()
      ? whatsappMessage.trim()
      : resolvedCaption || "Here is your carousel";

  let whatsappResult;
  let facebookResult;
  let instagramResult;

  if (sendWhatsApp) {
    const user = await loadUserForDelivery(userId);
    try {
      const firstImage = urls[0];
      if (!firstImage) {
        throw new Error("No carousel image available for WhatsApp.");
      }
      whatsappResult = await sendPosterWhatsApp({
        toMobile: user.mobileNumber,
        imageUrl: firstImage,
        body: resolvedMessage,
      });
    } catch (error) {
      const deliveryError = new Error(getErrorMessage(error));
      deliveryError.statusCode = error?.statusCode || 502;
      throw deliveryError;
    }
  }

  if (uploadToFacebook) {
    try {
      if (urls.length >= 2) {
        const posted = await postCarouselForUser({
          userId,
          imageUrls: urls,
          caption: resolvedCaption,
        });
        facebookResult = { success: true, ...posted };
      } else {
        const posted = await postPosterForUser({
          userId,
          imageUrl: urls[0],
          caption: resolvedCaption,
        });
        facebookResult = { success: true, ...posted };
      }
    } catch (error) {
      facebookResult = {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  if (uploadToInstagram) {
    try {
      if (urls.length >= 2) {
        const posted = await postCarouselToInstagramForUser({
          userId,
          imageUrls: urls,
          caption: resolvedCaption,
        });
        instagramResult = { success: true, ...posted };
      } else {
        const posted = await postPosterToInstagramForUser({
          userId,
          imageUrl: urls[0],
          caption: resolvedCaption,
        });
        instagramResult = { success: true, ...posted };
      }
    } catch (error) {
      instagramResult = {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  let message = "Photo carousel generated successfully.";
  if (sendWhatsApp && whatsappResult) {
    message = "Carousel generated and first slide sent to WhatsApp.";
  }
  if (uploadToFacebook && facebookResult?.success) {
    message = sendWhatsApp
      ? "Carousel generated, sent to WhatsApp, and posted to Facebook."
      : "Carousel generated and posted to Facebook.";
  }
  if (uploadToInstagram && instagramResult?.success) {
    message = `${message.replace(/\.$/, "")} and posted to Instagram.`;
  }

  return {
    message,
    whatsapp: whatsappResult,
    facebook: facebookResult,
    instagram: instagramResult,
  };
}

module.exports = {
  deliverGeneratedReel,
  deliverGeneratedCarousel,
  isTruthyParam,
};
