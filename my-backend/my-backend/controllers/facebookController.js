const mongoose = require("mongoose");
const FacebookConnection = require("../models/FacebookConnection");
const FacebookOAuthState = require("../models/FacebookOAuthState");
const User = require("../models/User");
const {
  buildFacebookOAuthUrl,
  getFacebookConfig,
  FACEBOOK_SCOPES,
  createOAuthState,
  createSessionId,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchFacebookUserId,
  fetchUserPages,
  enrichPagesWithInstagram,
  fetchInstagramAccountForPage,
  postImageToPage,
} = require("../services/facebookService");
const {
  postPosterForUser,
  postPosterToInstagramForUser,
  buildSelectedPageSnapshot,
  listPostsForUser,
  deletePostForUser,
  getFacebookStatusByUserIds,
  buildFacebookConnectUrl,
} = require("../services/facebookPostService");

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const CONNECTION_TTL_MS = 24 * 60 * 60 * 1000;

function getFrontendUrl(returnTo = "admin") {
  const portalUrl =
    typeof process.env.USER_FRONTEND_URL === "string"
      ? process.env.USER_FRONTEND_URL.trim()
      : "";
  const adminUrl = (process.env.FRONTEND_URL || "http://localhost:5173").trim();
  const base = returnTo === "portal" && portalUrl ? portalUrl : adminUrl;
  return base.replace(/\/$/, "");
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

    const reconnect = String(req.query.reconnect || "").trim() === "1";
    const oauthUrl = buildFacebookOAuthUrl(state, { mobile: isMobile, reconnect });
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
    const frontendUrl = getFrontendUrl(oauthStateDoc.returnTo);

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
    const rawPages = await fetchUserPages(longLived.accessToken);
    const pages = await enrichPagesWithInstagram(rawPages, longLived.accessToken);

    if (!pages.length) {
      const userIdQuery = appUserId ? `&userId=${appUserId}` : "";
      const returnToQuery =
        oauthStateDoc.returnTo === "portal" ? "&returnTo=portal" : "";
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent(
          "No Facebook Pages found. Log in with a Facebook account that manages a Page (Admin/Editor), then try again.",
        )}${userIdQuery}${returnToQuery}`,
      );
    }

    const sessionId = createSessionId();

    // If user has only one Page, auto-select it (no extra click on /facebook/pages)
    let autoSelectedPage = pages.length === 1 ? pages[0] : null;
    if (autoSelectedPage) {
      const freshInstagram = await fetchInstagramAccountForPage({
        pageId: autoSelectedPage.pageId,
        pageAccessToken: autoSelectedPage.pageAccessToken,
        userAccessToken: longLived.accessToken,
      });
      autoSelectedPage = {
        ...autoSelectedPage,
        instagramAccount: freshInstagram,
      };
      if (pages.length === 1) {
        pages[0] = autoSelectedPage;
      }
    }
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
        selectedPage: autoSelectedPage ? buildSelectedPageSnapshot(autoSelectedPage) : null,
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

async function syncConnectionPagesFromFacebook(connection) {
  if (!connection.userAccessToken) {
    const error = new Error(
      "Facebook access expired. Tap Connect Facebook again to sign in.",
    );
    error.statusCode = 401;
    throw error;
  }

  const rawPages = await fetchUserPages(connection.userAccessToken);
  const pages = await enrichPagesWithInstagram(rawPages, connection.userAccessToken);
  connection.pages = pages;

  if (connection.selectedPage?.pageId) {
    const refreshedSelected = pages.find(
      (page) => page.pageId === connection.selectedPage.pageId,
    );
    if (refreshedSelected) {
      connection.selectedPage = buildSelectedPageSnapshot(refreshedSelected);
    }
  }

  await connection.save();
  return pages;
}

function formatPageForApi(page) {
  if (!page) {
    return null;
  }

  return {
    pageId: page.pageId,
    pageName: page.pageName,
    pageAccessToken: page.pageAccessToken,
    instagramAccount: page.instagramAccount?.igUserId
      ? {
          igUserId: page.instagramAccount.igUserId,
          username: page.instagramAccount.username || "",
          name: page.instagramAccount.name || "",
        }
      : null,
  };
}

function formatPagesResponse(connection) {
  return {
    success: true,
    sessionId: connection.sessionId,
    userId: connection.userId,
    facebookUserId: connection.facebookUserId,
    pages: (connection.pages || []).map((page) => formatPageForApi(page)),
    selectedPage: formatPageForApi(connection.selectedPage),
  };
}

/**
 * GET /facebook/pages
 * Returns Pages for sessionId (after OAuth) or userId (change Page on existing link).
 * Optional refresh=true refetches /me/accounts from Facebook.
 */
async function getFacebookPages(req, res) {
  try {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const userIdParam =
      typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    const shouldRefresh = String(req.query.refresh || "").trim() === "true";

    if (!sessionId && !userIdParam) {
      return res.status(400).json({
        success: false,
        message: "sessionId or userId query parameter is required.",
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
        message: sessionId
          ? "Facebook session not found or expired. Tap Connect Facebook again in the same browser tab."
          : "No Facebook connection for this user. Tap Connect Facebook first — do not open the page picker directly.",
      });
    }

    if (shouldRefresh) {
      try {
        await syncConnectionPagesFromFacebook(connection);
      } catch (error) {
        return sendError(res, error, "Unable to refresh Facebook Pages.");
      }
    }

    return res.status(200).json(formatPagesResponse(connection));
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
        message:
          "Facebook session not found or expired. Tap Connect Facebook again in the same browser tab.",
      });
    }

    let selectedPage = connection.pages.find((page) => page.pageId === pageId);
    if (!selectedPage) {
      try {
        await syncConnectionPagesFromFacebook(connection);
        selectedPage = connection.pages.find((page) => page.pageId === pageId);
      } catch (syncError) {
        console.warn("[Facebook OAuth] save-page page sync failed:", syncError.message);
      }
    }

    if (!selectedPage) {
      return res.status(404).json({
        success: false,
        message: "Selected page was not found in this Facebook session.",
      });
    }

    const freshInstagram = await fetchInstagramAccountForPage({
      pageId: selectedPage.pageId,
      pageAccessToken: selectedPage.pageAccessToken,
      userAccessToken: connection.userAccessToken,
    });

    const pageIndex = connection.pages.findIndex((page) => page.pageId === pageId);
    if (pageIndex >= 0) {
      connection.pages[pageIndex].instagramAccount = freshInstagram;
      selectedPage = connection.pages[pageIndex];
    }

    const previousPageId = connection.selectedPage?.pageId || null;

    connection.selectedPage = buildSelectedPageSnapshot({
      ...selectedPage,
      instagramAccount: freshInstagram,
    });

    // Keep saved connections longer once a Page is chosen
    connection.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await connection.save();

    const message =
      previousPageId && previousPageId !== pageId
        ? `Facebook Page updated to ${selectedPage.pageName}.`
        : "Facebook Page saved successfully.";

    const instagramNote = connection.selectedPage?.instagramAccount?.username
      ? ` Instagram @${connection.selectedPage.instagramAccount.username} linked.`
      : " No Instagram Business account linked to this Page.";

    return res.status(200).json({
      success: true,
      message: `${message}${instagramNote}`,
      userId: connection.userId,
      selectedPage: formatPageForApi(connection.selectedPage),
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
    const shouldRefresh = String(req.query.refresh || "").trim() === "true";

    let connection = await FacebookConnection.findOne({ userId: user._id });
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "No Facebook connection found for this user.",
        userId: user._id,
      });
    }

    if (shouldRefresh) {
      try {
        await syncConnectionPagesFromFacebook(connection);
      } catch (error) {
        return sendError(res, error, "Unable to refresh Facebook / Instagram connection.");
      }
    }

    return res.status(200).json({
      success: true,
      userId: connection.userId,
      userName: user.name,
      mobileNumber: user.mobileNumber,
      sessionId: connection.sessionId,
      facebookUserId: connection.facebookUserId,
      pagesCount: connection.pages?.length || 0,
      selectedPage: formatPageForApi(connection.selectedPage),
      instagramConnected: Boolean(connection.selectedPage?.instagramAccount?.igUserId),
      instagramUsername: connection.selectedPage?.instagramAccount?.username || null,
      connectedAt: connection.updatedAt,
      expiresAt: connection.expiresAt,
      refreshed: shouldRefresh,
    });
  } catch (error) {
    console.error("[Facebook OAuth] getFacebookConnectionByUser failed:", error.message);
    return sendError(res, error, "Unable to load Facebook connection for user.");
  }
}

/**
 * DELETE /facebook/connection/:userId
 * Removes saved Facebook tokens and Page selection for this app user.
 */
async function deleteFacebookConnectionByUser(req, res) {
  try {
    const user = await resolveAppUserId(req.params.userId);

    const connection = await FacebookConnection.findOneAndDelete({ userId: user._id }).lean();
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "No Facebook connection found for this user.",
        userId: user._id,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Facebook link removed. Connect again to post to a Page.",
      userId: user._id,
      removedPageName: connection.selectedPage?.pageName || null,
    });
  } catch (error) {
    console.error("[Facebook OAuth] deleteFacebookConnectionByUser failed:", error.message);
    return sendError(res, error, "Unable to remove Facebook connection for user.");
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
 * GET /facebook/posts/:userId
 * List recent posts on the user's selected Facebook Page.
 */
async function listFacebookPostsForUser(req, res) {
  try {
    const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const limitRaw =
      typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 25;

    await resolveAppUserId(userId);

    const result = await listPostsForUser({
      userId,
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
    });

    return res.status(200).json({
      success: true,
      message: "Facebook Page posts fetched successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] listFacebookPostsForUser failed:", error.message);
    return sendError(res, error, "Unable to list Facebook Page posts for this user.");
  }
}

/**
 * DELETE /facebook/posts/:userId/:postId
 * Delete a post from the user's selected Facebook Page.
 */
async function deleteFacebookPostForUser(req, res) {
  try {
    const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const postId = typeof req.params.postId === "string" ? req.params.postId.trim() : "";

    await resolveAppUserId(userId);

    const result = await deletePostForUser({ userId, postId });

    return res.status(200).json({
      success: true,
      message: result.deleted
        ? "Facebook post deleted successfully."
        : "Delete request sent to Facebook.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] deleteFacebookPostForUser failed:", error.message);
    return sendError(res, error, "Unable to delete Facebook post for this user.");
  }
}

/**
 * POST /facebook/post-image
 * Low-level endpoint with explicit pageId + pageAccessToken (testing).
 */
/**
 * GET /facebook/oauth-config
 * Shows the exact redirect URI your backend sends to Meta (for dashboard whitelist).
 */
async function getFacebookOAuthConfig(req, res) {
  try {
    const { appId, redirectUri } = getFacebookConfig();
    const maskedAppId =
      typeof appId === "string" && appId.length > 8
        ? `${appId.slice(0, 4)}…${appId.slice(-4)}`
        : "not-set";

    return res.status(200).json({
      success: true,
      message:
        "Copy redirectUri into Meta → Facebook Login → Valid OAuth Redirect URIs (exact match).",
      appId: maskedAppId,
      redirectUri,
      scopes: FACEBOOK_SCOPES,
      metaChecklist: [
        "Client OAuth Login = ON",
        "Web OAuth Login = ON",
        "Valid OAuth Redirect URIs includes redirectUri above (no trailing slash)",
        "App Domains: backend + admin hostnames (no https://)",
        "instagram_basic",
        "instagram_content_publish",
        "Render FACEBOOK_REDIRECT_URI must equal redirectUri exactly",
        "Reconnect Facebook after adding Instagram permissions",
      ],
    });
  } catch (error) {
    return sendError(res, error, "Facebook OAuth is not configured on this server.");
  }
}

async function postInstagramForUser(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim() : "";

    await resolveAppUserId(userId);

    const result = await postPosterToInstagramForUser({ userId, imageUrl, caption });

    return res.status(200).json({
      success: true,
      message: "Poster uploaded to Instagram successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[Instagram] postInstagramForUser failed:", error.message);
    return sendError(res, error, "Unable to post poster to Instagram for this user.");
  }
}

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
  getFacebookOAuthConfig,
  getFacebookPages,
  saveSelectedPage,
  getFacebookConnectionByUser,
  deleteFacebookConnectionByUser,
  getFacebookConnectUrl,
  postFacebookForUser,
  postInstagramForUser,
  listFacebookPostsForUser,
  deleteFacebookPostForUser,
  postFacebookImage,
};
