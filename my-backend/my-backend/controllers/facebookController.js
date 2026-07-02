const mongoose = require("mongoose");
const {
  logFb,
  logFbWarn,
  logFbError,
  maskToken,
  summarizePages,
  summarizeGranularScopes,
} = require("../services/facebookDebugLog");
const FacebookConnection = require("../models/FacebookConnection");
const FacebookOAuthState = require("../models/FacebookOAuthState");
const User = require("../models/User");
const {
  buildFacebookOAuthUrl,
  getFacebookConfig,
  getFacebookLoginConfigId,
  FACEBOOK_SCOPES,
  createOAuthState,
  createSessionId,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedTokenWithFallback,
  resolveFacebookUserFromToken,
  getGraphErrorDetails,
  fetchUserPages,
  enrichPagesWithInstagram,
  fetchInstagramAccountForPage,
  fetchPageById,
  postImageToPage,
  debugAccessToken,
  buildEmptyPagesHelpMessage,
  extractPageIdsFromGranularScopes,
} = require("../services/facebookService");
const {
  postPosterForUser,
  postPosterToInstagramForUser,
  buildSelectedPageSnapshot,
  toPlainFacebookPage,
  listPostsForUser,
  updatePostForUser,
  deletePostForUser,
  listInstagramPostsForUser,
  deleteInstagramPostForUser,
  listSocialPostsForUser,
  getFacebookStatusByUserIds,
  disconnectFacebookForUser,
  buildFacebookConnectUrl,
  resolvePublicApiBaseUrl,
} = require("../services/facebookPostService");

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
// Incomplete OAuth (no Page saved yet) — metadata only; not auto-deleted by MongoDB.
const PENDING_CONNECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Saved Page connections stay until admin taps "Remove Facebook link".
const SAVED_CONNECTION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function getConnectionExpiresAt(selectedPage) {
  const ttlMs = selectedPage?.pageId ? SAVED_CONNECTION_TTL_MS : PENDING_CONNECTION_TTL_MS;
  return new Date(Date.now() + ttlMs);
}

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

function buildOAuthConnectUrl(userId, returnTo = "admin", options = {}, req = null) {
  const params = new URLSearchParams({
    userId: String(userId),
    returnTo: resolveReturnTo(returnTo),
  });
  if (options.reconnect) {
    params.set("reconnect", "1");
  }
  if (options.mobile) {
    params.set("mobile", "1");
  }
  if (options.includeInstagram) {
    params.set("instagram", "1");
  }
  const base = buildFacebookConnectUrl(String(userId), undefined, req).split("?")[0];
  return `${base}?${params.toString()}`;
}

function sanitizePagesForStorage(pages) {
  return (Array.isArray(pages) ? pages : [])
    .map((page) => toPlainFacebookPage(page))
    .filter(Boolean)
    .map((page) => ({
      pageId: page.pageId,
      pageName: page.pageName,
      pageAccessToken: page.pageAccessToken,
      instagramAccount: page.instagramAccount?.igUserId ? page.instagramAccount : null,
    }));
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

function isAndroidUserAgent(userAgent) {
  return /Android/i.test(String(userAgent || ""));
}

function isIOSUserAgent(userAgent) {
  return /iPhone|iPad|iPod/i.test(String(userAgent || ""));
}

function buildIOSOAuthBridgeHtml(oauthUrl) {
  const safeOauthUrl = JSON.stringify(oauthUrl);

  // iOS: fb://facewebmodal opens the Facebook app home but often skips Business
  // Login OAuth (config_id). Load Meta's mobile OAuth dialog in Safari instead.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${oauthUrl.replace(/"/g, "&quot;")}" />
  <title>Opening Facebook…</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem 1.25rem; text-align: center; color: #1f2937; }
    p { line-height: 1.5; }
    a { color: #1877f2; font-weight: 600; }
  </style>
</head>
<body>
  <p><strong>Facebook permissions khul rahi hain…</strong></p>
  <p>Allow karein aur apna Page choose karein.</p>
  <p><a href="${oauthUrl.replace(/"/g, "&quot;")}">Yahan tap karein agar screen na khule</a></p>
  <script>
    window.location.replace(${safeOauthUrl});
  </script>
</body>
</html>`;
}

function buildAndroidOAuthBridgeHtml(oauthUrl) {
  const encodedFallback = encodeURIComponent(oauthUrl);
  const intentPath = oauthUrl.replace(/^https:\/\//i, "");
  const safeOauthUrl = JSON.stringify(oauthUrl);
  const safeIntentPath = JSON.stringify(intentPath);
  const safeEncodedFallback = JSON.stringify(encodedFallback);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Opening Facebook…</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem 1.25rem; text-align: center; color: #1f2937; }
    p { line-height: 1.5; }
    a { color: #1877f2; font-weight: 600; }
  </style>
</head>
<body>
  <p><strong>Facebook app khul rahi hai…</strong></p>
  <p>Page choose karein aur permissions allow karein.</p>
  <p>If nothing happens, <a id="webFallback" href="#">browser me continue karein</a>.</p>
  <script>
    (function () {
      var oauthUrl = ${safeOauthUrl};
      var intentPath = ${safeIntentPath};
      var encodedFallback = ${safeEncodedFallback};
      var fallback = document.getElementById("webFallback");
      fallback.href = oauthUrl;

      function openWebFallback() {
        window.location.replace(oauthUrl);
      }

      function openFacebookIntent(packageName) {
        var intentUrl =
          "intent://" + intentPath +
          "#Intent;scheme=https;package=" + packageName +
          ";S.browser_fallback_url=" + encodedFallback + ";end";
        window.location.replace(intentUrl);
      }

      // 1) Facebook app in-app browser (uses existing FB login session)
      window.location.replace("fb://facewebmodal/f?href=" + encodeURIComponent(oauthUrl));

      window.setTimeout(function () {
        // 2) Main Facebook app
        openFacebookIntent("com.facebook.katana");
      }, 700);

      window.setTimeout(function () {
        // 3) Facebook Lite
        openFacebookIntent("com.facebook.lite");
      }, 1400);

      window.setTimeout(openWebFallback, 2600);
    })();
  </script>
</body>
</html>`;
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
    const includeInstagram = String(req.query.instagram || "").trim() === "1";
    await FacebookOAuthState.create({
      state,
      userId: user._id,
      returnTo,
      includeInstagram,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });

    const userAgent = String(req.headers["user-agent"] || "");
    const mobileQuery = String(req.query.mobile || "").trim() === "1";
    const isMobile =
      mobileQuery ||
      /Android|iPhone|iPad|iPod|Mobile|WhatsApp/i.test(userAgent);

    const reconnect = String(req.query.reconnect || "").trim() === "1";
    const oauthUrl = buildFacebookOAuthUrl(state, {
      mobile: isMobile,
      reconnect,
      includeInstagram,
    });

    logFb("oauth.start", {
      appUserId: String(user._id),
      appUserName: user.name || null,
      returnTo,
      reconnect,
      includeInstagram,
      mobile: isMobile,
      userAgent: userAgent.slice(0, 120),
    });

    const skipAppBridge = String(req.query.app || "").trim() === "0";
    if (isMobile && isAndroidUserAgent(userAgent) && !skipAppBridge) {
      logFb("oauth.mobile_bridge", { appUserId: String(user._id), platform: "android" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(buildAndroidOAuthBridgeHtml(oauthUrl));
    }

    if (isMobile && isIOSUserAgent(userAgent) && !skipAppBridge) {
      logFb("oauth.mobile_bridge", { appUserId: String(user._id), platform: "ios" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(buildIOSOAuthBridgeHtml(oauthUrl));
    }

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
async function persistFacebookConnection({
  userId,
  facebookUserId,
  userAccessToken,
  pages,
  selectedPage,
  expiresAt,
  includeInstagramPermissions = false,
}) {
  const sessionId = createSessionId();
  const storedPages = sanitizePagesForStorage(pages || []);
  const storedSelectedPage = selectedPage
    ? buildSelectedPageSnapshot(
        sanitizePagesForStorage([selectedPage])[0] || selectedPage,
      )
    : null;

  await FacebookConnection.findOneAndUpdate(
    { userId },
    {
      sessionId,
      userId,
      facebookUserId,
      userAccessToken,
      pages: storedPages,
      selectedPage: storedSelectedPage,
      includeInstagramPermissions: Boolean(includeInstagramPermissions),
      expiresAt,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );

  return sessionId;
}

function buildOAuthErrorRedirect(frontendUrl, pagesPath, message, appUserId, returnTo) {
  const params = new URLSearchParams({ error: message });
  if (appUserId) {
    params.set("userId", appUserId);
  }
  if (returnTo === "portal") {
    params.set("returnTo", "portal");
  }
  return `${frontendUrl}${pagesPath}?${params.toString()}`;
}

async function resolveOAuthRedirectFromState(state) {
  const fallback = {
    frontendUrl: getFrontendUrl(),
    pagesPath: "/facebook/pages",
    appUserId: "",
    returnTo: "admin",
  };

  if (!state) {
    return fallback;
  }

  const oauthStateDoc = await FacebookOAuthState.findOne({ state }).lean();
  if (!oauthStateDoc) {
    return fallback;
  }

  const returnTo = resolveReturnTo(oauthStateDoc.returnTo);
  return {
    frontendUrl: getFrontendUrl(returnTo),
    pagesPath: getFacebookPagesPath(returnTo),
    appUserId: oauthStateDoc.userId ? String(oauthStateDoc.userId) : "",
    returnTo,
  };
}

async function handleFacebookCallback(req, res) {
  let frontendUrl = getFrontendUrl();
  let pagesPath = "/facebook/pages";
  let appUserId = "";
  let returnTo = "admin";

  try {
    const stateParam = typeof req.query.state === "string" ? req.query.state.trim() : "";
    const redirectContext = await resolveOAuthRedirectFromState(stateParam);
    frontendUrl = redirectContext.frontendUrl;
    pagesPath = redirectContext.pagesPath;
    appUserId = redirectContext.appUserId;
    returnTo = redirectContext.returnTo;

    const oauthError = typeof req.query.error === "string" ? req.query.error : "";
    const oauthErrorDescription =
      typeof req.query.error_description === "string"
        ? req.query.error_description
        : "";

    if (oauthError) {
      const message = oauthErrorDescription || oauthError;
      return res.redirect(
        buildOAuthErrorRedirect(frontendUrl, pagesPath, message, appUserId, returnTo),
      );
    }

    const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
    const state = stateParam;

    if (!code || !state) {
      return res.redirect(
        buildOAuthErrorRedirect(
          frontendUrl,
          pagesPath,
          "Missing OAuth code or state.",
          appUserId,
          returnTo,
        ),
      );
    }

    // Validate CSRF state (one-time use)
    const oauthStateDoc = await FacebookOAuthState.findOneAndDelete({ state });
    if (!oauthStateDoc) {
      return res.redirect(
        buildOAuthErrorRedirect(
          frontendUrl,
          pagesPath,
          "Invalid or expired OAuth state.",
          appUserId,
          returnTo,
        ),
      );
    }

    pagesPath = getFacebookPagesPath(oauthStateDoc.returnTo);
    frontendUrl = getFrontendUrl(oauthStateDoc.returnTo);
    returnTo = resolveReturnTo(oauthStateDoc.returnTo);

    if (!oauthStateDoc.userId) {
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent("OAuth session missing userId. Start Connect Facebook from a user profile with userId in the URL.")}`,
      );
    }

    appUserId = String(oauthStateDoc.userId);
    const includeInstagramPermissions = Boolean(oauthStateDoc.includeInstagram);

    logFb("oauth.callback_start", {
      appUserId,
      returnTo: oauthStateDoc.returnTo,
      frontendUrl,
      pagesPath,
      includeInstagramPermissions,
    });

    // Exchange authorization code -> short-lived token -> long-lived token
    logFb("oauth.callback_step", { appUserId, step: "exchange_code" });
    const shortLived = await exchangeCodeForShortLivedToken(code);
    logFb("oauth.token_short_lived", {
      appUserId,
      expiresIn: shortLived.expiresIn,
      token: maskToken(shortLived.accessToken),
    });

    logFb("oauth.callback_step", { appUserId, step: "exchange_long_lived" });
    const longLived = await exchangeForLongLivedTokenWithFallback(
      shortLived.accessToken,
      shortLived.expiresIn,
    );
    logFb("oauth.token_long_lived", {
      appUserId,
      expiresIn: longLived.expiresIn,
      usedShortLivedFallback: Boolean(longLived.usedShortLivedFallback),
      token: maskToken(longLived.accessToken),
    });

    logFb("oauth.callback_step", { appUserId, step: "resolve_facebook_user" });
    const facebookUser = await resolveFacebookUserFromToken(longLived.accessToken);
    logFb("oauth.facebook_user", {
      appUserId,
      facebookUserId: facebookUser.id,
      facebookUserName: facebookUser.name,
    });

    const rawPages = await fetchUserPages(longLived.accessToken).catch((fetchError) => {
      logFbWarn("oauth.fetch_pages_failed", {
        appUserId,
        error: fetchError.message,
      });
      return [];
    });
    logFb("oauth.raw_pages", {
      appUserId,
      count: rawPages.length,
      pages: summarizePages(rawPages),
    });

    let pages = rawPages;
    if (includeInstagramPermissions) {
      try {
        pages = await enrichPagesWithInstagram(rawPages, longLived.accessToken);
      } catch (enrichError) {
        logFbWarn("oauth.enrich_failed", {
          appUserId,
          error: enrichError.message,
        });
        pages = rawPages;
      }
    }
    logFb("oauth.enriched_pages", {
      appUserId,
      count: pages.length,
      pages: summarizePages(pages),
    });

    if (!pages.length) {
      const debugInfo = await debugAccessToken(longLived.accessToken);
      logFbWarn("oauth.no_pages", {
        appUserId,
        facebookUserId: facebookUser.id,
        facebookUserName: facebookUser.name,
        scopes: debugInfo?.scopes || [],
        granularScopes: summarizeGranularScopes(debugInfo?.granularScopes),
        pageIdsFromGranular: debugInfo
          ? extractPageIdsFromGranularScopes(debugInfo.granularScopes)
          : [],
      });

      const helpMessage = buildEmptyPagesHelpMessage({ facebookUser, debugInfo });
      const returnToQuery =
        oauthStateDoc.returnTo === "portal" ? "&returnTo=portal" : "";

      let emptyPagesSessionId = "";
      try {
        emptyPagesSessionId = await persistFacebookConnection({
          userId: oauthStateDoc.userId,
          facebookUserId: facebookUser.id,
          userAccessToken: longLived.accessToken,
          pages: [],
          selectedPage: null,
          expiresAt: getConnectionExpiresAt(null),
          includeInstagramPermissions,
        });
      } catch (saveError) {
        console.error(
          "[Facebook OAuth] Failed to save empty-pages connection:",
          saveError.message,
        );
      }

      const sessionQuery = emptyPagesSessionId
        ? `sessionId=${emptyPagesSessionId}&`
        : "";
      return res.redirect(
        `${frontendUrl}${pagesPath}?${sessionQuery}userId=${appUserId}&error=${encodeURIComponent(helpMessage)}${returnToQuery}`,
      );
    }

    // If user has only one Page, auto-select it (no extra click on /facebook/pages)
    let autoSelectedPage = pages.length === 1 ? pages[0] : null;
    if (autoSelectedPage && includeInstagramPermissions) {
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
    const connectionExpiresAt = getConnectionExpiresAt(autoSelectedPage);

    let sessionId = "";
    try {
      sessionId = await persistFacebookConnection({
        userId: oauthStateDoc.userId,
        facebookUserId: facebookUser.id,
        userAccessToken: longLived.accessToken,
        pages,
        selectedPage: autoSelectedPage,
        expiresAt: connectionExpiresAt,
        includeInstagramPermissions,
      });
    } catch (saveError) {
      console.error(
        "[Facebook OAuth] Failed to save FacebookConnection:",
        saveError.message,
        saveError,
      );
      const returnToQuery =
        oauthStateDoc.returnTo === "portal" ? "&returnTo=portal" : "";
      const saveDetail =
        typeof saveError.message === "string" && saveError.message.trim()
          ? saveError.message.trim()
          : "Unknown database error";
      return res.redirect(
        `${frontendUrl}${pagesPath}?error=${encodeURIComponent(
          `Could not save Facebook connection: ${saveDetail}`,
        )}&userId=${appUserId}${returnToQuery}`,
      );
    }

    logFb("oauth.success", {
      appUserId,
      sessionId: `${sessionId.slice(0, 8)}…`,
      pageCount: pages.length,
      autoSelectedPageId: autoSelectedPage?.pageId || null,
      autoSelectedPageName: autoSelectedPage?.pageName || null,
      autoSelectedInstagram: autoSelectedPage?.instagramAccount?.username || null,
    });

    const returnToQuery =
      oauthStateDoc.returnTo === "portal" ? "&returnTo=portal" : "";

    return res.redirect(
      `${frontendUrl}${pagesPath}?sessionId=${sessionId}&userId=${appUserId}${returnToQuery}`,
    );
  } catch (error) {
    const graphError = error?.graphError || getGraphErrorDetails(error);
    logFbError("oauth.callback_failed", error, {
      appUserId,
      graphError,
    });
    const message = encodeURIComponent(error.message || "Facebook authentication failed.");
    const userIdQuery = appUserId ? `&userId=${appUserId}` : "";
    return res.redirect(`${frontendUrl}${pagesPath}?error=${message}${userIdQuery}`);
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

  logFb("pages.sync_start", {
    userId: String(connection.userId),
    facebookUserId: connection.facebookUserId || null,
    selectedPageId: connection.selectedPage?.pageId || null,
  });

  const rawPages = await fetchUserPages(connection.userAccessToken);
  let pages = rawPages;
  if (connection.includeInstagramPermissions) {
    pages = await enrichPagesWithInstagram(rawPages, connection.userAccessToken);
  }
  connection.pages = sanitizePagesForStorage(pages);

  logFb("pages.sync_done", {
    userId: String(connection.userId),
    count: pages.length,
    pages: summarizePages(pages),
  });

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

function formatPageForApi(page, includeInstagram = true) {
  const plain = toPlainFacebookPage(page);
  if (!plain) {
    return null;
  }

  return {
    pageId: plain.pageId,
    pageName: plain.pageName,
    pageAccessToken: plain.pageAccessToken,
    instagramAccount:
      includeInstagram && plain.instagramAccount?.igUserId
      ? {
          igUserId: plain.instagramAccount.igUserId,
          username: plain.instagramAccount.username || "",
          name: plain.instagramAccount.name || "",
        }
      : null,
  };
}

function formatPagesResponse(connection) {
  const includeInstagram = Boolean(connection.includeInstagramPermissions);
  return {
    success: true,
    sessionId: connection.sessionId,
    userId: connection.userId,
    facebookUserId: connection.facebookUserId,
    pages: (connection.pages || []).map((page) => formatPageForApi(page, includeInstagram)),
    selectedPage: formatPageForApi(connection.selectedPage, includeInstagram),
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
    const returnToParam =
      typeof req.query.returnTo === "string" ? req.query.returnTo.trim() : "";
    const shouldRefresh = String(req.query.refresh || "").trim() === "true";

    logFb("pages.api_request", {
      sessionId: sessionId ? `${sessionId.slice(0, 8)}…` : null,
      userId: userIdParam || null,
      returnTo: returnToParam || null,
      refresh: shouldRefresh,
    });

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
      logFbWarn("pages.api_no_connection", {
        sessionId: sessionId ? `${sessionId.slice(0, 8)}…` : null,
        userId: userIdParam || null,
      });

      const returnTo = resolveReturnTo(returnToParam);
      const connectUrl =
        userIdParam && isValidObjectId(userIdParam)
          ? buildOAuthConnectUrl(userIdParam, returnTo, { reconnect: true }, req)
          : undefined;

      return res.status(404).json({
        success: false,
        message: sessionId
          ? "Facebook session not found or expired. Tap Connect Facebook again in the same browser tab."
          : "No Facebook connection yet. Go to your account and tap Connect Facebook — do not open the page picker URL directly.",
        connectUrl,
        userId: userIdParam || undefined,
      });
    }

    if (shouldRefresh) {
      try {
        await syncConnectionPagesFromFacebook(connection);
      } catch (error) {
        return sendError(res, error, "Unable to refresh Facebook Pages.");
      }
    }

    logFb("pages.api_response", {
      userId: String(connection.userId),
      sessionId: `${connection.sessionId.slice(0, 8)}…`,
      pageCount: (connection.pages || []).length,
      selectedPageId: connection.selectedPage?.pageId || null,
      pages: summarizePages(connection.pages),
    });

    return res.status(200).json(formatPagesResponse(connection));
  } catch (error) {
    logFbError("pages.api_failed", error);
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

    logFb("pages.save_request", {
      sessionId: sessionId ? `${sessionId.slice(0, 8)}…` : null,
      userId: userIdParam || null,
      pageId,
    });

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

    const findStoredPage = (targetPageId) =>
      connection.pages.find(
        (page) => toPlainFacebookPage(page)?.pageId === targetPageId,
      );

    let selectedPage = findStoredPage(pageId);
    if (!selectedPage) {
      try {
        await syncConnectionPagesFromFacebook(connection);
        selectedPage = findStoredPage(pageId);
      } catch (syncError) {
        logFbWarn("pages.save_sync_failed", {
          userId: String(connection.userId),
          pageId,
          error: syncError.message,
        });
      }
    }

    if (!selectedPage) {
      logFbWarn("pages.save_not_found", {
        userId: String(connection.userId),
        pageId,
        availablePageIds: (connection.pages || []).map(
          (page) => toPlainFacebookPage(page)?.pageId,
        ),
      });
      return res.status(404).json({
        success: false,
        message: "Selected page was not found in this Facebook session.",
      });
    }

    let plainPage = toPlainFacebookPage(selectedPage);
    if (!plainPage?.pageAccessToken) {
      const refetched = await fetchPageById(pageId, connection.userAccessToken);
      if (refetched) {
        plainPage = refetched;
      }
    }

    if (!plainPage?.pageAccessToken) {
      return res.status(502).json({
        success: false,
        message:
          "Could not load Page access token. Tap Connect / reconnect Facebook and try again.",
      });
    }

    const freshInstagram = connection.includeInstagramPermissions
      ? await fetchInstagramAccountForPage({
          pageId: plainPage.pageId,
          pageAccessToken: plainPage.pageAccessToken,
          userAccessToken: connection.userAccessToken,
        })
      : null;

    const pageIndex = connection.pages.findIndex(
      (page) => toPlainFacebookPage(page)?.pageId === pageId,
    );
    if (pageIndex >= 0) {
      connection.pages[pageIndex] = {
        ...plainPage,
        instagramAccount: freshInstagram,
      };
    }

    const previousPageId = connection.selectedPage?.pageId || null;

    const selectedSnapshot = buildSelectedPageSnapshot({
      ...plainPage,
      instagramAccount: freshInstagram,
    });
    if (!selectedSnapshot) {
      return res.status(500).json({
        success: false,
        message: "Could not prepare selected Page for saving. Please try again.",
      });
    }

    connection.selectedPage = selectedSnapshot;

    // Keep saved connections until explicitly removed by admin.
    connection.expiresAt = getConnectionExpiresAt(connection.selectedPage);
    await connection.save();

    const message =
      previousPageId && previousPageId !== pageId
        ? `Facebook Page updated to ${plainPage.pageName}.`
        : "Facebook Page saved successfully.";

    const instagramNote =
      connection.includeInstagramPermissions &&
      connection.selectedPage?.instagramAccount?.username
        ? ` Instagram @${connection.selectedPage.instagramAccount.username} linked.`
        : connection.includeInstagramPermissions
          ? " No Instagram Business account linked to this Page."
          : "";

    logFb("pages.save_success", {
      userId: String(connection.userId),
      pageId,
      pageName: plainPage.pageName,
      previousPageId,
      instagramUsername: connection.selectedPage?.instagramAccount?.username || null,
    });

    return res.status(200).json({
      success: true,
      message: `${message}${instagramNote}`,
      userId: connection.userId,
      selectedPage: formatPageForApi(connection.selectedPage),
    });
  } catch (error) {
    logFbError("pages.save_failed", error);
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
    const result = await disconnectFacebookForUser(String(user._id));

    if (!result.connectionRemoved && result.oauthStatesRemoved === 0) {
      return res.status(404).json({
        success: false,
        message: "No Facebook connection found for this user.",
        userId: user._id,
      });
    }

    return res.status(200).json({
      success: true,
      message: result.connectionRemoved
        ? "Facebook link removed. Tokens and Page selection deleted from our database."
        : "Pending Facebook OAuth data cleared from our database.",
      userId: user._id,
      removedPageName: result.removedPageName,
      oauthStatesRemoved: result.oauthStatesRemoved,
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
      connectUrl: buildFacebookConnectUrl(String(user._id), apiBase, req),
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
 * GET /facebook/social-posts/:userId
 * List recent Facebook Page posts and Instagram media for the user.
 */
async function listSocialPostsForUserHandler(req, res) {
  try {
    const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const limitRaw =
      typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 25;

    await resolveAppUserId(userId);

    const result = await listSocialPostsForUser({
      userId,
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
    });

    return res.status(200).json({
      success: true,
      message: "Social posts fetched successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] listSocialPostsForUser failed:", error.message);
    return sendError(res, error, "Unable to list social posts for this user.");
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
 * PATCH /facebook/posts/:userId/:postId
 * Update caption/message on a Facebook Page post.
 */
async function updateFacebookPostForUser(req, res) {
  try {
    const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const postId = typeof req.params.postId === "string" ? req.params.postId.trim() : "";
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.caption === "string"
          ? body.caption
          : null;

    await resolveAppUserId(userId);

    if (message === null) {
      return res.status(400).json({
        success: false,
        message: "message (caption) is required in the request body.",
      });
    }

    const result = await updatePostForUser({ userId, postId, message });

    return res.status(200).json({
      success: true,
      message: "Facebook post updated successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] updateFacebookPostForUser failed:", error.message);
    return sendError(res, error, "Unable to update Facebook post for this user.");
  }
}

/**
 * GET /instagram/posts/:userId
 * List recent Instagram media for the user's linked account.
 */
async function listInstagramPostsForUserHandler(req, res) {
  try {
    const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const limitRaw =
      typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 25;

    await resolveAppUserId(userId);

    const result = await listInstagramPostsForUser({
      userId,
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
    });

    return res.status(200).json({
      success: true,
      message: result.connected
        ? "Instagram posts fetched successfully."
        : "No Instagram account linked to this user's Facebook Page.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] listInstagramPostsForUser failed:", error.message);
    return sendError(res, error, "Unable to list Instagram posts for this user.");
  }
}

/**
 * DELETE /instagram/posts/:userId/:mediaId
 * Delete a post from the user's linked Instagram account.
 */
async function deleteInstagramPostForUserHandler(req, res) {
  try {
    const userId = typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    const mediaId =
      typeof req.params.mediaId === "string" ? req.params.mediaId.trim() : "";

    await resolveAppUserId(userId);

    const result = await deleteInstagramPostForUser({ userId, mediaId });

    return res.status(200).json({
      success: true,
      message: result.deleted
        ? "Instagram post deleted successfully."
        : "Delete request sent to Instagram.",
      ...result,
    });
  } catch (error) {
    console.error("[Facebook OAuth] deleteInstagramPostForUser failed:", error.message);
    return sendError(res, error, "Unable to delete Instagram post for this user.");
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

    const configId = getFacebookLoginConfigId();
    const forceScopeOAuth = process.env.FACEBOOK_OAUTH_FORCE_SCOPES === "1"
      || process.env.FACEBOOK_OAUTH_FORCE_SCOPES === "true"
      || process.env.FACEBOOK_OAUTH_FORCE_SCOPES === "yes";
    const maskedConfigId =
      configId && configId.length > 6
        ? `${configId.slice(0, 3)}…${configId.slice(-3)}`
        : configId || null;
    const apiBaseUrl = resolvePublicApiBaseUrl(req);
    const adminFrontendUrl = getFrontendUrl("admin");
    const portalFrontendUrl = getFrontendUrl("portal");
    const warnings = [];

    if (!configId) {
      warnings.push("FACEBOOK_LOGIN_CONFIG_ID is missing — Meta may return zero Pages for Business apps.");
    }
    if (forceScopeOAuth) {
      warnings.push(
        "FACEBOOK_OAUTH_FORCE_SCOPES is enabled — using scope-based login instead of config_id (debug only).",
      );
    }
    if (adminFrontendUrl.includes("localhost")) {
      warnings.push("FRONTEND_URL points to localhost — OAuth will redirect users to localhost after login.");
    }
    if (!process.env.API_BASE_URL?.trim() && apiBaseUrl.includes("localhost")) {
      warnings.push("API_BASE_URL is unset and request host could not be detected — connectUrl may point to localhost.");
    }

    logFb("oauth.config_check", {
      usesLoginForBusiness: Boolean(configId),
      loginConfigId: maskedConfigId,
      apiBaseUrl,
      adminFrontendUrl,
      portalFrontendUrl,
      warnings,
    });

    return res.status(200).json({
      success: true,
      message: configId
        ? "Using Facebook Login for Business (config_id). Pages should appear after user selects them on Meta's screen."
        : "No FACEBOOK_LOGIN_CONFIG_ID set — using scope-based login. Business apps: create a Login for Business configuration in Meta.",
      appId: maskedAppId,
      redirectUri,
      apiBaseUrl,
      adminFrontendUrl,
      portalFrontendUrl,
      loginConfigId: maskedConfigId,
      usesLoginForBusiness: Boolean(configId),
      forceScopeOAuth,
      scopes: configId ? null : FACEBOOK_SCOPES,
      warnings,
      metaChecklist: [
        "Client OAuth Login = ON",
        "Web OAuth Login = ON",
        "Valid OAuth Redirect URIs includes redirectUri above (no trailing slash)",
        "App Domains: backend + admin hostnames (no https://)",
        "Facebook Login for Business → Configurations → User token → select Pages asset",
        "App Restrictions (Settings → Advanced): disable Country/Age restrictions if enabled",
        "Login config must be User access token (not System User)",
        "Login config permissions must match App Review approvals only",
        "Instagram posting (optional later): instagram_basic, instagram_content_publish — only after Meta App Review",
        "Copy Configuration ID → Render env FACEBOOK_LOGIN_CONFIG_ID",
        "During login user MUST tick their Page on Meta's screen",
        "Reconnect Facebook after env changes",
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
  listSocialPostsForUserHandler,
  updateFacebookPostForUser,
  deleteFacebookPostForUser,
  listInstagramPostsForUserHandler,
  deleteInstagramPostForUserHandler,
  postFacebookImage,
};
