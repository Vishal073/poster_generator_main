const express = require("express");
const multer = require("multer");
const { generatePosterImage } = require("../utils/posterGenerator");
const {
  uploadPosterToCloudinary,
  uploadBufferToCloudinary,
  isAllowedBasePosterSource,
  listBasePostersFromCloudinary,
  getBasePosterFolder,
} = require("./cloudnaryService");
const { requireAuth } = require("../middleware/requireAuth");
const { sendPosterWhatsApp } = require("./whatsappService");
// const { sendPosterEmail } = require("./emailService"); // Gmail sending is disabled.

const router = express.Router();

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

function getPosterFileName({ mobileValue, email, fallbackName }) {
  const normalizedIdentifier = mobileValue
    ? String(mobileValue).replace(/\D/g, "")
    : typeof email === "string" && email.trim()
      ? email.trim()
      : String(fallbackName || `poster-${Date.now()}`)
          .trim()
          .replace(/\.png$/i, "");

  return `${normalizedIdentifier || `poster-${Date.now()}`}.png`;
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
      imagePosition = "left",
      insetFromBottom,
      insetLeft,
      insetRight,
      imageGap = 16,
      imageMaxSize = 120,
      lineGap = 0,
      paragraphGap = 8,
      fontSize = 40,
      fontColor = "#2a2a2a",
      fontFamily = "Helvetica Neue",
      textOpacity = 0.9,
      textBlendMode = "multiply",
      posterSource,
      language = "en",
    } = body;

    const resolvedPosterSource =
      typeof posterSource === "string" ? posterSource.trim() : "";

    if (!resolvedPosterSource) {
      return res.status(400).json({
        success: false,
        message: "posterSource is required. Fetch available posters from GET /base-posters.",
        folder: getBasePosterFolder(),
      });
    }

    if (!isAllowedBasePosterSource(resolvedPosterSource)) {
      return res.status(400).json({
        success: false,
        message: `posterSource must be an image from Cloudinary folder "${getBasePosterFolder()}".`,
        folder: getBasePosterFolder(),
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

    let posterResult;
    try {
      posterResult = await generatePosterImage({
        name,
        textLines,
        textLineStyles,
        x,
        y,
        userImageSource,
        imageX,
        imageY,
        imageWidth,
        imageHeight,
        imageShape,
        imagePosition,
        insetFromBottom,
        insetLeft,
        insetRight,
        imageGap,
        imageMaxSize,
        lineGap,
        paragraphGap,
        fontSize,
        fontColor,
        fontFamily,
        textOpacity,
        textBlendMode,
        posterSource: resolvedPosterSource,
        language,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate poster image.",
        error: getErrorMessage(error),
      });
    }

    const imageName = getPosterFileName({
      mobileValue,
      email,
      fallbackName: posterResult.fileName,
    });
    let uploadResult;
    try {
      uploadResult = await uploadPosterToCloudinary(posterResult.buffer, imageName);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Poster generated, but Cloudinary upload failed.",
        imageName,
        error: getErrorMessage(error),
      });
    }

    let whatsappResult;
    if (shouldSendWhatsApp) {
      try {
        whatsappResult = await sendPosterWhatsApp({
          toMobile: mobileValue,
          imageUrl: uploadResult.imageUrl,
          body: "Here is your image",
        });
      } catch (error) {
        return res.status(502).json({
          success: false,
          message: "Poster generated and uploaded, but WhatsApp delivery failed.",
          imageName,
          imageUrl: uploadResult.imageUrl,
          cloudinaryPublicId: uploadResult.publicId,
          error: getErrorMessage(error),
        });
      }
    }

    // Gmail send disabled. To re-enable, call sendPosterEmail(...) here.
    // const emailResult = await sendPosterEmail({ toEmail: email, posterBuffer: posterResult.buffer, fileName: imageName });

    return res.status(200).json({
      success: true,
      message: shouldSendWhatsApp
        ? "Poster generated, uploaded, and sent to WhatsApp."
        : "Poster generated and uploaded to Cloudinary.",
      username: typeof username === "string" && username.trim() ? username.trim() : name,
      email,
      mobile: hasMobile ? String(mobileValue).trim() : undefined,
      sendWhatsApp: shouldSendWhatsApp,
      imageName,
      fileName: imageName,
      imageUrl: uploadResult.imageUrl,
      cloudinaryPublicId: uploadResult.publicId,
      whatsapp: whatsappResult,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to generate poster.",
      error: getErrorMessage(error),
    });
  }
}

router.post("/generate-poster", generatePoster);

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

module.exports = {
  router,
  generatePoster,
};
