const express = require("express");
const multer = require("multer");
const User = require("../models/User");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const { uploadBufferToCloudinary } = require("./cloudnaryService");
const { sendWhatsAppImageSmart } = require("./whatsappTemplateService");
const {
  postPosterForUser,
  postReelForUser,
  postPosterToInstagramForUser,
  postReelToInstagramForUser,
  postPosterStoryForUser,
  postPosterStoryToInstagramForUser,
} = require("./facebookPostService");
const { queueReadyReelForDownload } = require("./whatsappReelDelivery");
const {
  uploadImageWithAudioVideo,
  downloadAudioFromUrl,
  prepareAudioBuffer,
  isAudioUpload,
} = require("./imageAudioVideoService");
const {
  composeShareImageWithAi,
  isAiProviderConfigured,
  MAX_REFERENCE_IMAGES,
} = require("../utils/shareAiComposeService");

const router = express.Router();

const imageUpload = multer({
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

const shareMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "image") {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return cb(new Error("Only image files are allowed for image."));
      }
      return cb(null, true);
    }

    if (file.fieldname === "audio" || file.fieldname === "song") {
      if (!isAudioUpload(file)) {
        return cb(new Error("Only audio files are allowed for song/audio."));
      }
      return cb(null, true);
    }

    if (file.fieldname === "video") {
      if (!file.mimetype || !file.mimetype.startsWith("video/")) {
        return cb(new Error("Only video files are allowed for video."));
      }
      return cb(null, true);
    }

    return cb(new Error(`Unexpected file field: ${file.fieldname}`));
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

function isTruthyParam(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
  }
  return value === 1;
}

function getShareImageFileName(user, originalName) {
  const extension = String(originalName || "").match(/\.[^.]+$/)?.[0] || ".jpg";
  const mobile = String(user.mobileNumber || "").replace(/\D/g, "");
  return `share-${mobile || user._id}-${Date.now()}${extension}`;
}

function isAllowedCloudinaryImageUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "res.cloudinary.com" ||
        parsed.hostname.endsWith(".cloudinary.com"))
    );
  } catch {
    return false;
  }
}

async function fetchImageBufferFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function resolveShareImageBuffer(req) {
  const body =
    req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};

  const imageFile =
    req.file ||
    (Array.isArray(req.files?.image) ? req.files.image[0] : null) ||
    (Array.isArray(req.files) ? req.files.find((file) => file.fieldname === "image") : null);

  if (imageFile?.buffer) {
    return {
      buffer: imageFile.buffer,
      originalName: imageFile.originalname,
      source: "upload",
    };
  }

  const imageUrl =
    typeof body.imageUrl === "string" && body.imageUrl.trim()
      ? body.imageUrl.trim()
      : "";

  if (!imageUrl) {
    return null;
  }

  if (!isAllowedCloudinaryImageUrl(imageUrl)) {
    throw new Error("imageUrl must be a Cloudinary https URL.");
  }

  const buffer = await fetchImageBufferFromUrl(imageUrl);
  return {
    buffer,
    originalName: "generated.png",
    source: "imageUrl",
    imageUrl,
  };
}

function getAudioFile(req) {
  if (Array.isArray(req.files?.audio) && req.files.audio[0]) {
    return req.files.audio[0];
  }
  if (Array.isArray(req.files?.song) && req.files.song[0]) {
    return req.files.song[0];
  }
  if (Array.isArray(req.files)) {
    return (
      req.files.find((file) => file.fieldname === "audio" || file.fieldname === "song") ||
      null
    );
  }
  return null;
}

function getVideoFile(req) {
  if (Array.isArray(req.files?.video) && req.files.video[0]) {
    return req.files.video[0];
  }
  if (Array.isArray(req.files)) {
    return req.files.find((file) => file.fieldname === "video") || null;
  }
  return null;
}

function getShareVideoFileName(user, originalName) {
  const extension = String(originalName || "").match(/\.[^.]+$/)?.[0] || ".mp4";
  const mobile = String(user.mobileNumber || "").replace(/\D/g, "");
  return `share-video-${mobile || user._id}-${Date.now()}${extension}`;
}

/**
 * POST /users/:id/share-image/generate-ai
 * multipart: references[] (1–5 images)
 * fields: name, category
 */
router.post(
  "/users/:id/share-image/generate-ai",
  requireAuth,
  requireDb,
  imageUpload.array("references", MAX_REFERENCE_IMAGES),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!id || !/^[a-f\d]{24}$/i.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user id.",
        });
      }

      const user = await User.findById(id).lean();
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found.",
        });
      }

      if (!isAiProviderConfigured()) {
        return res.status(503).json({
          success: false,
          message: "AI image generation is not configured. Set FAL_KEY on the server.",
        });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({
          success: false,
          message: `At least one reference image is required (field: references, max ${MAX_REFERENCE_IMAGES}).`,
        });
      }

      const body =
        req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};

      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : String(user.name || "").trim();

      const category =
        typeof body.category === "string" && body.category.trim()
          ? body.category.trim()
          : String(user.category || user.shopType || "").trim();

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Name is required for AI generation.",
        });
      }

      if (!category) {
        return res.status(400).json({
          success: false,
          message: "Category is required for AI generation.",
        });
      }

      const referenceBuffers = files.map((file) => file.buffer);

      let result;
      try {
        result = await composeShareImageWithAi({
          referenceBuffers,
          name,
          category,
        });
      } catch (error) {
        return res.status(502).json({
          success: false,
          message: "AI image generation failed.",
          error: getErrorMessage(error),
        });
      }

      return res.status(200).json({
        success: true,
        message: "AI image generated successfully.",
        userId: String(user._id),
        name,
        category,
        imageUrl: result.imageUrl,
        cloudinaryPublicId: result.cloudinaryPublicId,
        referenceCollageUrl: result.referenceCollageUrl,
        referenceCount: result.referenceCount,
        model: result.model,
        provider: result.provider,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate AI image.",
        error: getErrorMessage(error),
      });
    }
  }
);

/**
 * POST /users/:id/share-image
 * multipart: image (file) OR video (file) OR field imageUrl (Cloudinary URL from generate-ai)
 * optional: audio / song (file) — image becomes a video with the song
 * fields: sendWhatsApp, uploadToFacebook, caption, whatsappMessage
 */
router.post(
  "/users/:id/share-image",
  requireAuth,
  requireDb,
  shareMediaUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 },
    { name: "song", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!id || !/^[a-f\d]{24}$/i.test(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user id.",
        });
      }

      const user = await User.findById(id).lean();
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found.",
        });
      }

      let imageInput = null;
      const videoFile = getVideoFile(req);

      if (!videoFile) {
        try {
          imageInput = await resolveShareImageBuffer(req);
        } catch (error) {
          return res.status(400).json({
            success: false,
            message: getErrorMessage(error),
          });
        }
      }

      if (!videoFile && !imageInput) {
        return res.status(400).json({
          success: false,
          message:
            "Provide an image file, a video file, or imageUrl from AI generation.",
        });
      }

      if (videoFile && imageInput) {
        return res.status(400).json({
          success: false,
          message: "Send either an image or a video file, not both.",
        });
      }

      const body =
        req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};

      const sendWhatsApp = isTruthyParam(
        body.sendWhatsApp ?? body.sendToWhatsApp ?? body.whatsapp
      );
      const uploadToFacebook = isTruthyParam(
        body.uploadToFacebook ?? body.postToFacebook ?? body.facebook
      );
      const uploadToInstagram = isTruthyParam(
        body.uploadToInstagram ?? body.postToInstagram ?? body.instagram
      );
      const uploadToFacebookStory = isTruthyParam(
        body.uploadToFacebookStory ??
          body.postToFacebookStory ??
          body.facebookStory
      );
      const uploadToInstagramStory = isTruthyParam(
        body.uploadToInstagramStory ??
          body.postToInstagramStory ??
          body.instagramStory
      );
      const caption =
        typeof body.caption === "string" ? body.caption.trim() : "";
      const instagramCaption =
        typeof body.instagramCaption === "string"
          ? body.instagramCaption.trim()
          : caption;
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
      const whatsappMessage =
        typeof body.whatsappMessage === "string" && body.whatsappMessage.trim()
          ? body.whatsappMessage.trim()
          : "Here is your image";

      if (
        !sendWhatsApp &&
        !uploadToFacebook &&
        !uploadToInstagram &&
        !uploadToFacebookStory &&
        !uploadToInstagramStory
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enable at least one of WhatsApp, Facebook, Instagram, or Story upload.",
        });
      }

      let imageUrl = imageInput?.imageUrl;
      let uploadResult;
      let videoUrl = null;
      const audioFile = getAudioFile(req);
      const audioUrlField =
        typeof body.audioUrl === "string" && body.audioUrl.trim()
          ? body.audioUrl.trim()
          : typeof body.songUrl === "string" && body.songUrl.trim()
            ? body.songUrl.trim()
            : "";
      const hasAudioFile = Boolean(audioFile?.buffer);
      const hasAudioUrl = Boolean(audioUrlField);
      const hasAudio = hasAudioFile || hasAudioUrl;

      if (videoFile) {
        if (hasAudio) {
          return res.status(400).json({
            success: false,
            message: "Song/audio cannot be added to an uploaded video file.",
          });
        }

        uploadResult = await uploadBufferToCloudinary(
          videoFile.buffer,
          getShareVideoFileName(user, videoFile.originalname),
          {
            resource_type: "video",
            folder: process.env.CLOUDINARY_SHARE_VIDEO_FOLDER || "shared-videos",
          },
        );
        videoUrl = uploadResult.videoUrl;
      } else if (imageInput.source === "imageUrl" && imageUrl) {
        uploadResult = {
          imageUrl,
          publicId:
            typeof body.cloudinaryPublicId === "string"
              ? body.cloudinaryPublicId.trim()
              : undefined,
        };
      } else {
        try {
          uploadResult = await uploadBufferToCloudinary(
            imageInput.buffer,
            getShareImageFileName(user, imageInput.originalName),
            {
              folder: process.env.CLOUDINARY_SHARE_FOLDER || "shared-images",
            }
          );
        } catch (error) {
          return res.status(502).json({
            success: false,
            message: "Failed to upload image to Cloudinary.",
            error: getErrorMessage(error),
          });
        }
        imageUrl = uploadResult.imageUrl;
      }

      if (hasAudio) {
        try {
          let audioBuffer;
          let audioFileName;
          if (hasAudioFile) {
            audioBuffer = audioFile.buffer;
            audioFileName = audioFile.originalname;
          } else {
            const downloaded = await downloadAudioFromUrl(audioUrlField);
            audioBuffer = downloaded.buffer;
            audioFileName = downloaded.fileName;
          }

          const prepared = await prepareAudioBuffer(audioBuffer, audioFileName);
          const videoUpload = await uploadImageWithAudioVideo({
            imageBuffer: imageInput.buffer,
            audioBuffer: prepared.buffer,
            imageFileName: imageInput.originalName,
            audioFileName: prepared.fileName,
            folder: process.env.CLOUDINARY_SHARE_AUDIO_FOLDER || "shared-with-audio",
            publicFileName: `share-audio-${user.mobileNumber || user._id}-${Date.now()}.mp4`,
            audioAlreadyPrepared: true,
          });
          videoUrl = videoUpload.videoUrl;
        } catch (error) {
          return res.status(502).json({
            success: false,
            message: "Image uploaded, but attaching song failed.",
            imageUrl,
            cloudinaryPublicId: uploadResult.publicId,
            error: getErrorMessage(error),
          });
        }
      }

      let whatsappResult;
      let facebookResult;
      let instagramResult;
      let facebookStoryResult;
      let instagramStoryResult;

      if (sendWhatsApp) {
        try {
          if (videoUrl) {
            whatsappResult = await queueReadyReelForDownload({
              toMobile: user.mobileNumber,
              name: user.name,
              mobile: user.mobileNumber,
              reelResult: {
                videoUrl,
                message: whatsappMessage,
              },
              lastInboundAt: user.whatsappLastInboundAt,
              message: whatsappMessage,
            });
          } else {
            whatsappResult = await sendWhatsAppImageSmart({
              toMobile: user.mobileNumber,
              name: user.name,
              imageUrl,
              body: whatsappMessage,
              lastInboundAt: user.whatsappLastInboundAt,
            });
          }
        } catch (error) {
          return res.status(502).json({
            success: false,
            message: videoUrl
              ? "Video with song uploaded, but WhatsApp delivery failed."
              : "Image uploaded, but WhatsApp delivery failed.",
            imageUrl,
            videoUrl: videoUrl || undefined,
            cloudinaryPublicId: uploadResult.publicId,
            error: getErrorMessage(error),
          });
        }
      }

      if (uploadToFacebook) {
        try {
          const posted = videoUrl
            ? await postReelForUser({
                userId: String(user._id),
                videoUrl,
                caption,
                shareLink,
              })
            : await postPosterForUser({
                userId: String(user._id),
                imageUrl,
                caption,
                shareLink,
              });
          facebookResult = { success: true, ...posted };
        } catch (error) {
          const statusCode =
            error.statusCode === 404 || error.statusCode === 400
              ? error.statusCode
              : 502;
          facebookResult = {
            success: false,
            message: getErrorMessage(error),
          };
          if (sendWhatsApp && whatsappResult) {
            return res.status(statusCode).json({
              success: false,
              message: videoUrl
                ? "Video sent on WhatsApp, but Facebook upload failed."
                : "Image sent on WhatsApp, but Facebook upload failed.",
              imageUrl,
              videoUrl: videoUrl || undefined,
              cloudinaryPublicId: uploadResult.publicId,
              whatsapp: whatsappResult,
              facebook: facebookResult,
            });
          }
          return res.status(statusCode).json({
            success: false,
            message: facebookResult.message || "Facebook upload failed.",
            imageUrl,
            videoUrl: videoUrl || undefined,
            cloudinaryPublicId: uploadResult.publicId,
            facebook: facebookResult,
          });
        }
      }

      if (uploadToInstagram) {
        try {
          const posted = videoUrl
            ? await postReelToInstagramForUser({
                userId: String(user._id),
                videoUrl,
                caption: instagramCaption,
                shareLink,
              })
            : await postPosterToInstagramForUser({
                userId: String(user._id),
                imageUrl,
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

      if (uploadToFacebookStory && imageUrl) {
        try {
          const posted = await postPosterStoryForUser({
            userId: String(user._id),
            imageUrl,
          });
          facebookStoryResult = { success: true, ...posted };
        } catch (error) {
          facebookStoryResult = {
            success: false,
            message: getErrorMessage(error),
          };
        }
      } else if (uploadToFacebookStory && !imageUrl) {
        facebookStoryResult = {
          success: false,
          message: "Facebook Story requires an image (not video-only upload).",
        };
      }

      if (uploadToInstagramStory && imageUrl) {
        try {
          const posted = await postPosterStoryToInstagramForUser({
            userId: String(user._id),
            imageUrl,
          });
          instagramStoryResult = { success: true, ...posted };
        } catch (error) {
          instagramStoryResult = {
            success: false,
            message: getErrorMessage(error),
          };
        }
      } else if (uploadToInstagramStory && !imageUrl) {
        instagramStoryResult = {
          success: false,
          message: "Instagram Story requires an image (not video-only upload).",
        };
      }

      let message = "Image uploaded successfully.";
      if (videoUrl) {
        if (sendWhatsApp && uploadToFacebook && facebookResult?.success) {
          message = "Image with song sent on WhatsApp and posted to Facebook.";
        } else if (sendWhatsApp) {
          message =
            whatsappResult?.mode === "direct"
              ? "Video with song sent on WhatsApp (24-hour window was open)."
              : "WhatsApp template sent, then video with song delivered.";
        } else if (facebookResult?.success) {
          message = "Image with song posted to Facebook as a video.";
        } else {
          message = "Image with song uploaded successfully.";
        }
      } else if (sendWhatsApp && uploadToFacebook && facebookResult?.success) {
        message = "Image sent on WhatsApp and posted to Facebook.";
      } else if (sendWhatsApp) {
        message =
          whatsappResult?.mode === "direct"
            ? "Image sent on WhatsApp (24-hour window was open)."
            : "WhatsApp template sent, then image delivered to the user.";
      } else if (facebookResult?.success) {
        message = "Image uploaded and posted to Facebook.";
      }

      if (instagramResult?.success) {
        message = `${message.replace(/\.$/, "")} and posted to Instagram.`;
      }
      if (facebookStoryResult?.success) {
        message = `${message.replace(/\.$/, "")} and posted to Facebook Story.`;
      }
      if (instagramStoryResult?.success) {
        message = `${message.replace(/\.$/, "")} and posted to Instagram Story.`;
      }

      return res.status(200).json({
        success: true,
        message,
        userId: String(user._id),
        name: user.name,
        mobile: user.mobileNumber,
        imageUrl,
        videoUrl: videoUrl || undefined,
        hasAudio: Boolean(videoUrl),
        cloudinaryPublicId: uploadResult.publicId,
        sendWhatsApp,
        uploadToFacebook,
        uploadToInstagram,
        uploadToFacebookStory,
        uploadToInstagramStory,
        whatsapp: whatsappResult,
        facebook: facebookResult,
        instagram: instagramResult,
        facebookStory: facebookStoryResult,
        instagramStory: instagramStoryResult,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to share image.",
        error: getErrorMessage(error),
      });
    }
  }
);

module.exports = {
  router,
};
