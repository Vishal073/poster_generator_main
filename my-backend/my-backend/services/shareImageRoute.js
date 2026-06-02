const express = require("express");
const multer = require("multer");
const User = require("../models/User");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const { uploadBufferToCloudinary } = require("./cloudnaryService");
const { sendWhatsAppImageSmart } = require("./whatsappTemplateService");
const { postPosterForUser } = require("./facebookPostService");
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

  if (req.file?.buffer) {
    return {
      buffer: req.file.buffer,
      originalName: req.file.originalname,
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
 * multipart: image (file) OR field imageUrl (Cloudinary URL from generate-ai)
 * fields: sendWhatsApp, uploadToFacebook, caption, whatsappMessage
 */
router.post(
  "/users/:id/share-image",
  requireAuth,
  requireDb,
  imageUpload.single("image"),
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

      let imageInput;
      try {
        imageInput = await resolveShareImageBuffer(req);
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: getErrorMessage(error),
        });
      }

      if (!imageInput) {
        return res.status(400).json({
          success: false,
          message: "Provide an image file (field: image) or imageUrl from AI generation.",
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
      const caption =
        typeof body.caption === "string" ? body.caption.trim() : "";
      const whatsappMessage =
        typeof body.whatsappMessage === "string" && body.whatsappMessage.trim()
          ? body.whatsappMessage.trim()
          : "Here is your image";

      if (!sendWhatsApp && !uploadToFacebook) {
        return res.status(400).json({
          success: false,
          message: "Enable at least one of sendWhatsApp or uploadToFacebook.",
        });
      }

      let imageUrl = imageInput.imageUrl;
      let uploadResult;

      if (imageInput.source === "imageUrl" && imageUrl) {
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
      let whatsappResult;
      let facebookResult;

      if (sendWhatsApp) {
        try {
          whatsappResult = await sendWhatsAppImageSmart({
            toMobile: user.mobileNumber,
            name: user.name,
            imageUrl,
            body: whatsappMessage,
            lastInboundAt: user.whatsappLastInboundAt,
          });
        } catch (error) {
          return res.status(502).json({
            success: false,
            message: "Image uploaded, but WhatsApp delivery failed.",
            imageUrl,
            cloudinaryPublicId: uploadResult.publicId,
            error: getErrorMessage(error),
          });
        }
      }

      if (uploadToFacebook) {
        try {
          const posted = await postPosterForUser({
            userId: String(user._id),
            imageUrl,
            caption,
          });
          facebookResult = { success: true, ...posted };
        } catch (error) {
          const statusCode = error.statusCode === 404 || error.statusCode === 400 ? error.statusCode : 502;
          facebookResult = {
            success: false,
            message: getErrorMessage(error),
          };
          if (sendWhatsApp && whatsappResult) {
            return res.status(statusCode).json({
              success: false,
              message: "Image sent on WhatsApp, but Facebook upload failed.",
              imageUrl,
              cloudinaryPublicId: uploadResult.publicId,
              whatsapp: whatsappResult,
              facebook: facebookResult,
            });
          }
          return res.status(statusCode).json({
            success: false,
            message: facebookResult.message || "Facebook upload failed.",
            imageUrl,
            cloudinaryPublicId: uploadResult.publicId,
            facebook: facebookResult,
          });
        }
      }

      let message = "Image uploaded successfully.";
      if (sendWhatsApp && uploadToFacebook && facebookResult?.success) {
        message = "Image sent on WhatsApp and posted to Facebook.";
      } else if (sendWhatsApp) {
        message =
          whatsappResult?.mode === "direct"
            ? "Image sent on WhatsApp (24-hour window was open)."
            : "WhatsApp template sent, then image delivered to the user.";
      } else if (facebookResult?.success) {
        message = "Image uploaded and posted to Facebook.";
      }

      return res.status(200).json({
        success: true,
        message,
        userId: String(user._id),
        name: user.name,
        mobile: user.mobileNumber,
        imageUrl,
        cloudinaryPublicId: uploadResult.publicId,
        sendWhatsApp,
        uploadToFacebook,
        whatsapp: whatsappResult,
        facebook: facebookResult,
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
