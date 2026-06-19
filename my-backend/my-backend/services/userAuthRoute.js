const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const LoginToken = require("../models/LoginToken");
const User = require("../models/User");
const { requireAuth, JWT_SECRET } = require("../middleware/requireAuth");
const { requireUserAuth } = require("../middleware/requireUserAuth");
const { requireDb } = require("../middleware/requireDb");
const { getFacebookStatusByUserIds } = require("./facebookPostService");
const { sendWhatsAppText } = require("./whatsappService");
const { uploadBufferToCloudinary } = require("./cloudnaryService");
const {
  buildUserPayload,
  getUserImageFileName,
  validateFieldFormats,
  validateUserPayload,
} = require("../utils/userPayload");
const {
  createLoginLinkForUser,
  getValidRegistrationToken,
  markRegistrationTokenUsed,
} = require("../utils/portalAuth");

const router = express.Router();
const registerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const LOGIN_TOKEN_TTL_MS =
  Number(process.env.LOGIN_TOKEN_TTL_HOURS || 48) * 60 * 60 * 1000;
const USER_JWT_EXPIRY = process.env.USER_JWT_EXPIRES_IN || "30d";

function getPortalBaseUrl() {
  return (process.env.USER_FRONTEND_URL || process.env.FRONTEND_URL || "http://localhost:5173")
    .replace(/\/$/, "");
}

function buildPortalLoginUrl(token) {
  return `${getPortalBaseUrl()}/portal/login?token=${encodeURIComponent(token)}`;
}

function createLoginTokenValue() {
  return crypto.randomBytes(32).toString("hex");
}

function signUserToken(user) {
  return jwt.sign(
    {
      role: "user",
      userId: String(user._id),
      mobileNumber: user.mobileNumber,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: USER_JWT_EXPIRY },
  );
}

/**
 * POST /auth/user/login-link
 * Admin generates a passwordless link to share on WhatsApp.
 */
router.post("/auth/user/login-link", requireAuth, requireDb, async (req, res) => {
  try {
    const body =
      req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const sendWhatsApp = Boolean(body.sendWhatsApp);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required.",
      });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const token = createLoginTokenValue();
    const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS);

    await LoginToken.create({
      token,
      userId: user._id,
      expiresAt,
    });

    const loginUrl = buildPortalLoginUrl(token);
    let whatsappResult = null;

    if (sendWhatsApp) {
      const message =
        `Hi ${user.name},\n\n` +
        `Open your poster account (no password needed):\n${loginUrl}\n\n` +
        `To connect Facebook: open this link in Chrome or Safari first (in WhatsApp, tap ⋮ → Open in browser), then tap Connect Facebook so your phone can use the Facebook app or saved login.`;

      whatsappResult = await sendWhatsAppText({
        toMobile: user.mobileNumber,
        body: message,
      });
    }

    return res.status(200).json({
      success: true,
      message: sendWhatsApp
        ? "Login link sent on WhatsApp."
        : "Login link created.",
      userId: String(user._id),
      loginUrl,
      expiresAt: expiresAt.toISOString(),
      whatsapp: whatsappResult,
    });
  } catch (error) {
    console.error("[userAuth] login-link failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create login link.",
    });
  }
});

/**
 * POST /auth/user/verify-token
 * End user opens WhatsApp link — exchange token for session JWT.
 */
router.post("/auth/user/verify-token", requireDb, async (req, res) => {
  try {
    const body =
      req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    const token = typeof body.token === "string" ? body.token.trim() : "";

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "token is required.",
      });
    }

    const loginDoc = await LoginToken.findOne({ token });
    if (!loginDoc) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired login link.",
      });
    }

    if (loginDoc.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({
        success: false,
        message: "Login link has expired. Ask admin for a new link.",
      });
    }

    const user = await User.findById(loginDoc.userId).lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const accessToken = signUserToken(user);
    const facebookByUser = await getFacebookStatusByUserIds([user._id]);
    const facebook = facebookByUser.get(String(user._id)) || {
      facebookConnected: false,
      facebookPageSelected: false,
      facebookPageName: null,
      instagramConnected: false,
      instagramUsername: null,
    };

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      accessToken,
      tokenType: "Bearer",
      expiresIn: USER_JWT_EXPIRY,
      user: {
        _id: String(user._id),
        name: user.name,
        mobileNumber: user.mobileNumber,
        city: user.city,
        state: user.state,
        occupationType: user.occupationType,
        facebook,
      },
    });
  } catch (error) {
    console.error("[userAuth] verify-token failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Login failed.",
    });
  }
});

/**
 * GET /auth/user/register-token?token=
 * Validate WhatsApp registration link before showing the form.
 */
router.get("/auth/user/register-token", requireDb, async (req, res) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) {
      return res.status(400).json({
        success: false,
        message: "token is required.",
      });
    }

    const registrationDoc = await getValidRegistrationToken(token);
    if (!registrationDoc) {
      return res.status(401).json({
        success: false,
        message: "Registration link is invalid or expired.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Registration link is valid.",
      mobileNumber: registrationDoc.mobileNumber,
      expiresAt: registrationDoc.expiresAt.toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to validate registration link.",
    });
  }
});

/**
 * POST /auth/user/register
 * Public self-registration using a WhatsApp registration link token.
 */
router.post(
  "/auth/user/register",
  requireDb,
  registerUpload.single("userImage"),
  async (req, res) => {
    try {
      const body =
        req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};
      const registrationToken =
        typeof body.registrationToken === "string" ? body.registrationToken.trim() : "";

      if (!registrationToken) {
        return res.status(400).json({
          success: false,
          message: "registrationToken is required.",
        });
      }

      const registrationDoc = await getValidRegistrationToken(registrationToken);
      if (!registrationDoc) {
        return res.status(401).json({
          success: false,
          message: "Registration link is invalid or expired.",
        });
      }

      const payload = buildUserPayload(body);
      payload.mobileNumber = registrationDoc.mobileNumber;

      const missingFields = validateUserPayload(payload);
      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Required fields are missing.",
          missingFields,
        });
      }

      const formatErrors = validateFieldFormats(payload);
      if (formatErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: formatErrors[0].message,
          errors: formatErrors,
        });
      }

      if (payload.mobileNumber !== registrationDoc.mobileNumber) {
        return res.status(400).json({
          success: false,
          message: "Mobile number must match the WhatsApp number used for registration.",
        });
      }

      if (req.file) {
        const uploadResult = await uploadBufferToCloudinary(
          req.file.buffer,
          getUserImageFileName(payload, req.file.originalname),
          {
            folder: process.env.CLOUDINARY_USER_FOLDER || "user-images",
          },
        );
        payload.userImageUrl = uploadResult.imageUrl;
        payload.userImagePublicId = uploadResult.publicId;
      }

      const user = await User.create(payload);
      await markRegistrationTokenUsed(registrationToken);

      const { loginUrl, expiresAt } = await createLoginLinkForUser(user);

      return res.status(201).json({
        success: true,
        message: "Registration completed successfully.",
        loginUrl,
        expiresAt: expiresAt.toISOString(),
        data: {
          _id: String(user._id),
          name: user.name,
          mobileNumber: user.mobileNumber,
        },
      });
    } catch (error) {
      if (error && error.code === 11000 && error.keyPattern && error.keyPattern.mobileNumber) {
        return res.status(409).json({
          success: false,
          message: "Mobile number already exists.",
        });
      }

      return res.status(500).json({
        success: false,
        message: error.message || "Failed to register user.",
      });
    }
  },
);

/**
 * GET /auth/user/me
 * Logged-in end user profile + Facebook status.
 */
router.get("/auth/user/me", requireUserAuth, requireDb, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const facebookByUser = await getFacebookStatusByUserIds([user._id]);
    const facebook = facebookByUser.get(String(user._id)) || {
      facebookConnected: false,
      facebookPageSelected: false,
      facebookPageName: null,
      instagramConnected: false,
      instagramUsername: null,
    };

    return res.status(200).json({
      success: true,
      user: {
        _id: String(user._id),
        name: user.name,
        mobileNumber: user.mobileNumber,
        city: user.city,
        state: user.state,
        occupationType: user.occupationType,
        facebook,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load profile.",
    });
  }
});

module.exports = {
  router,
};
