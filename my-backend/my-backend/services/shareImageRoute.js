const express = require("express");
const multer = require("multer");
const User = require("../models/User");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const { uploadBufferToCloudinary } = require("./cloudnaryService");
const { sendWhatsAppTemplateThenImage } = require("./whatsappTemplateService");
const { postPosterForUser } = require("./facebookPostService");

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

/**
 * POST /users/:id/share-image
 * multipart: image (file)
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

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required (field name: image).",
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

      let uploadResult;
      try {
        uploadResult = await uploadBufferToCloudinary(
          req.file.buffer,
          getShareImageFileName(user, req.file.originalname),
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

      const imageUrl = uploadResult.imageUrl;
      let whatsappResult;
      let facebookResult;

      if (sendWhatsApp) {
        try {
          whatsappResult = await sendWhatsAppTemplateThenImage({
            toMobile: user.mobileNumber,
            name: user.name,
            imageUrl,
            body: whatsappMessage,
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
          "WhatsApp template sent, then image delivered to the user.";
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
