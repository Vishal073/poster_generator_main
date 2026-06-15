const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const LoginToken = require("../models/LoginToken");
const User = require("../models/User");
const { requireAuth, JWT_SECRET } = require("../middleware/requireAuth");
const { requireUserAuth } = require("../middleware/requireUserAuth");
const { requireDb } = require("../middleware/requireDb");
const { getFacebookStatusByUserIds } = require("./facebookPostService");
const { sendWhatsAppText } = require("./whatsappService");

const router = express.Router();

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
