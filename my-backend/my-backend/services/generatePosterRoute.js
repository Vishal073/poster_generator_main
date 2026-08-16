const express = require("express");
const multer = require("multer");
const { generatePosterImage } = require("../utils/posterGenerator");
const { enhancePosterBuffer, normalizeEnhancePriority } = require("../utils/posterEnhancementService");
const {
  uploadPosterToCloudinary,
  uploadBufferToCloudinary,
  isAllowedBasePosterSource,
  isAllowedPosterSource,
  isAllowedEventPosterSource,
  getEventPosterRootFolder,
  getEventDisplayNameFromPosterSource,
  listBasePostersFromCloudinary,
  getBasePosterFolder,
} = require("./cloudnaryService");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const User = require("../models/User");
const { queueReadyPosterForDownload } = require("./whatsappPosterDelivery");
const {
  postPosterForUser,
  postPosterToInstagramForUser,
  postPosterStoryForUser,
  postPosterStoryToInstagramForUser,
  postReelForUser,
  postReelToInstagramForUser,
  getUserSocialApproveEligibility,
} = require("./facebookPostService");
const { queueReadyReelForDownload } = require("./whatsappReelDelivery");
const {
  uploadImageWithAudioVideo,
  downloadAudioFromUrl,
  prepareAudioBuffer,
  isAudioUpload,
} = require("./imageAudioVideoService");
const {
  savePosterConfigFromGenerateBody,
} = require("../utils/posterConfigService");
const {
  normalizeFontColor,
  readStyleStringField,
  readStyleNumberField,
} = require("../utils/fontColor");
// const { sendPosterEmail } = require("./emailService"); // Gmail sending is disabled.

const router = express.Router();

const optionalPosterMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "audio" || file.fieldname === "song") {
      if (!isAudioUpload(file)) {
        return cb(new Error("Only audio files are allowed for song/audio."));
      }
      return cb(null, true);
    }

    if (
      file.fieldname === "image" ||
      file.fieldname === "poster" ||
      file.fieldname === "posterImage"
    ) {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return cb(new Error("Only image files are allowed for poster image."));
      }
      return cb(null, true);
    }

    return cb(new Error("Unexpected file field for generate-poster."));
  },
}).fields([
  { name: "audio", maxCount: 1 },
  { name: "song", maxCount: 1 },
  { name: "image", maxCount: 1 },
  { name: "poster", maxCount: 1 },
  { name: "posterImage", maxCount: 1 },
]);

function getUploadedPosterFile(req) {
  return (
    (Array.isArray(req.files?.image) && req.files.image[0]) ||
    (Array.isArray(req.files?.poster) && req.files.poster[0]) ||
    (Array.isArray(req.files?.posterImage) && req.files.posterImage[0]) ||
    null
  );
}

function parseGeneratePosterRequest(req, res, next) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("multipart/form-data")) {
    return next();
  }

  return optionalPosterMediaUpload(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Invalid upload.",
      });
    }

    try {
      if (typeof req.body?.payload === "string" && req.body.payload.trim()) {
        const parsed = JSON.parse(req.body.payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("payload must be a JSON object.");
        }
        req.body = parsed;
      }

      const audioFile =
        (Array.isArray(req.files?.audio) && req.files.audio[0]) ||
        (Array.isArray(req.files?.song) && req.files.song[0]) ||
        null;
      req.audioFile = audioFile;
      req.uploadedPosterFile = getUploadedPosterFile(req);
      return next();
    } catch (parseError) {
      return res.status(400).json({
        success: false,
        message:
          parseError instanceof Error
            ? parseError.message
            : "Invalid payload JSON for generate-poster.",
      });
    }
  });
}


// Hard cap on how many users can be processed per bulk request. Each poster
// is ~3-6 seconds of CPU + Cloudinary upload; Render's free tier kills HTTP
// requests after ~100 seconds, so we limit batch size to stay under that.
const MAX_BULK_USERS = 25;

// Default styling for bulk-generated posters. These mirror the
// `defaultTextLineStyles` and `defaultPosterLayout` constants used by the
// per-user generation flow on the frontend.
const BULK_DEFAULT_TEXT_STYLES = [
  { fontSize: 70, fontFamily: "Helvetica Neue", fontColor: "#1f1f1f", fontWeight: "600" },
  { fontSize: 45, fontFamily: "Helvetica Neue", fontColor: "#2f2f2f", fontWeight: "500" },
  { fontSize: 30, fontFamily: "Avenir Next", fontColor: "#3a3a3a", fontWeight: "normal" },
];

const BULK_DEFAULT_LAYOUT = {
  insetFromBottom: 180,
  insetLeft: 40,
  insetRight: 40,
  imagePosition: "left",
  imageWidth: 300,
  imageHeight: 300,
  imageShape: "circle",
  imageCornerRadius: 16,
  imageGap: 16,
  imageMaxSize: 350,
  lineGap: 0,
  lineGaps: [16, 16],
  paragraphGap: 16,
  fontSize: 40,
  fontColor: "#2a2a2a",
  fontFamily: "Helvetica Neue",
  textOpacity: 1,
  textBlendMode: "source-over",
  textBlockAlign: "left",
  textLineAlignments: ["left", "left", "left"],
};

const basePosterUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  },
});

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object") {
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    if (error.error && typeof error.error.message === "string") {
      return error.error.message;
    }
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function getPosterFileName({ mobileValue, email, fallbackName }) {
  const normalizedIdentifier = mobileValue
    ? String(mobileValue).replace(/\D/g, "")
    : typeof email === "string" && email.trim()
      ? email.trim()
      : String(fallbackName || `poster-${Date.now()}`)
          .trim()
          .replace(/\.png$/i, "");

  // Unique public_id each run so we never overwrite with a bad/test image.
  return `${normalizedIdentifier || "poster"}-${Date.now()}.png`;
}

function isTruthyParam(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
  }
  return value === 1;
}

function isFalsyParam(value) {
  if (value === false) {
    return true;
  }
  if (typeof value === "string") {
    return ["false", "0", "no", "n"].includes(value.trim().toLowerCase());
  }
  return value === 0;
}

function resolveUserImageSource(userImageSource, includeUserImage) {
  if (isFalsyParam(includeUserImage)) {
    return undefined;
  }
  if (typeof userImageSource === "string" && userImageSource.trim()) {
    return userImageSource.trim();
  }
  return undefined;
}

function normalizeImagePosition(value, fallback = "left") {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "center") {
    return "top";
  }
  if (trimmed === "left" || trimmed === "right" || trimmed === "top") {
    return trimmed;
  }
  return fallback;
}

async function applyPosterEnhancement(buffer, enhancePriority) {
  try {
    return await enhancePosterBuffer(buffer, {
      enhancePriority,
      defaultPriority: "medium",
    });
  } catch (error) {
    console.error("Poster enhancement failed, using original image:", error.message);
    return {
      buffer,
      enhancePriority: normalizeEnhancePriority(enhancePriority, "medium"),
      enhanceApplied: "none",
      enhanceFallback: true,
      enhanceError: error.message,
    };
  }
}

async function resolveUserByIdOrMobile(userId, mobileNumber, select) {
  let user = null;

  if (userId && isValidObjectId(userId)) {
    user = await User.findById(userId).select(select).lean();
  }

  if (!user && mobileNumber) {
    const normalizedMobile = String(mobileNumber).replace(/\D/g, "").slice(-10);
    if (/^\d{10}$/.test(normalizedMobile)) {
      user = await User.findOne({ mobileNumber: normalizedMobile }).select(select).lean();
    }
  }

  return user;
}

async function resolveUserEnhancePriority({ userId, mobileNumber }) {
  const user = await resolveUserByIdOrMobile(userId, mobileNumber, "enhancePriority");
  return normalizeEnhancePriority(user?.enhancePriority, "medium");
}

async function generatePoster(req, res) {
  try {
    const body = req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const {
      name = "",
      textLines,
      textLineStyles,
      x,
      y,
      email,
      username,
      MobileNo,
      userImageSource,
      imageX,
      imageY,
      imageWidth = 120,
      imageHeight = 120,
      imageShape = "rectangle",
      imageCornerRadius = 16,
      imagePosition = "left",
      insetFromBottom,
      insetLeft,
      insetRight,
      imageGap = 16,
      imageMaxSize = 120,
      lineGap = 0,
      paragraphGap = 16,
      fontSize = 40,
      fontColor = "#2a2a2a",
      fontFamily = "Helvetica Neue",
      textOpacity = 1,
      textBlendMode = "source-over",
      textBlockAlign = "left",
      textLineAlignments,
      posterSource,
      language = "en",
      userId,
    } = body;

    const resolvedPosterSource =
      typeof posterSource === "string" ? posterSource.trim() : "";
    const uploadedPosterFile = req.uploadedPosterFile || getUploadedPosterFile(req);

    if (!resolvedPosterSource && !uploadedPosterFile) {
      return res.status(400).json({
        success: false,
        message:
          "Send posterSource, or upload the poster image from frontend (field: image).",
        folder: getBasePosterFolder(),
      });
    }

    if (resolvedPosterSource && !isAllowedPosterSource(resolvedPosterSource)) {
      return res.status(400).json({
        success: false,
        message: `posterSource must be an image from Cloudinary folders "${getBasePosterFolder()}" or "${getEventPosterRootFolder()}".`,
        folder: getBasePosterFolder(),
        eventPosterFolder: getEventPosterRootFolder(),
      });
    }

    const mobileValue = MobileNo;
    const hasMobile = mobileValue != null && String(mobileValue).trim().length > 0;
    const shouldSendWhatsApp = isTruthyParam(
      body.sendWhatsApp ?? body.sendToWhatsApp ?? body.sendWhatsapp ?? body.whatsapp
    );

    if (shouldSendWhatsApp && !hasMobile) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required when sendWhatsApp is true.",
      });
    }

    const resolvedEnhancePriority = await resolveUserEnhancePriority({
      userId: body.userId || userId,
      mobileNumber: mobileValue,
    });

    const resolvedTextLineAlignments = parseTextLineAlignments(
      textLineAlignments,
      textBlockAlign
    );
    const resolvedLineGaps = parseLineGaps(body.lineGaps, paragraphGap);

    let posterResult;
    try {
      if (uploadedPosterFile?.buffer) {
        posterResult = {
          buffer: uploadedPosterFile.buffer,
          fileName: uploadedPosterFile.originalname || "poster.png",
          source: "frontend-upload",
        };
      } else {
        posterResult = await generatePosterImage({
          name,
          textLines,
          textLineStyles,
          x,
          y,
          userImageSource: resolveUserImageSource(userImageSource, body.includeUserImage),
          imageX,
          imageY,
          imageWidth,
          imageHeight,
          imageShape,
          imageCornerRadius,
          imagePosition: normalizeImagePosition(imagePosition),
          insetFromBottom,
          insetLeft,
          insetRight,
          imageGap,
          imageMaxSize,
          lineGap,
          paragraphGap,
          lineGaps: resolvedLineGaps,
          fontSize,
          fontColor,
          fontFamily,
          textOpacity,
          textBlendMode,
          textBlockAlign,
          textLineAlignments: resolvedTextLineAlignments,
          posterSource: resolvedPosterSource,
          language,
          showPhoneIcon: !isFalsyParam(body.showPhoneIcon),
          addWatermark: body.addWatermark,
          watermarkPosition: body.watermarkPosition,
        });
      }
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate poster image.",
        error: getErrorMessage(error),
      });
    }

    const enhancement =
      posterResult.source === "frontend-upload"
        ? {
            buffer: posterResult.buffer,
            enhancePriority: resolvedEnhancePriority,
            enhanceApplied: "none",
            enhanceFallback: false,
          }
        : await applyPosterEnhancement(posterResult.buffer, resolvedEnhancePriority);

    const imageName = getPosterFileName({
      mobileValue,
      email,
      fallbackName: posterResult.fileName,
    });
    let uploadResult;
    let uploadedBuffer = enhancement.buffer;
    try {
      uploadResult = await uploadPosterToCloudinary(enhancement.buffer, imageName);
    } catch (error) {
      // AI-enhanced PNGs can be huge and time out; fall back to the original poster.
      const canFallback =
        enhancement.buffer !== posterResult.buffer &&
        Buffer.isBuffer(posterResult.buffer);
      if (!canFallback) {
        return res.status(500).json({
          success: false,
          message: "Poster generated, but Cloudinary upload failed.",
          imageName,
          error: getErrorMessage(error),
        });
      }

      console.warn(
        "[generate-poster] Cloudinary upload timed out/failed for enhanced poster; retrying original buffer:",
        getErrorMessage(error),
      );
      try {
        uploadResult = await uploadPosterToCloudinary(
          posterResult.buffer,
          imageName,
        );
        uploadedBuffer = posterResult.buffer;
      } catch (fallbackError) {
        return res.status(500).json({
          success: false,
          message: "Poster generated, but Cloudinary upload failed.",
          imageName,
          error: getErrorMessage(fallbackError),
        });
      }
    }

    let videoUrl = null;
    const audioFile = req.audioFile || null;
    const audioUrlField =
      typeof body.audioUrl === "string" && body.audioUrl.trim()
        ? body.audioUrl.trim()
        : typeof body.songUrl === "string" && body.songUrl.trim()
          ? body.songUrl.trim()
          : "";

    if (audioFile?.buffer || audioUrlField) {
      try {
        let audioBuffer;
        let audioFileName;
        if (audioFile?.buffer) {
          audioBuffer = audioFile.buffer;
          audioFileName = audioFile.originalname;
        } else {
          const downloaded = await downloadAudioFromUrl(audioUrlField);
          audioBuffer = downloaded.buffer;
          audioFileName = downloaded.fileName;
        }

        const prepared = await prepareAudioBuffer(audioBuffer, audioFileName);
        const videoUpload = await uploadImageWithAudioVideo({
          imageBuffer: uploadedBuffer,
          audioBuffer: prepared.buffer,
          imageFileName: imageName,
          audioFileName: prepared.fileName,
          folder: process.env.CLOUDINARY_POSTER_AUDIO_FOLDER || "poster-with-audio",
          publicFileName: `poster-audio-${Date.now()}.mp4`,
          audioAlreadyPrepared: true,
        });
        videoUrl = videoUpload.videoUrl;
      } catch (error) {
        return res.status(502).json({
          success: false,
          message: "Poster generated, but attaching song failed.",
          imageName,
          imageUrl: uploadResult.imageUrl,
          error: getErrorMessage(error),
        });
      }
    }

    const resolvedUserId =
      typeof (body.userId || userId) === "string" ? String(body.userId || userId).trim() : "";

    let whatsappResult;
    if (shouldSendWhatsApp) {
      try {
        const waUser = await resolveUserByIdOrMobile(
          body.userId || userId,
          mobileValue,
          "name whatsappLastInboundAt",
        );
        const socialEligibility = resolvedUserId
          ? await getUserSocialApproveEligibility(resolvedUserId)
          : { canApprove: false };
        const posterCaption =
          typeof body.facebookCaption === "string"
            ? body.facebookCaption
            : typeof body.caption === "string"
              ? body.caption
              : "";
        const eventName =
          typeof body.eventName === "string" && body.eventName.trim()
            ? body.eventName.trim()
            : getEventDisplayNameFromPosterSource(resolvedPosterSource);
        if (videoUrl) {
          whatsappResult = await queueReadyReelForDownload({
            toMobile: mobileValue,
            name: waUser?.name || name || username || "Customer",
            mobile: mobileValue,
            reelResult: {
              videoUrl,
              message: posterCaption || "Here is your poster",
            },
            lastInboundAt: waUser?.whatsappLastInboundAt || null,
            message: posterCaption || "Here is your poster",
          });
        } else {
          whatsappResult = await queueReadyPosterForDownload({
            toMobile: mobileValue,
            name: waUser?.name || name || username || "Customer",
            mobile: mobileValue,
            posterResult: {
              imageName,
              imageUrl: uploadResult.imageUrl,
              cloudinaryPublicId: uploadResult.publicId,
            },
            userId: resolvedUserId || undefined,
            caption: posterCaption,
            eventName,
            canApproveSocial: socialEligibility.canApprove,
            lastInboundAt: waUser?.whatsappLastInboundAt || null,
          });
        }
      } catch (error) {
        return res.status(502).json({
          success: false,
          message: "Poster generated and uploaded, but WhatsApp delivery failed.",
          imageName,
          imageUrl: uploadResult.imageUrl,
          error: getErrorMessage(error),
        });
      }
    }

    const shouldUploadFacebook = isTruthyParam(
      body.uploadToFacebook ?? body.postToFacebook ?? body.facebook,
    );
    const shouldUploadInstagram = isTruthyParam(
      body.uploadToInstagram ?? body.postToInstagram ?? body.instagram,
    );
    const shouldUploadFacebookStory = isTruthyParam(
      body.uploadToFacebookStory ??
        body.postToFacebookStory ??
        body.facebookStory,
    );
    const shouldUploadInstagramStory = isTruthyParam(
      body.uploadToInstagramStory ??
        body.postToInstagramStory ??
        body.instagramStory,
    );

    if (shouldUploadFacebook && !resolvedUserId) {
      return res.status(400).json({
        success: false,
        message: "userId is required when uploadToFacebook is true.",
      });
    }

    if (shouldUploadInstagram && !resolvedUserId) {
      return res.status(400).json({
        success: false,
        message: "userId is required when uploadToInstagram is true.",
      });
    }

    if (shouldUploadFacebookStory && !resolvedUserId) {
      return res.status(400).json({
        success: false,
        message: "userId is required when uploadToFacebookStory is true.",
      });
    }

    if (shouldUploadInstagramStory && !resolvedUserId) {
      return res.status(400).json({
        success: false,
        message: "userId is required when uploadToInstagramStory is true.",
      });
    }

    const feedCaption =
      typeof body.facebookCaption === "string"
        ? body.facebookCaption
        : typeof body.caption === "string"
          ? body.caption
          : "";

    const shareLinkRaw =
      typeof body.shareLink === "string"
        ? body.shareLink
        : typeof body.shopUrl === "string"
          ? body.shopUrl
          : typeof body.link === "string"
            ? body.link
            : typeof body.websiteUrl === "string"
              ? body.websiteUrl
              : "";
    const shareLink = String(shareLinkRaw || "").trim();
    console.log("[generate-poster] facebook share fields", {
      hasFacebookCaption: Boolean(String(feedCaption || "").trim()),
      shareLinkRawType: typeof body.shareLink,
      shopUrlType: typeof body.shopUrl,
      shareLinkPresent: Boolean(shareLink),
      shareLinkPreview: shareLink.slice(0, 80),
      bodyKeys: Object.keys(body || {}).slice(0, 40),
    });
    if (shareLink) {
      try {
        const parsed = new URL(shareLink);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return res.status(400).json({
            success: false,
            message: "shareLink must be a valid http(s) URL.",
          });
        }
      } catch {
        return res.status(400).json({
          success: false,
          message: "shareLink must be a valid http(s) URL.",
        });
      }
    }

    let facebookResult;
    if (shouldUploadFacebook && resolvedUserId) {
      try {
        const posted = videoUrl
          ? await postReelForUser({
              userId: resolvedUserId,
              videoUrl,
              caption: feedCaption,
              shareLink,
            })
          : await postPosterForUser({
              userId: resolvedUserId,
              imageUrl: uploadResult.imageUrl,
              caption: feedCaption,
              shareLink,
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

    const instagramCaption =
      typeof body.instagramCaption === "string"
        ? body.instagramCaption
        : typeof body.facebookCaption === "string"
          ? body.facebookCaption
          : typeof body.caption === "string"
            ? body.caption
            : "";

    let instagramResult;
    if (shouldUploadInstagram && resolvedUserId) {
      try {
        const posted = videoUrl
          ? await postReelToInstagramForUser({
              userId: resolvedUserId,
              videoUrl,
              caption: instagramCaption,
              shareLink,
            })
          : await postPosterToInstagramForUser({
              userId: resolvedUserId,
              imageUrl: uploadResult.imageUrl,
              caption: instagramCaption,
              shareLink,
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

    let facebookStoryResult;
    if (shouldUploadFacebookStory && resolvedUserId) {
      try {
        const posted = await postPosterStoryForUser({
          userId: resolvedUserId,
          imageUrl: uploadResult.imageUrl,
        });
        facebookStoryResult = {
          success: true,
          ...posted,
        };
      } catch (error) {
        facebookStoryResult = {
          success: false,
          message: getErrorMessage(error),
        };
      }
    }

    let instagramStoryResult;
    if (shouldUploadInstagramStory && resolvedUserId) {
      try {
        const posted = await postPosterStoryToInstagramForUser({
          userId: resolvedUserId,
          imageUrl: uploadResult.imageUrl,
        });
        instagramStoryResult = {
          success: true,
          ...posted,
        };
      } catch (error) {
        instagramStoryResult = {
          success: false,
          message: getErrorMessage(error),
        };
      }
    }

    // Gmail send disabled. To re-enable, call sendPosterEmail(...) here.
    // const emailResult = await sendPosterEmail({ toEmail: email, posterBuffer: posterResult.buffer, fileName: imageName });

    let responseMessage = "Poster generated and uploaded to Cloudinary.";
    if (shouldSendWhatsApp) {
      responseMessage = "Poster generated, uploaded, and sent to WhatsApp.";
    }
    if (shouldUploadFacebook && facebookResult?.success) {
      responseMessage = shouldSendWhatsApp
        ? "Poster generated, uploaded, sent to WhatsApp, and posted to Facebook."
        : "Poster generated, uploaded, and posted to Facebook.";
    }
    if (shouldUploadInstagram && instagramResult?.success) {
      responseMessage = `${responseMessage.replace(/\.$/, "")} and posted to Instagram.`;
    }
    if (shouldUploadFacebookStory && facebookStoryResult?.success) {
      responseMessage = `${responseMessage.replace(/\.$/, "")} and posted to Facebook Story.`;
    }
    if (shouldUploadInstagramStory && instagramStoryResult?.success) {
      responseMessage = `${responseMessage.replace(/\.$/, "")} and posted to Instagram Story.`;
    }

    if (
      isTruthyParam(body.savePosterConfig) &&
      isAllowedEventPosterSource(resolvedPosterSource)
    ) {
      try {
        await savePosterConfigFromGenerateBody(resolvedPosterSource, body);
      } catch (configError) {
        console.warn("Failed to save poster config:", getErrorMessage(configError));
      }
    }

    return res.status(200).json({
      success: true,
      message: responseMessage,
      username: typeof username === "string" && username.trim() ? username.trim() : name,
      email,
      mobile: hasMobile ? String(mobileValue).trim() : undefined,
      sendWhatsApp: shouldSendWhatsApp,
      uploadToFacebook: shouldUploadFacebook,
      uploadToInstagram: shouldUploadInstagram,
      uploadToFacebookStory: shouldUploadFacebookStory,
      uploadToInstagramStory: shouldUploadInstagramStory,
      imageName,
      fileName: imageName,
      imageUrl: uploadResult.imageUrl,
      videoUrl: videoUrl || undefined,
      hasAudio: Boolean(videoUrl),
      cloudinaryPublicId: uploadResult.publicId,
      enhancePriority: enhancement.enhancePriority,
      enhanceApplied: enhancement.enhanceApplied,
      enhanceFallback: enhancement.enhanceFallback,
      enhanceError: enhancement.enhanceError || undefined,
      aiProvider: enhancement.aiProvider || undefined,
      aiModel: enhancement.aiModel || undefined,
      whatsapp: whatsappResult,
      facebook: facebookResult,
      instagram: instagramResult,
      facebookStory: facebookStoryResult,
      instagramStory: instagramStoryResult,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to generate poster.",
      error: getErrorMessage(error),
    });
  }
}

router.post("/generate-poster", parseGeneratePosterRequest, generatePoster);

router.get("/base-posters", async (req, res) => {
  try {
    const posters = await listBasePostersFromCloudinary();

    return res.status(200).json({
      success: true,
      message: posters.length
        ? "Base posters fetched successfully."
        : "No base posters found in Cloudinary.",
      folder: getBasePosterFolder(),
      count: posters.length,
      data: posters,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch base posters from Cloudinary.",
      folder: getBasePosterFolder(),
      error: getErrorMessage(error),
    });
  }
});

router.post(
  "/base-posters",
  requireAuth,
  basePosterUpload.single("poster"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Poster image file is required (field name: 'poster').",
        });
      }

      const fallbackName = `base-poster-${Date.now()}`;
      const fileName = req.file.originalname || fallbackName;

      const uploadResult = await uploadBufferToCloudinary(
        req.file.buffer,
        fileName,
        { folder: getBasePosterFolder() }
      );

      return res.status(201).json({
        success: true,
        message: "Base poster uploaded successfully.",
        folder: getBasePosterFolder(),
        data: {
          publicId: uploadResult.publicId,
          imageUrl: uploadResult.imageUrl,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to upload base poster.",
        folder: getBasePosterFolder(),
        error: getErrorMessage(error),
      });
    }
  }
);

function isValidObjectId(value) {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
}

function parseTextLineStyles(input, fallback) {
  const defaults = fallback.map((style) => ({ ...style }));

  if (!Array.isArray(input) || input.length === 0) {
    return defaults;
  }

  return [0, 1, 2].map((index) => {
    const style = input[index];
    const base = defaults[index] || defaults[defaults.length - 1];

    if (!style || typeof style !== "object") {
      return { ...base };
    }

    return {
      fontSize:
        readStyleNumberField(style, "fontSize") > 0
          ? readStyleNumberField(style, "fontSize")
          : base.fontSize,
      fontFamily: readStyleStringField(style, "fontFamily") || base.fontFamily,
      fontColor: normalizeFontColor(
        readStyleStringField(style, "fontColor"),
        base.fontColor,
      ),
      fontWeight: readStyleStringField(style, "fontWeight") || base.fontWeight,
    };
  });
}

function parseTextLineAlignments(input, fallbackAlign = "left") {
  const blockAlign =
    typeof fallbackAlign === "string" &&
    ["left", "center", "right"].includes(fallbackAlign.trim().toLowerCase())
      ? fallbackAlign.trim().toLowerCase()
      : "left";

  if (!Array.isArray(input)) {
    return [blockAlign, blockAlign, blockAlign];
  }

  return [0, 1, 2].map((index) => {
    const value = input[index];
    if (
      typeof value === "string" &&
      ["left", "center", "right"].includes(value.trim().toLowerCase())
    ) {
      return value.trim().toLowerCase();
    }
    return blockAlign;
  });
}

function parseLineGaps(input, legacyGap = 16) {
  const fallback =
    typeof legacyGap === "number" && Number.isFinite(legacyGap) && legacyGap >= 0
      ? legacyGap
      : 16;
  if (Array.isArray(input) && input.length > 0) {
    const first =
      typeof input[0] === "number" && Number.isFinite(input[0]) && input[0] >= 0
        ? input[0]
        : fallback;
    const second =
      typeof input[1] === "number" && Number.isFinite(input[1]) && input[1] >= 0
        ? input[1]
        : first;
    return [first, second];
  }
  return [fallback, fallback];
}

function resolvePosterSources(body) {
  const fromArray = Array.isArray(body.posterSources)
    ? body.posterSources
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];
  const fromSingle =
    typeof body.posterSource === "string" && body.posterSource.trim()
      ? [body.posterSource.trim()]
      : [];

  const combined = fromArray.length > 0 ? fromArray : fromSingle;
  return [...new Set(combined)];
}

function pickRandomPosterSource(sources) {
  if (!sources.length) {
    return "";
  }
  const index = Math.floor(Math.random() * sources.length);
  return sources[index];
}

function buildTextLinesFromUser(user) {
  let secondLine = "";
  if (user.occupationType === "Politician") {
    secondLine = user.post || user.party || "";
  } else {
    secondLine = user.address || user.city || "";
  }

  return [
    user.name ? String(user.name).trim() : "",
    secondLine ? String(secondLine).trim() : "",
    user.mobileNumber ? String(user.mobileNumber).trim() : "",
  ];
}

// POST /generate-posters/bulk
// Body: { userIds: string[], posterSource: string, language?: string }
// The admin sends one request with selected user IDs + the chosen base
// poster. The backend fetches each user's saved details from MongoDB,
// renders a poster image, uploads to Cloudinary, and returns every
// generated URL in one response. Users are processed sequentially (queue
// of concurrency 1) to keep the canvas memory footprint predictable.
router.post(
  "/generate-posters/bulk",
  requireAuth,
  requireDb,
  parseGeneratePosterRequest,
  async (req, res) => {
    try {
      const body =
        req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};

      const userIds = Array.isArray(body.userIds) ? body.userIds : [];
      const shouldUploadFacebook = isTruthyParam(
        body.uploadToFacebook ?? body.postToFacebook ?? body.facebook,
      );
      const shouldUploadInstagram = isTruthyParam(
        body.uploadToInstagram ?? body.postToInstagram ?? body.instagram,
      );
      const shouldUploadFacebookStory = isTruthyParam(
        body.uploadToFacebookStory ??
          body.postToFacebookStory ??
          body.facebookStory,
      );
      const shouldUploadInstagramStory = isTruthyParam(
        body.uploadToInstagramStory ??
          body.postToInstagramStory ??
          body.instagramStory,
      );
      const includeUserImage = !isFalsyParam(body.includeUserImage);
      const posterSources = resolvePosterSources(body);
      const language =
        typeof body.language === "string" && body.language.trim()
          ? body.language.trim()
          : "en";

      // Admin-overrides for image/text layout. Anything not provided falls
      // back to BULK_DEFAULT_LAYOUT so behaviour is unchanged for callers
      // that only pass userIds + posterSource.
      function pickNumber(value) {
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : undefined;
      }
      function pickString(value, allowed) {
        if (typeof value !== "string" || !value.trim()) return undefined;
        const trimmed = value.trim();
        if (Array.isArray(allowed) && !allowed.includes(trimmed)) {
          return undefined;
        }
        return trimmed;
      }

      const layoutOverrides = {
        insetFromBottom: pickNumber(body.insetFromBottom),
        insetLeft: pickNumber(body.insetLeft),
        insetRight: pickNumber(body.insetRight),
        imagePosition: normalizeImagePosition(
          pickString(body.imagePosition, ["left", "right", "top", "center"]),
          undefined
        ),
        imageWidth: pickNumber(body.imageWidth),
        imageHeight: pickNumber(body.imageHeight),
        imageShape: pickString(body.imageShape, ["circle", "rectangle"]),
        imageCornerRadius: pickNumber(body.imageCornerRadius),
        imageGap: pickNumber(body.imageGap),
        imageMaxSize: pickNumber(body.imageMaxSize),
        lineGap: pickNumber(body.lineGap),
        lineGaps: parseLineGaps(body.lineGaps, pickNumber(body.paragraphGap)),
        paragraphGap: pickNumber(body.paragraphGap),
        fontSize: pickNumber(body.fontSize),
        fontColor: pickString(body.fontColor),
        fontFamily: pickString(body.fontFamily),
        textOpacity: pickNumber(body.textOpacity),
        textBlendMode: pickString(body.textBlendMode, ["source-over", "multiply", "overlay"]),
        textBlockAlign: pickString(body.textBlockAlign, ["left", "center", "right"]),
        textLineAlignments: parseTextLineAlignments(body.textLineAlignments, body.textBlockAlign),
      };

      const resolvedLayout = { ...BULK_DEFAULT_LAYOUT };
      for (const [key, value] of Object.entries(layoutOverrides)) {
        if (value !== undefined) {
          resolvedLayout[key] = value;
        }
      }

      const resolvedTextLineStyles = parseTextLineStyles(
        body.textLineStyles,
        BULK_DEFAULT_TEXT_STYLES
      );

      let sharedAudioBuffer = null;
      let sharedAudioFileName = "bulk-audio.mp3";
      const bulkAudioFile = req.audioFile || null;
      const bulkAudioUrl =
        typeof body.audioUrl === "string" && body.audioUrl.trim()
          ? body.audioUrl.trim()
          : typeof body.songUrl === "string" && body.songUrl.trim()
            ? body.songUrl.trim()
            : "";

      let sharedAudioPrepared = false;
      if (bulkAudioFile?.buffer || bulkAudioUrl) {
        try {
          let rawBuffer;
          let rawName = sharedAudioFileName;
          if (bulkAudioFile?.buffer) {
            rawBuffer = bulkAudioFile.buffer;
            rawName = bulkAudioFile.originalname || rawName;
          } else {
            const downloaded = await downloadAudioFromUrl(bulkAudioUrl);
            rawBuffer = downloaded.buffer;
            rawName = downloaded.fileName || rawName;
          }
          const prepared = await prepareAudioBuffer(rawBuffer, rawName);
          sharedAudioBuffer = prepared.buffer;
          sharedAudioFileName = prepared.fileName;
          sharedAudioPrepared = true;
        } catch (error) {
          return res.status(502).json({
            success: false,
            message: "Failed to prepare song for bulk posters.",
            error: getErrorMessage(error),
          });
        }
      }

      if (posterSources.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "posterSources (non-empty array) or posterSource is required.",
        });
      }

      const invalidPosterSources = posterSources.filter(
        (source) => !isAllowedPosterSource(source)
      );
      if (invalidPosterSources.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Every poster source must be an image from Cloudinary folders "${getBasePosterFolder()}" or "${getEventPosterRootFolder()}".`,
          folder: getBasePosterFolder(),
          eventPosterFolder: getEventPosterRootFolder(),
          invalidCount: invalidPosterSources.length,
        });
      }

      if (userIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "userIds (non-empty array) is required.",
        });
      }

      if (userIds.length > MAX_BULK_USERS) {
        return res.status(400).json({
          success: false,
          message: `Up to ${MAX_BULK_USERS} users can be processed per bulk request.`,
          requested: userIds.length,
          maxAllowed: MAX_BULK_USERS,
        });
      }

      const validIds = userIds.filter(isValidObjectId);
      const users = validIds.length
        ? await User.find({ _id: { $in: validIds } }).lean()
        : [];

      const usersById = new Map(users.map((user) => [String(user._id), user]));

      const results = [];

      for (const userId of userIds) {
        if (!isValidObjectId(userId)) {
          results.push({
            userId,
            name: null,
            status: "error",
            message: "Invalid user id.",
          });
          continue;
        }

        const user = usersById.get(String(userId));
        if (!user) {
          results.push({
            userId,
            name: null,
            status: "error",
            message: "User not found.",
          });
          continue;
        }

        const textLines = buildTextLinesFromUser(user);
        if (textLines.length === 0) {
          results.push({
            userId,
            name: user.name || null,
            mobile: user.mobileNumber,
            status: "error",
            message: "User has no name or contact info to render.",
          });
          continue;
        }

        try {
          const userPosterSource = pickRandomPosterSource(posterSources);

          const posterResult = await generatePosterImage({
            name: "",
            textLines,
            textLineStyles: resolvedTextLineStyles.map((style) => ({ ...style })),
            userImageSource: includeUserImage ? user.userImageUrl || undefined : undefined,
            posterSource: userPosterSource,
            language,
            ...resolvedLayout,
            showPhoneIcon: !isFalsyParam(body.showPhoneIcon),
            addWatermark: body.addWatermark,
            watermarkPosition: body.watermarkPosition,
          });

          const enhancement = await applyPosterEnhancement(
            posterResult.buffer,
            user.enhancePriority || "medium"
          );

          const imageName = getPosterFileName({
            mobileValue: user.mobileNumber,
            email: undefined,
            fallbackName: posterResult.fileName,
          });

          const uploadResult = await uploadPosterToCloudinary(
            enhancement.buffer,
            imageName
          );

          let videoUrl = null;
          if (sharedAudioBuffer) {
            try {
              const videoUpload = await uploadImageWithAudioVideo({
                imageBuffer: enhancement.buffer,
                audioBuffer: sharedAudioBuffer,
                imageFileName: imageName,
                audioFileName: sharedAudioFileName,
                folder:
                  process.env.CLOUDINARY_POSTER_AUDIO_FOLDER ||
                  "poster-with-audio",
                publicFileName: `bulk-audio-${userId}-${Date.now()}.mp4`,
                audioAlreadyPrepared: sharedAudioPrepared,
              });
              videoUrl = videoUpload.videoUrl;
            } catch (error) {
              results.push({
                userId,
                name: user.name,
                mobile: user.mobileNumber,
                status: "error",
                message: `Poster generated, but attaching song failed: ${getErrorMessage(error)}`,
                imageUrl: uploadResult.imageUrl,
                cloudinaryPublicId: uploadResult.publicId,
              });
              continue;
            }
          }

          const feedCaption =
            typeof body.facebookCaption === "string" ? body.facebookCaption : "";
          const shareLinkRaw =
            typeof body.shareLink === "string"
              ? body.shareLink
              : typeof body.shopUrl === "string"
                ? body.shopUrl
                : typeof body.link === "string"
                  ? body.link
                  : typeof body.websiteUrl === "string"
                    ? body.websiteUrl
                    : "";
          const shareLink = String(shareLinkRaw || "").trim();
          const instagramCaption =
            typeof body.instagramCaption === "string"
              ? body.instagramCaption
              : feedCaption;

          let facebookResult;
          if (shouldUploadFacebook) {
            try {
              const posted = videoUrl
                ? await postReelForUser({
                    userId: String(userId),
                    videoUrl,
                    caption: feedCaption,
                    shareLink,
                  })
                : await postPosterForUser({
                    userId: String(userId),
                    imageUrl: uploadResult.imageUrl,
                    caption: feedCaption,
                    shareLink,
                  });
              facebookResult = { success: true, ...posted };
            } catch (error) {
              facebookResult = {
                success: false,
                message: getErrorMessage(error),
              };
            }
          }

          let instagramResult;
          if (shouldUploadInstagram) {
            try {
              const posted = videoUrl
                ? await postReelToInstagramForUser({
                    userId: String(userId),
                    videoUrl,
                    caption: instagramCaption,
                    shareLink,
                  })
                : await postPosterToInstagramForUser({
                    userId: String(userId),
                    imageUrl: uploadResult.imageUrl,
                    caption: instagramCaption,
                    shareLink,
                  });
              instagramResult = { success: true, ...posted };
            } catch (error) {
              instagramResult = {
                success: false,
                message: getErrorMessage(error),
              };
            }
          }

          let facebookStoryResult;
          if (shouldUploadFacebookStory) {
            try {
              const posted = await postPosterStoryForUser({
                userId: String(userId),
                imageUrl: uploadResult.imageUrl,
              });
              facebookStoryResult = { success: true, ...posted };
            } catch (error) {
              facebookStoryResult = {
                success: false,
                message: getErrorMessage(error),
              };
            }
          }

          let instagramStoryResult;
          if (shouldUploadInstagramStory) {
            try {
              const posted = await postPosterStoryToInstagramForUser({
                userId: String(userId),
                imageUrl: uploadResult.imageUrl,
              });
              instagramStoryResult = { success: true, ...posted };
            } catch (error) {
              instagramStoryResult = {
                success: false,
                message: getErrorMessage(error),
              };
            }
          }

          results.push({
            userId,
            name: user.name,
            mobile: user.mobileNumber,
            status: "success",
            posterSource: userPosterSource,
            imageUrl: uploadResult.imageUrl,
            videoUrl: videoUrl || undefined,
            hasAudio: Boolean(videoUrl),
            cloudinaryPublicId: uploadResult.publicId,
            imageName,
            enhancePriority: enhancement.enhancePriority,
            enhanceApplied: enhancement.enhanceApplied,
            enhanceFallback: enhancement.enhanceFallback,
            enhanceError: enhancement.enhanceError || undefined,
            aiProvider: enhancement.aiProvider || undefined,
            aiModel: enhancement.aiModel || undefined,
            facebook: facebookResult,
            instagram: instagramResult,
            facebookStory: facebookStoryResult,
            instagramStory: instagramStoryResult,
          });
        } catch (error) {
          results.push({
            userId,
            name: user.name,
            mobile: user.mobileNumber,
            status: "error",
            message: getErrorMessage(error),
          });
        }
      }

      const successCount = results.filter((r) => r.status === "success").length;
      const errorCount = results.length - successCount;

      const shouldSavePosterConfig = isTruthyParam(body.savePosterConfig);

      if (shouldSavePosterConfig) {
        for (const source of posterSources) {
          if (!isAllowedEventPosterSource(source)) {
            continue;
          }

          try {
            await savePosterConfigFromGenerateBody(source, {
              ...body,
              ...resolvedLayout,
              textLineStyles: resolvedTextLineStyles,
              language,
              includeUserImage,
            });
          } catch (configError) {
            console.warn(
              "Failed to save bulk poster config:",
              getErrorMessage(configError),
            );
          }
        }
      }

      return res.status(200).json({
        success: true,
        message:
          errorCount === 0
            ? `Generated ${successCount} poster${successCount === 1 ? "" : "s"}.`
            : `Generated ${successCount} of ${results.length} posters (${errorCount} failed).`,
        posterSources,
        posterSource: posterSources.length === 1 ? posterSources[0] : undefined,
        language,
        layout: resolvedLayout,
        textLineStyles: resolvedTextLineStyles,
        requested: userIds.length,
        successCount,
        errorCount,
        results,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to process bulk poster generation.",
        error: getErrorMessage(error),
      });
    }
  }
);

module.exports = {
  router,
  generatePoster,
};
