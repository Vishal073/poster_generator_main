const express = require("express");
const multer = require("multer");
const { generatePosterImage } = require("../utils/posterGenerator");
const { enhancePosterBuffer, normalizeEnhancePriority } = require("../utils/posterEnhancementService");
const {
  uploadPosterToCloudinary,
  uploadBufferToCloudinary,
  isAllowedBasePosterSource,
  listBasePostersFromCloudinary,
  getBasePosterFolder,
} = require("./cloudnaryService");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const User = require("../models/User");
const { sendPosterWhatsApp } = require("./whatsappService");
// const { sendPosterEmail } = require("./emailService"); // Gmail sending is disabled.

const router = express.Router();

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
  insetFromBottom: 150,
  insetLeft: 40,
  insetRight: 40,
  imagePosition: "left",
  imageWidth: 300,
  imageHeight: 300,
  imageShape: "circle",
  imageGap: 16,
  imageMaxSize: 350,
  lineGap: 0,
  paragraphGap: 8,
  fontSize: 40,
  fontColor: "#2a2a2a",
  fontFamily: "Helvetica Neue",
  textOpacity: 0.9,
  textBlendMode: "multiply",
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

async function resolveUserEnhancePriority({ userId, mobileNumber }) {
  let user = null;

  if (userId && isValidObjectId(userId)) {
    user = await User.findById(userId).select("enhancePriority").lean();
  }

  if (!user && mobileNumber) {
    const normalizedMobile = String(mobileNumber).replace(/\D/g, "");
    if (normalizedMobile) {
      user = await User.findOne({ mobileNumber: normalizedMobile })
        .select("enhancePriority")
        .lean();
    }
  }

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
      userId,
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

    const resolvedEnhancePriority = await resolveUserEnhancePriority({
      userId: body.userId || userId,
      mobileNumber: mobileValue,
    });

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

    const enhancement = await applyPosterEnhancement(
      posterResult.buffer,
      resolvedEnhancePriority
    );

    const imageName = getPosterFileName({
      mobileValue,
      email,
      fallbackName: posterResult.fileName,
    });
    let uploadResult;
    try {
      uploadResult = await uploadPosterToCloudinary(enhancement.buffer, imageName);
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
      enhancePriority: enhancement.enhancePriority,
      enhanceApplied: enhancement.enhanceApplied,
      enhanceFallback: enhancement.enhanceFallback,
      enhanceError: enhancement.enhanceError || undefined,
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

function isValidObjectId(value) {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
}

function buildTextLinesFromUser(user) {
  const lines = [];

  if (user.name) {
    lines.push(String(user.name).trim());
  }

  let secondLine = "";
  if (user.occupationType === "Politician") {
    secondLine = user.post || user.party || "";
  } else {
    secondLine = user.address || user.city || "";
  }
  if (secondLine) {
    lines.push(String(secondLine).trim());
  }

  if (user.mobileNumber) {
    lines.push(String(user.mobileNumber).trim());
  }

  return lines.filter(Boolean);
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
  async (req, res) => {
    try {
      const body =
        req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};

      const userIds = Array.isArray(body.userIds) ? body.userIds : [];
      const posterSource =
        typeof body.posterSource === "string" ? body.posterSource.trim() : "";
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
        imagePosition: pickString(body.imagePosition, ["left", "right", "top"]),
        imageWidth: pickNumber(body.imageWidth),
        imageHeight: pickNumber(body.imageHeight),
        imageShape: pickString(body.imageShape, ["circle", "rectangle"]),
        imageGap: pickNumber(body.imageGap),
        imageMaxSize: pickNumber(body.imageMaxSize),
        lineGap: pickNumber(body.lineGap),
        paragraphGap: pickNumber(body.paragraphGap),
        fontSize: pickNumber(body.fontSize),
        fontColor: pickString(body.fontColor),
        fontFamily: pickString(body.fontFamily),
        textOpacity: pickNumber(body.textOpacity),
        textBlendMode: pickString(body.textBlendMode, ["multiply", "overlay"]),
      };

      const resolvedLayout = { ...BULK_DEFAULT_LAYOUT };
      for (const [key, value] of Object.entries(layoutOverrides)) {
        if (value !== undefined) {
          resolvedLayout[key] = value;
        }
      }

      if (!posterSource) {
        return res.status(400).json({
          success: false,
          message: "posterSource is required.",
        });
      }

      if (!isAllowedBasePosterSource(posterSource)) {
        return res.status(400).json({
          success: false,
          message: `posterSource must be an image from Cloudinary folder "${getBasePosterFolder()}".`,
          folder: getBasePosterFolder(),
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
          const posterResult = await generatePosterImage({
            name: "",
            textLines,
            textLineStyles: BULK_DEFAULT_TEXT_STYLES.map((style) => ({ ...style })),
            userImageSource: user.userImageUrl || undefined,
            posterSource,
            language,
            ...resolvedLayout,
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

          results.push({
            userId,
            name: user.name,
            mobile: user.mobileNumber,
            status: "success",
            imageUrl: uploadResult.imageUrl,
            cloudinaryPublicId: uploadResult.publicId,
            imageName,
            enhancePriority: enhancement.enhancePriority,
            enhanceApplied: enhancement.enhanceApplied,
            enhanceFallback: enhancement.enhanceFallback,
            enhanceError: enhancement.enhanceError || undefined,
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

      return res.status(200).json({
        success: true,
        message:
          errorCount === 0
            ? `Generated ${successCount} poster${successCount === 1 ? "" : "s"}.`
            : `Generated ${successCount} of ${results.length} posters (${errorCount} failed).`,
        posterSource,
        language,
        layout: resolvedLayout,
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
