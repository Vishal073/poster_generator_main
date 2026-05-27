const mongoose = require("mongoose");
const FacebookConnection = require("../models/FacebookConnection");
const FacebookOAuthState = require("../models/FacebookOAuthState");
const User = require("../models/User");
const {
  buildFacebookOAuthUrl,
  createOAuthState,
  createSessionId,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchFacebookUserId,
  fetchUserPages,
  postImageToPage,
} = require("../services/facebookService");
const {
  postPosterForUser,
  buildFacebookConnectUrl,
} = require("../services/facebookPostService");

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const CONNECTION_TTL_MS = 24 * 60 * 60 * 1000;

function getFrontendUrl() {
  // Admin portal URL — OAuth callback redirects here after Facebook login
  return (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
}

function getFacebookPagesPath(returnTo) {
  return returnTo === "portal" ? "/portal/facebook/pages" : "/facebook/pages";
}

function resolveReturnTo(value) {
  return value === "portal" ? "portal" : "admin";
}

function isValidObjectId(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    return false;
  }

  return String(new mongoose.Types.ObjectId(value)) === value;
}

/**
 * Resolve MongoDB User _id from query/body. Required to link Facebook tokens to your app user.
 */
async function resolveAppUserId(rawUserId) {
  const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";

  if (!userId) {
    const error = new Error("userId is required. Pass your app's User _id from the admin portal.");
    error.statusCode = 400;
    throw error;
  }

  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id (24 character hex string).");
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId).select("_id name mobileNumber").lean();
  if (!user) {
    const error = new Error("No user found for this userId.");
    error.statusCode = 404;
    throw error;
  }

  return user;
}

function sendError(res, error, fallbackMessage) {
  const statusCode = error?.statusCode || 500;
  const message = error?.message || fallbackMessage;

  return res.status(statusCode).json({
    success: false,
    message,
    details: error?.details || undefined,
  });
}

/**
 * GET /auth/facebook
 * Starts OAuth by redirecting the browser to Facebook's consent screen.
 */
async function startFacebookAuth(req, res) {
  try {
    const user = await resolveAppUserId(req.query.userId);
    const returnTo = resolveReturnTo(req.query.returnTo);

    // Generate CSRF state and persist it briefly before redirecting
    const state = createOAuthState();
    await FacebookOAuthState.create({
      state,
      userId: user._id,
      returnTo,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });

    const userAgent = String(req.headers["user-agent"] || "");
    const mobileQuery = String(req.query.mobile || "").trim() === "1";
    const isMobile =
      mobileQuery ||
      /Android|iPhone|iPad|iPod|Mobile|WhatsApp/i.test(userAgent);

    const oauthUrl = buildFacebookOAuthUrl(state, { mobile: isMobile });
    return res.redirect(oauthUrl);
  } catch (error) {
    console.error("[Facebook OAuth] startFacebookAuth failed:", error.message);
    return sendError(res, error, "Unable to start Facebook authentication.");
  }
}

/**
 * GET /auth/facebook/callback
 * Handles Facebook redirect, exchanges tokens, loads Pages, then sends user to frontend.
 */
async function handleFacebookCallback(req, res) {
  const frontendUrl = getFrontendUrl();
  let pagesPath = "/facebook/pages";

  try {
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";
    const oauthErrorDescription =
      typeof req.query.error_description === "string"
        ? req.query.error_description
        : "";

    if (oauthError) {
      const message = encodeURIComponent(oauthErrorDescription || oauthError);
      return res.redirect(`${frontendUrl}${pagesPath}?error=${message}`);
    }

    const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
    const state = typeof req.query.state === "string" ? req.query.state.trim() : "";

    if (!code || !state) {
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent("Missing OAuth code or state.")}`,
      );
    }

    // Validate CSRF state (one-time use)
    const oauthStateDoc = await FacebookOAuthState.findOneAndDelete({ state });
    if (!oauthStateDoc) {
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent("Invalid or expired OAuth state.")}`,
      );
    }

    pagesPath = getFacebookPagesPath(oauthStateDoc.returnTo);

    if (!oauthStateDoc.userId) {
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent("OAuth session missing userId. Start Connect Facebook from a user profile with userId in the URL.")}`,
      );
    }

    const appUserId = String(oauthStateDoc.userId);

    // Exchange authorization code -> short-lived token -> long-lived token
    const shortLived = await exchangeCodeForShortLivedToken(code);
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);

    const facebookUser = await fetchFacebookUserId(longLived.accessToken);
    const pages = await fetchUserPages(longLived.accessToken);

    if (!pages.length) {
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent("No Facebook Pages found for this account.")}`,
      );
    }

    const sessionId = createSessionId();

    // If user has only one Page, auto-select it (no extra click on /facebook/pages)
    const autoSelectedPage = pages.length === 1 ? pages[0] : null;
    const connectionExpiresAt = autoSelectedPage
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + CONNECTION_TTL_MS);

    // One Facebook connection per app user — reconnecting updates the same document
    await FacebookConnection.findOneAndUpdate(
      { userId: oauthStateDoc.userId },
      {
        sessionId,
        userId: oauthStateDoc.userId,
        facebookUserId: facebookUser.id,
        userAccessToken: longLived.accessToken,
        pages,
        selectedPage: autoSelectedPage
          ? {
              pageId: autoSelectedPage.pageId,
              pageName: autoSelectedPage.pageName,
              pageAccessToken: autoSelectedPage.pageAccessToken,
            }
          : null,
        expiresAt: connectionExpiresAt,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const returnToQuery =
      oauthStateDoc.returnTo === "portal" ? "&returnTo=portal" : "";

    return res.redirect(
      `${frontendUrl}${pagesPath}?sessionId=${sessionId}&userId=${appUserId}${returnToQuery}`,
    );
  } catch (error) {
    console.error("[Facebook OAuth] handleFacebookCallback failed:", error.message);
    const message = encodeURIComponent(error.message || "Facebook authentication failed.");
    return res.redirect(`${frontendUrl}${pagesPath}?error=${message}`);
  }
}

/**
 * GET /facebook/pages
 * Returns Pages fetched during OAuth for a given session.
 */
async function getFacebookPages(req, res) {
  try {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "sessionId query parameter is required.",
      });
    }

    const connection = await FacebookConnection.findOne({ sessionId }).lean();
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Facebook session not found or expired.",
      });
    }

    return res.status(200).json({
      success: true,
      sessionId: connection.sessionId,
      userId: connection.userId,
      facebookUserId: connection.facebookUserId,
      pages: connection.pages.map((page) => ({
        pageId: page.pageId,
        pageName: page.pageName,
        pageAccessToken: page.pageAccessToken,
      })),
      selectedPage: connection.selectedPage || null,
    });
  } catch (error) {
    console.error("[Facebook OAuth] getFacebookPages failed:", error.message);
    return sendError(res, error, "Unable to load Facebook Pages.");
  }
}

/**
 * POST /facebook/save-page
 * Persists the Page the user selected for auto-posting.
 */
async function saveSelectedPage(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const userIdParam = typeof body.userId === "string" ? body.userId.trim() : "";
    const pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";

    if (!pageId) {
      return res.status(400).json({
        success: false,
        message: "pageId is required.",
      });
    }

    if (!sessionId && !userIdParam) {
      return res.status(400).json({
        success: false,
        message: "sessionId or userId is required.",
      });
    }

    let connection = null;
    if (sessionId) {
      connection = await FacebookConnection.findOne({ sessionId });
    }
    if (!connection && userIdParam) {
      if (!isValidObjectId(userIdParam)) {
        return res.status(400).json({
          success: false,
          message: "userId must be a valid MongoDB User _id.",
        });
      }
      connection = await FacebookConnection.findOne({ userId: userIdParam });
    }

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Facebook session not found or expired.",
      });
    }

    const selectedPage = connection.pages.find((page) => page.pageId === pageId);
    if (!selectedPage) {
      return res.status(404).json({
        success: false,
        message: "Selected page was not found in this Facebook session.",
      });
    }

    connection.selectedPage = {
      pageId: selectedPage.pageId,
      pageName: selectedPage.pageName,
      pageAccessToken: selectedPage.pageAccessToken,
    };

    // Keep saved connections longer once a Page is chosen
    connection.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await connection.save();

    return res.status(200).json({
      success: true,
      message: "Facebook Page saved successfully.",
      userId: connection.userId,
      selectedPage: {
        pageId: connection.selectedPage.pageId,
        pageName: connection.selectedPage.pageName,
      },
    });
  } catch (error) {
    console.error("[Facebook OAuth] saveSelectedPage failed:", error.message);
    return sendError(res, error, "Unable to save selected Facebook Page.");
  }
}

/**
 * GET /facebook/connection/:userId
 * Look up saved Facebook connection for an app user (admin portal).
 */
async function getFacebookConnectionByUser(req, res) {
  try {
    const user = await resolveAppUserId(req.params.userId);

    const connection = await FacebookConnection.findOne({ userId: user._id }).lean();
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "No Facebook connection found for this user.",
        userId: user._id,
      });
    }

    return res.status(200).json({
      success: true,
      userId: connection.userId,
      userName: user.name,
      mobileNumber: user.mobileNumber,
      sessionId: connection.sessionId,
      facebookUserId: connection.facebookUserId,
      pagesCount: connection.pages?.length || 0,
      selectedPage: connection.selectedPage
        ? {
            pageId: connection.selectedPage.pageId,
            pageName: connection.selectedPage.pageName,
          }
        : null,
      connectedAt: connection.updatedAt,
      expiresAt: connection.expiresAt,
    });
  } catch (error) {
    console.error("[Facebook OAuth] getFacebookConnectionByUser failed:", error.message);
    return sendError(res, error, "Unable to load Facebook connection for user.");
  }
}

/**
 * GET /facebook/connect-url/:userId
 * Returns OAuth start URL for admin portal "Connect Facebook" button per user row.
 */
async function getFacebookConnectUrl(req, res) {
  try {
    const user = await resolveAppUserId(req.params.userId);
    const apiBase =
      typeof req.query.apiBase === "string" && req.query.apiBase.trim()
        ? req.query.apiBase.trim()
        : undefined;

    return res.status(200).json({
      success: true,
      userId: user._id,
      connectUrl: buildFacebookConnectUrl(String(user._id), apiBase),
    });
  } catch (error) {
    console.error("[Facebook OAuth] getFacebookConnectUrl failed:", error.message);
    return sendError(res, error, "Unable to build Facebook connect URL.");
  }
}

/**
 * POST /facebook/post-for-user
 * One-click post: uses saved Page token for this app user (no manual tokens in body).
 */
async function postFacebookForUser(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim() : "";

    await resolveAppUserId(userId);

    const result = await postPosterForUser({ userId, imageUrl, caption });

    return res.status(200).json({
      success: true,
      message: "Poster uploaded to Facebook successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] postFacebookForUser failed:", error.message);
    return sendError(res, error, "Unable to post poster to Facebook for this user.");
  }
}

/**
 * POST /facebook/post-image
 * Low-level endpoint with explicit pageId + pageAccessToken (testing).
 */
async function postFacebookImage(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
    const pageAccessToken =
      typeof body.pageAccessToken === "string" ? body.pageAccessToken.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim() : "";

    if (!pageId || !pageAccessToken || !imageUrl) {
      return res.status(400).json({
        success: false,
        message: "pageId, pageAccessToken, and imageUrl are required.",
      });
    }

    const result = await postImageToPage({
      pageId,
      pageAccessToken,
      imageUrl,
      caption,
    });

    return res.status(200).json({
      success: true,
      message: "Image posted to Facebook Page successfully.",
      postId: result.postId,
      data: result.raw,
    });
  } catch (error) {
    console.error("[Facebook OAuth] postFacebookImage failed:", error.message);
    return sendError(res, error, "Unable to post image to Facebook Page.");
  }
}

module.exports = {
  startFacebookAuth,
  handleFacebookCallback,
  getFacebookPages,
  saveSelectedPage,
  getFacebookConnectionByUser,
  getFacebookConnectUrl,
  postFacebookForUser,
  postFacebookImage,
};
