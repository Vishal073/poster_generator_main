const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/requireAuth");
const { listCategoryPresets } = require("../reels/services/categoryPresetService");
const { generateReel } = require("../reels/services/reelGenerateService");
const { generateCarousel } = require("../reels/services/carouselGenerateService");
const { listVoices } = require("../reels/services/elevenLabsService");
const { listLocalVoiceAssets } = require("../reels/services/voiceInputService");
const { listTemplates } = require("../reels/services/templateService");
const {
  MAX_IMAGES,
  MAX_POSTER_IMAGES,
  SLIDER_TEMPLATE_ID,
  SLIDESHOW_CATEGORY_ID,
} = require("../reels/config/constants");
const {
  deliverGeneratedReel,
  deliverGeneratedCarousel,
  isTruthyParam,
} = require("../reels/services/reelDeliveryService");

const router = express.Router();

const reelImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: MAX_IMAGES + MAX_POSTER_IMAGES,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed."));
      return;
    }
    cb(null, true);
  },
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getStatusCode(error, fallback = 500) {
  return typeof error?.statusCode === "number" ? error.statusCode : fallback;
}

function parseImageUrls(body) {
  if (Array.isArray(body.images)) {
    return body.images
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }

  if (typeof body.images === "string" && body.images.trim()) {
    return [body.images.trim()];
  }

  return [];
}

function parseDuration(body) {
  const raw =
    body.duration ??
    body.videoDuration ??
    body.reelDuration ??
    null;

  if (raw == null || raw === "") {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const error = new Error("duration must be a positive number.");
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

function parseCategoryId(body) {
  return typeof body.categoryId === "string" && body.categoryId.trim()
    ? body.categoryId.trim()
    : typeof body.businessType === "string" && body.businessType.trim()
      ? body.businessType.trim()
      : undefined;
}

router.get("/api/reels/templates", requireAuth, async (req, res) => {
  try {
    const templates = await listTemplates();
    return res.status(200).json({
      success: true,
      message: "Reel templates fetched successfully.",
      templates,
    });
  } catch (error) {
    return res.status(getStatusCode(error)).json({
      success: false,
      message: getErrorMessage(error) || "Unable to list reel templates.",
    });
  }
});

router.get("/api/reels/categories", requireAuth, async (req, res) => {
  try {
    const categories = await listCategoryPresets();
    return res.status(200).json({
      success: true,
      message: "Reel categories fetched successfully.",
      categories,
    });
  } catch (error) {
    return res.status(getStatusCode(error)).json({
      success: false,
      message: getErrorMessage(error) || "Unable to list reel categories.",
    });
  }
});

router.get("/api/reels/voices", requireAuth, async (req, res) => {
  try {
    const localVoices = await listLocalVoiceAssets();
    let elevenLabsVoices = [];
    let elevenLabsMessage = null;

    try {
      elevenLabsVoices = await listVoices();
      const apiVoices = elevenLabsVoices.filter((voice) => voice.apiUsable);
      elevenLabsMessage = apiVoices.length
        ? "ElevenLabs voices fetched successfully."
        : "No API-usable custom ElevenLabs voices found.";
    } catch (error) {
      elevenLabsMessage = getErrorMessage(error);
    }

    return res.status(200).json({
      success: true,
      message: localVoices.length
        ? "Local voice files are ready to use."
        : "Add downloaded voice MP3 files to uploads/reels/voice/.",
      localVoices,
      voices: elevenLabsVoices,
      apiVoices: elevenLabsVoices.filter((voice) => voice.apiUsable),
      elevenLabsMessage,
    });
  } catch (error) {
    return res.status(getStatusCode(error)).json({
      success: false,
      message: getErrorMessage(error) || "Unable to list reel voices.",
    });
  }
});

function parseOptionalString(body, keys) {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseEnableVoice(body) {
  const raw = body.enableVoice ?? body.voiceEnabled ?? body.includeVoice;
  if (raw == null || raw === "") {
    return undefined;
  }

  if (typeof raw === "boolean") {
    return raw;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  const error = new Error("enableVoice must be true or false.");
  error.statusCode = 400;
  throw error;
}

function parseTextStyle(body) {
  const raw = body.textStyle ?? body.overlayStyle ?? body.textOverlayStyle;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error("textStyle must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
  }

  if (raw && typeof raw === "object") {
    return raw;
  }

  const style = {};
  const clientColor = parseOptionalString(body, ["clientColor"]);
  const offerColor = parseOptionalString(body, ["offerColor"]);
  const offerAltColor = parseOptionalString(body, ["offerAltColor", "offerColorAlt"]);
  const phoneColor = parseOptionalString(body, ["phoneColor"]);
  if (clientColor) style.clientColor = clientColor;
  if (offerColor) style.offerColor = offerColor;
  if (offerAltColor) style.offerAltColor = offerAltColor;
  if (phoneColor) style.phoneColor = phoneColor;
  const clientFontFamily = parseOptionalString(body, ["clientFontFamily"]);
  const offerFontFamily = parseOptionalString(body, ["offerFontFamily"]);
  const phoneFontFamily = parseOptionalString(body, ["phoneFontFamily"]);
  if (clientFontFamily) style.clientFontFamily = clientFontFamily;
  if (offerFontFamily) style.offerFontFamily = offerFontFamily;
  if (phoneFontFamily) style.phoneFontFamily = phoneFontFamily;
  if (body.clientFontSize != null && body.clientFontSize !== "") {
    style.clientFontSize = body.clientFontSize;
  }
  if (body.offerFontSize != null && body.offerFontSize !== "") {
    style.offerFontSize = body.offerFontSize;
  }
  if (body.phoneFontSize != null && body.phoneFontSize !== "") {
    style.phoneFontSize = body.phoneFontSize;
  }
  if (body.clientY != null && body.clientY !== "") style.clientY = body.clientY;
  if (body.clientX != null && body.clientX !== "") style.clientX = body.clientX;
  if (body.offerY != null && body.offerY !== "") style.offerY = body.offerY;
  if (body.offerX != null && body.offerX !== "") style.offerX = body.offerX;
  if (body.phoneY != null && body.phoneY !== "") style.phoneY = body.phoneY;
  if (body.phoneX != null && body.phoneX !== "") style.phoneX = body.phoneX;
  if (body.clientBackground != null && body.clientBackground !== "") {
    style.clientBackground = body.clientBackground;
  }
  if (body.offerBackground != null && body.offerBackground !== "") {
    style.offerBackground = body.offerBackground;
  }
  if (body.phoneBackground != null && body.phoneBackground !== "") {
    style.phoneBackground = body.phoneBackground;
  }
  if (body.animateOffer != null && body.animateOffer !== "") {
    style.animateOffer = body.animateOffer;
  }
  return Object.keys(style).length ? style : undefined;
}

function parseSticker(body) {
  const raw = body.sticker ?? body.reelSticker ?? body.tatu;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error("sticker must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
  }

  if (raw && typeof raw === "object") {
    return raw;
  }

  return undefined;
}

function parseOutputMode(body) {
  const raw = String(
    body.outputMode ?? body.mode ?? body.format ?? "reel",
  )
    .trim()
    .toLowerCase();

  if (["carousel", "slider_post", "photo_carousel", "photos"].includes(raw)) {
    return "carousel";
  }
  if (["slideshow", "slider", "soft_slideshow", "soft"].includes(raw)) {
    return "slideshow";
  }
  return "reel";
}

router.post(
  "/api/reels/generate",
  requireAuth,
  reelImageUpload.fields([
    { name: "images", maxCount: MAX_IMAGES },
    { name: "poster", maxCount: MAX_POSTER_IMAGES },
  ]),
  async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const templateId =
        typeof body.templateId === "string" ? body.templateId.trim() : undefined;
      const categoryId = parseCategoryId(body);
      const imageUrls = parseImageUrls(body);
      const uploadedFiles = Array.isArray(req.files?.images) ? req.files.images : [];
      const posterFile =
        Array.isArray(req.files?.poster) && req.files.poster[0]
          ? req.files.poster[0]
          : undefined;
      const posterUrl = parseOptionalString(body, [
        "posterUrl",
        "poster_url",
        "clientPosterUrl",
        "client_poster_url",
      ]);
      const durationOverride = parseDuration(body);
      const shopName = parseOptionalString(body, ["shopName", "shop_name"]);
      const clientName = parseOptionalString(body, ["clientName", "client_name"]);
      const phoneNumber = parseOptionalString(body, [
        "phoneNumber",
        "phone",
        "phone_number",
        "mobile",
      ]);
      const offer = parseOptionalString(body, ["offer", "offerText", "offer_text"]);
      const offerText = parseOptionalString(body, [
        "offerText",
        "offer_text",
        "offerPrice",
        "offer_price",
        "offerName",
        "offer_name",
      ]);
      const voiceScript = parseOptionalString(body, [
        "voiceScript",
        "narrationText",
        "narration",
        "script",
      ]);
      const enableVoice = parseEnableVoice(body);
      const voiceId = parseOptionalString(body, ["voiceId", "elevenLabsVoiceId"]);
      const voiceKey = parseOptionalString(body, ["voiceKey", "voiceStyle", "voice"]);
      const voiceUrl = parseOptionalString(body, [
        "voiceUrl",
        "voiceURL",
        "cloudinaryVoiceUrl",
        "cloudinary_voice_url",
      ]);
      const textStyle = parseTextStyle(body);
      const sticker = parseSticker(body);
      const outputMode = parseOutputMode(body);
      const userId = parseOptionalString(body, ["userId", "user_id"]);
      const shouldSendWhatsApp = isTruthyParam(
        body.sendWhatsApp ?? body.sendToWhatsApp ?? body.sendWhatsapp ?? body.whatsapp,
      );
      const shouldUploadFacebook = isTruthyParam(
        body.uploadToFacebook ?? body.postToFacebook ?? body.facebook,
      );
      const shouldUploadInstagram = isTruthyParam(
        body.uploadToInstagram ?? body.postToInstagram ?? body.instagram,
      );
      const caption = parseOptionalString(body, [
        "caption",
        "facebookCaption",
        "instagramCaption",
      ]);
      const whatsappMessage = parseOptionalString(body, [
        "whatsappMessage",
        "whatsapp_message",
      ]);

      if ((shouldSendWhatsApp || shouldUploadFacebook || shouldUploadInstagram) && !userId) {
        return res.status(400).json({
          success: false,
          message:
            "userId is required when sending to WhatsApp or uploading to Facebook/Instagram.",
        });
      }

      if (!imageUrls.length && !uploadedFiles.length) {
        return res.status(400).json({
          success: false,
          message:
            `Provide up to ${MAX_IMAGES} images via JSON "images" URLs or multipart "images" files.`,
        });
      }

      if (outputMode === "carousel") {
        const totalImages = imageUrls.length || uploadedFiles.length;
        if (totalImages < 2) {
          return res.status(400).json({
            success: false,
            message: "Photo carousel needs at least 2 images.",
          });
        }

        const result = await generateCarousel({
          imageUrls,
          uploadedFiles,
          shopName,
          offer,
          clientName,
          phoneNumber,
          offerText,
          textStyle,
          sticker,
        });

        let delivery = null;
        if (shouldSendWhatsApp || shouldUploadFacebook || shouldUploadInstagram) {
          delivery = await deliverGeneratedCarousel({
            userId,
            imageUrls: result.images,
            caption,
            sendWhatsApp: shouldSendWhatsApp,
            uploadToFacebook: shouldUploadFacebook,
            uploadToInstagram: shouldUploadInstagram,
            whatsappMessage,
          });
        }

        return res.status(200).json({
          success: true,
          outputMode: "carousel",
          video: null,
          images: result.images,
          slides: result.slides,
          templateId: result.templateId,
          categoryId: result.categoryId,
          duration: 0,
          decisions: result.decisions,
          sendWhatsApp: shouldSendWhatsApp,
          uploadToFacebook: shouldUploadFacebook,
          uploadToInstagram: shouldUploadInstagram,
          whatsapp: delivery?.whatsapp,
          facebook: delivery?.facebook,
          instagram: delivery?.instagram,
          message: delivery?.message || result.message,
        });
      }

      const resolvedTemplateId =
        outputMode === "slideshow" ? SLIDER_TEMPLATE_ID : templateId;
      const resolvedCategoryId =
        outputMode === "slideshow" ? SLIDESHOW_CATEGORY_ID : categoryId;

      const result = await generateReel({
        templateId: resolvedTemplateId,
        categoryId: resolvedCategoryId,
        imageUrls,
        uploadedFiles,
        durationOverride,
        shopName,
        offer,
        clientName,
        phoneNumber,
        offerText,
        voiceScript,
        enableVoice,
        voiceId,
        voiceKey,
        voiceUrl,
        textStyle,
        sticker,
        posterUrl,
        posterFile,
      });

      let delivery = null;
      if (shouldSendWhatsApp || shouldUploadFacebook || shouldUploadInstagram) {
        delivery = await deliverGeneratedReel({
          userId,
          videoUrl: result.video,
          caption,
          sendWhatsApp: shouldSendWhatsApp,
          uploadToFacebook: shouldUploadFacebook,
          uploadToInstagram: shouldUploadInstagram,
          whatsappMessage,
        });
      }

      return res.status(200).json({
        success: true,
        outputMode: outputMode === "slideshow" ? "slideshow" : "reel",
        video: result.video,
        templateId: result.templateId,
        categoryId: result.categoryId,
        duration: result.duration,
        decisions: result.decisions,
        sendWhatsApp: shouldSendWhatsApp,
        uploadToFacebook: shouldUploadFacebook,
        uploadToInstagram: shouldUploadInstagram,
        whatsapp: delivery?.whatsapp,
        facebook: delivery?.facebook,
        instagram: delivery?.instagram,
        message: delivery?.message || "Reel generated successfully.",
      });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        success: false,
        message: getErrorMessage(error) || "Unable to generate reel.",
      });
    }
  },
);

module.exports = { router };
