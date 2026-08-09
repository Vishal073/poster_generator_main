const axios = require("axios");
const crypto = require("crypto");
const {
  logFb,
  logFbWarn,
  logFbError,
  maskToken,
  summarizePages,
  summarizeGranularScopes,
} = require("./facebookDebugLog");
const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Default scopes for Facebook Page connect + posting. Override via FACEBOOK_SCOPES in .env.
// Instagram scopes are optional — add instagram_basic,instagram_content_publish only when Meta App Review approves them.
// pages_read_engagement is required by Meta for /photos and App Review with pages_manage_posts.
const FACEBOOK_SCOPES = (
  process.env.FACEBOOK_SCOPES ||
  ["pages_show_list", "pages_read_engagement", "pages_manage_posts"].join(",")
).trim();

const FACEBOOK_INSTAGRAM_SCOPES = ["instagram_basic", "instagram_content_publish"];

// These are Marketing API scopes — invalid on standard Facebook Login dialog.
const FACEBOOK_ADS_SCOPES = ["ads_management", "ads_read"];

/**
 * Instagram scopes for Facebook Login (Page-linked IG):
 * instagram_basic, instagram_content_publish.
 * Set FACEBOOK_ALLOW_INSTAGRAM_OAUTH_SCOPES=0 to force-disable if Meta returns Invalid Scopes.
 * Override list via FACEBOOK_INSTAGRAM_SCOPES.
 */
function isInstagramOAuthScopesEnabled() {
  const raw = process.env.FACEBOOK_ALLOW_INSTAGRAM_OAUTH_SCOPES;
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  // Default ON so Include Instagram actually requests IG permissions.
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

function getInstagramOAuthScopes() {
  const raw = process.env.FACEBOOK_INSTAGRAM_SCOPES;
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
  return FACEBOOK_INSTAGRAM_SCOPES;
}

function isScopeBasedOAuthForced() {
  const raw = process.env.FACEBOOK_OAUTH_FORCE_SCOPES;
  return raw === "1" || raw === "true" || raw === "yes";
}

function getInstagramLoginConfigId() {
  const raw = process.env.FACEBOOK_LOGIN_CONFIG_ID_WITH_INSTAGRAM;
  return typeof raw === "string" ? raw.trim() : "";
}

function getFacebookLoginConfigId(options = {}) {
  if (isScopeBasedOAuthForced()) {
    return "";
  }

  const includeInstagram = Boolean(options.includeInstagram);
  if (includeInstagram) {
    const withInstagram = getInstagramLoginConfigId();
    if (withInstagram) {
      return withInstagram;
    }
  }

  const raw = process.env.FACEBOOK_LOGIN_CONFIG_ID;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Pick config_id vs scope OAuth. When Instagram is requested without a dedicated
 * Business Login config, use scopes so instagram_basic + instagram_content_publish
 * are actually sent (main config_id often has Page-only permissions).
 */
function resolveOAuthAuthParams(options = {}) {
  const includeInstagram = Boolean(options.includeInstagram);

  if (isScopeBasedOAuthForced()) {
    return {
      authMode: "scope",
      configId: "",
      scopes: buildOAuthScopes(includeInstagram),
    };
  }

  if (includeInstagram) {
    const instagramConfigId = getInstagramLoginConfigId();
    if (instagramConfigId) {
      return { authMode: "config_id", configId: instagramConfigId, scopes: null };
    }
    return { authMode: "scope", configId: "", scopes: buildOAuthScopes(true) };
  }

  const configId = getFacebookLoginConfigId({ includeInstagram: false });
  if (configId) {
    return { authMode: "config_id", configId, scopes: null };
  }

  return { authMode: "scope", configId: "", scopes: buildOAuthScopes(false) };
}

function buildOAuthScopes(includeInstagram = false) {
  const instagramScopes = getInstagramOAuthScopes();
  const baseScopes = FACEBOOK_SCOPES.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .filter((scope) => !instagramScopes.includes(scope))
    .filter((scope) => !FACEBOOK_ADS_SCOPES.includes(scope));

  if (!includeInstagram || !isInstagramOAuthScopesEnabled()) {
    if (includeInstagram && !isInstagramOAuthScopesEnabled()) {
      logFbWarn("oauth.instagram_scopes_skipped", {
        reason:
          "FACEBOOK_ALLOW_INSTAGRAM_OAUTH_SCOPES is disabled. Set to 1 (or unset) to request Instagram permissions.",
      });
    }
    return baseScopes.join(",");
  }

  const merged = [...baseScopes];
  for (const scope of instagramScopes) {
    if (!merged.includes(scope)) {
      merged.push(scope);
    }
  }
  return merged.join(",");
}

function normalizeRedirectUri(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  let uri = value.trim();

  // Render mistake: pasting "FACEBOOK_REDIRECT_URI=https://..." into the value field
  if (/^FACEBOOK_REDIRECT_URI\s*=/i.test(uri)) {
    uri = uri.replace(/^FACEBOOK_REDIRECT_URI\s*=/i, "").trim();
  }

  return uri;
}

function getFacebookConfig() {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  const redirectUri = normalizeRedirectUri(process.env.FACEBOOK_REDIRECT_URI);

  if (!appId || !appSecret || !redirectUri) {
    const error = new Error(
      "Facebook OAuth is not configured. Set FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and FACEBOOK_REDIRECT_URI.",
    );
    error.statusCode = 500;
    throw error;
  }

  return { appId, appSecret, redirectUri };
}

function createOAuthState() {
  return crypto.randomBytes(24).toString("hex");
}

function createSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Build the Facebook Login URL that sends the user to grant Page permissions.
 * @param {object} [options]
 * @param {boolean} [options.mobile] - touch UI + m.facebook.com (better on phones, not WhatsApp WebView)
 * @param {boolean} [options.includeInstagram] - request instagram_basic + instagram_content_publish
 */
function buildFacebookOAuthUrl(state, options = {}) {
  const { appId, redirectUri } = getFacebookConfig();
  const useMobile = Boolean(options.mobile);
  const reconnect = Boolean(options.reconnect);
  const includeInstagram = Boolean(options.includeInstagram);
  const { authMode, configId, scopes: oauthScopes } = resolveOAuthAuthParams({
    includeInstagram,
  });

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
  });

  // Business-type Meta apps often require Facebook Login for Business (config_id).
  // When set, Meta shows Page/asset picker — required or /me/accounts returns empty.
  if (configId) {
    params.set("config_id", configId);
  } else {
    params.set("scope", oauthScopes);
  }

  if (useMobile) {
    params.set("display", "touch");
  }

  // Ask Facebook to show login/permissions again (switch account or refresh Page list)
  if (reconnect) {
    params.set("auth_type", "rerequest");
  }

  const host = useMobile ? "m.facebook.com" : "www.facebook.com";
  const oauthUrl = `https://${host}/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;

  logFb("oauth.build_url", {
    host,
    useMobile,
    reconnect,
    includeInstagram,
    authMode,
    configId: configId ? `${configId.slice(0, 3)}…` : null,
    scopes: configId ? null : oauthScopes,
    redirectUri,
  });

  return oauthUrl;
}

/**
 * Extract a readable message from Facebook Graph API error responses.
 */
function getGraphErrorMessage(error) {
  const graphMessage =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message;

  if (graphMessage) {
    return graphMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown Facebook API error";
}

function getGraphErrorDetails(error) {
  const graphError = error?.response?.data?.error;
  if (!graphError || typeof graphError !== "object") {
    return {
      message: getGraphErrorMessage(error),
      type: null,
      code: null,
      errorSubcode: null,
      fbtraceId: null,
      httpStatus: error?.response?.status || null,
    };
  }

  return {
    message: graphError.message || getGraphErrorMessage(error),
    type: graphError.type || null,
    code: graphError.code ?? null,
    errorSubcode: graphError.error_subcode ?? null,
    fbtraceId: graphError.fbtrace_id || null,
    httpStatus: error?.response?.status || null,
  };
}

function wrapGraphError(error, fallbackMessage) {
  const wrapped = new Error(getGraphErrorMessage(error) || fallbackMessage);
  wrapped.statusCode = error?.response?.status || 502;
  wrapped.details = error?.response?.data || null;
  wrapped.graphError = getGraphErrorDetails(error);
  return wrapped;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Instagram image containers must finish processing before media_publish.
 * Without this wait Meta often returns "Media ID is not available".
 */
async function waitForInstagramMediaContainer(creationId, pageAccessToken, options = {}) {
  const maxAttempts =
    typeof options.maxAttempts === "number" && options.maxAttempts > 0
      ? options.maxAttempts
      : 15;
  const delayMs =
    typeof options.delayMs === "number" && options.delayMs > 0 ? options.delayMs : 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const statusResponse = await axios.get(`${GRAPH_BASE_URL}/${creationId}`, {
      params: {
        fields: "status_code",
        access_token: pageAccessToken,
      },
      timeout: 15000,
    });

    const statusCode = statusResponse.data?.status_code;
    logFb("instagram.container_status", {
      creationId,
      attempt,
      statusCode: statusCode || null,
    });

    if (statusCode === "FINISHED") {
      return;
    }

    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      const error = new Error(
        `Instagram could not process the image (${statusCode || "unknown"}). Check that the image URL is public HTTPS JPEG/PNG.`,
      );
      error.statusCode = 502;
      throw error;
    }

    if (attempt < maxAttempts) {
      await delay(delayMs);
    }
  }

  const error = new Error(
    "Instagram is still processing the image. Please try posting again in a minute.",
  );
  error.statusCode = 504;
  throw error;
}

/**
 * Step 1 of token exchange: trade authorization code for a short-lived user token.
 */
async function exchangeCodeForShortLivedToken(code) {
  const { appId, appSecret, redirectUri } = getFacebookConfig();

  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 15000,
    });

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      const error = new Error("Facebook did not return an access token.");
      error.statusCode = 502;
      throw error;
    }

    return {
      accessToken,
      expiresIn: response.data?.expires_in || null,
    };
  } catch (error) {
    const graphError = getGraphErrorDetails(error);
    logFbWarn("oauth.exchange_code_failed", {
      ...graphError,
      redirectUri: getFacebookConfig().redirectUri,
    });
    throw wrapGraphError(error, "Failed to exchange OAuth code for access token.");
  }
}

/**
 * Step 2 of token exchange: convert short-lived token into a long-lived user token (~60 days).
 */
async function exchangeForLongLivedToken(shortLivedToken) {
  const { appId, appSecret } = getFacebookConfig();

  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken,
      },
      timeout: 15000,
    });

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      const error = new Error("Facebook did not return a long-lived access token.");
      error.statusCode = 502;
      throw error;
    }

    return {
      accessToken,
      expiresIn: response.data?.expires_in || null,
    };
  } catch (error) {
    const graphError = getGraphErrorDetails(error);
    logFbWarn("oauth.exchange_long_lived_failed", graphError);
    throw wrapGraphError(error, "Failed to exchange for long-lived access token.");
  }
}

/**
 * Prefer long-lived token; keep short-lived if Meta rejects the exchange.
 */
async function exchangeForLongLivedTokenWithFallback(shortLivedToken, shortLivedExpiresIn = null) {
  try {
    return await exchangeForLongLivedToken(shortLivedToken);
  } catch (error) {
    logFbWarn("oauth.long_lived_fallback", {
      error: getGraphErrorMessage(error),
      usingShortLived: true,
      shortLivedExpiresIn,
    });
    return {
      accessToken: shortLivedToken,
      expiresIn: shortLivedExpiresIn,
      usedShortLivedFallback: true,
    };
  }
}

/**
 * Fetch the authenticated Facebook user id (optional metadata for storage).
 */
async function fetchFacebookUserId(userAccessToken) {
  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/me`, {
      params: {
        fields: "id,name",
        access_token: userAccessToken,
      },
      timeout: 15000,
    });

    return {
      id: response.data?.id || "",
      name: response.data?.name || "",
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to fetch Facebook user profile.");
  }
}

/**
 * Resolve Facebook user id/name from token — /me first, debug_token as fallback.
 */
async function resolveFacebookUserFromToken(userAccessToken) {
  let profileError = null;

  try {
    return await fetchFacebookUserId(userAccessToken);
  } catch (error) {
    profileError = error;
    logFbWarn("oauth.facebook_user_failed", getGraphErrorDetails(error));
  }

  const debugInfo = await debugAccessToken(userAccessToken);
  if (debugInfo?.userId) {
    logFb("oauth.facebook_user_from_debug", {
      facebookUserId: debugInfo.userId,
      isValid: debugInfo.isValid,
      scopes: debugInfo.scopes,
    });
    return {
      id: debugInfo.userId,
      name: "",
    };
  }

  const error = new Error(
    getGraphErrorMessage(profileError) || "Failed to resolve Facebook user from token.",
  );
  error.statusCode = 502;
  throw error;
}

function mapGraphPages(rawPages) {
  return rawPages.map((page) => ({
    pageId: String(page.id),
    pageName: page.name || "Unnamed Page",
    pageAccessToken: page.access_token || "",
    instagramAccount: null,
  }));
}

/**
 * Instagram Business account linked to a Facebook Page (if any).
 * Tries Page token first, then user token — some linked Pages only resolve with user token.
 */
async function fetchInstagramAccountForPage({ pageId, pageAccessToken, userAccessToken }) {
  if (!pageId) {
    return null;
  }

  const accessTokens = [pageAccessToken, userAccessToken]
    .filter((token) => typeof token === "string" && token.trim())
    .map((token) => token.trim())
    .filter((token, index, list) => list.indexOf(token) === index);

  if (!accessTokens.length) {
    return null;
  }

  let lastErrorMessage = null;

  for (const accessToken of accessTokens) {
    try {
      const response = await axios.get(`${GRAPH_BASE_URL}/${pageId}`, {
        params: {
          fields: "instagram_business_account{id,username,name}",
          access_token: accessToken,
        },
        timeout: 15000,
      });

      const ig = response.data?.instagram_business_account;
      if (!ig?.id) {
        continue;
      }

      let username = typeof ig.username === "string" ? ig.username : "";
      let name = typeof ig.name === "string" ? ig.name : "";

      if (!username) {
        try {
          const profileResponse = await axios.get(`${GRAPH_BASE_URL}/${ig.id}`, {
            params: {
              fields: "username,name",
              access_token: accessToken,
            },
            timeout: 15000,
          });
          username =
            typeof profileResponse.data?.username === "string"
              ? profileResponse.data.username
              : username;
          name =
            typeof profileResponse.data?.name === "string"
              ? profileResponse.data.name
              : name;
        } catch (profileError) {
          console.warn(
            `[Instagram] Loaded ig id for Page ${pageId} but username fetch failed:`,
            getGraphErrorMessage(profileError),
          );
        }
      }

      return {
        igUserId: String(ig.id),
        username,
        name: name || username || "",
      };
    } catch (error) {
      lastErrorMessage = getGraphErrorMessage(error);
      logFbWarn("instagram.fetch_page_failed", {
        pageId,
        token: maskToken(accessToken),
        error: lastErrorMessage,
      });
    }
  }

  if (lastErrorMessage) {
    logFbWarn("instagram.fetch_page_exhausted", {
      pageId,
      lastError: lastErrorMessage,
    });
  }

  return null;
}

function extractPageIdsFromGranularScopes(granularScopes) {
  const pageIds = new Set();

  for (const entry of Array.isArray(granularScopes) ? granularScopes : []) {
    if (typeof entry?.scope !== "string" || !entry.scope.startsWith("pages_")) {
      continue;
    }

    for (const rawId of Array.isArray(entry.target_ids) ? entry.target_ids : []) {
      if (rawId !== null && rawId !== undefined && String(rawId).trim()) {
        pageIds.add(String(rawId).trim());
      }
    }
  }

  return [...pageIds];
}

async function fetchPageById(pageId, userAccessToken) {
  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/${pageId}`, {
      params: {
        fields: "id,name,access_token",
        access_token: userAccessToken,
      },
      timeout: 15000,
    });

    const data = response.data;
    if (!data?.id || !data?.access_token) {
      return null;
    }

    return {
      pageId: String(data.id),
      pageName: data.name || "Unnamed Page",
      pageAccessToken: data.access_token,
      instagramAccount: null,
    };
  } catch (error) {
    logFbWarn("pages.fetch_by_id_failed", {
      pageId,
      error: getGraphErrorMessage(error),
    });
    return null;
  }
}

/**
 * When /me/accounts is empty but the user selected Pages on Meta's OAuth screen,
 * granular_scopes still lists Page IDs — fetch each Page directly (common for IG-linked Pages).
 */
async function fetchUserPagesFromGranularScopes(userAccessToken, debugInfo) {
  const pageIds = extractPageIdsFromGranularScopes(debugInfo?.granularScopes);
  if (!pageIds.length) {
    return [];
  }

  logFb("pages.granular_fallback_start", { pageIds });

  const pages = [];
  for (const pageId of pageIds) {
    const page = await fetchPageById(pageId, userAccessToken);
    if (page) {
      pages.push(page);
      logFb("pages.granular_fallback_hit", {
        pageId,
        pageName: page.pageName,
        hasPageToken: Boolean(page.pageAccessToken),
      });
    }
  }

  logFb("pages.granular_fallback_done", {
    requested: pageIds.length,
    loaded: pages.length,
    pages: summarizePages(pages),
  });

  return pages;
}

async function enrichPagesWithInstagram(pages, userAccessToken) {
  logFb("instagram.enrich_start", {
    pageCount: pages.length,
    pages: summarizePages(pages),
  });

  const enriched = await Promise.all(
    pages.map(async (page) => {
      const instagramAccount = await fetchInstagramAccountForPage({
        pageId: page.pageId,
        pageAccessToken: page.pageAccessToken,
        userAccessToken,
      });
      logFb("instagram.enrich_page", {
        pageId: page.pageId,
        pageName: page.pageName,
        linked: Boolean(instagramAccount?.igUserId),
        username: instagramAccount?.username || null,
      });
      return {
        ...page,
        instagramAccount,
      };
    }),
  );

  logFb("instagram.enrich_done", {
    pageCount: enriched.length,
    withInstagram: enriched.filter((p) => p.instagramAccount?.igUserId).length,
  });

  return enriched;
}

/**
 * Inspect granted scopes (and which Pages were selected on the OAuth screen).
 */
async function debugAccessToken(inputToken) {
  try {
    const { appId, appSecret } = getFacebookConfig();
    const response = await axios.get(`${GRAPH_BASE_URL}/debug_token`, {
      params: {
        input_token: inputToken,
        access_token: `${appId}|${appSecret}`,
      },
      timeout: 15000,
    });

    const data = response.data?.data;
    const debugInfo = {
      isValid: Boolean(data?.is_valid),
      userId: data?.user_id ? String(data.user_id) : null,
      scopes: Array.isArray(data?.scopes) ? data.scopes : [],
      granularScopes: Array.isArray(data?.granular_scopes) ? data.granular_scopes : [],
    };

    logFb("token.debug", {
      isValid: debugInfo.isValid,
      userId: debugInfo.userId,
      scopes: debugInfo.scopes,
      granularScopes: summarizeGranularScopes(debugInfo.granularScopes),
      pageIdsFromGranular: extractPageIdsFromGranularScopes(debugInfo.granularScopes),
      hasInstagramScopes:
        debugInfo.scopes.includes("instagram_basic") &&
        debugInfo.scopes.includes("instagram_content_publish"),
    });

    return debugInfo;
  } catch (error) {
    logFbWarn("token.debug_failed", { error: getGraphErrorMessage(error) });
    return null;
  }
}

function buildEmptyPagesHelpMessage({ facebookUser, debugInfo }) {
  const parts = [
    "No Facebook Pages were returned for this login.",
    facebookUser?.name
      ? `Facebook account: ${facebookUser.name}.`
      : "Use the Facebook profile that is Admin or Editor on your Page (not Instagram login).",
    "During Connect Facebook, on Meta's screen you must select which Page(s) to allow — check your Page and tap Continue.",
    "Confirm you are Admin on the Page at facebook.com/pages.",
  ];

  if (debugInfo) {
    const scopes = Array.isArray(debugInfo.scopes) ? debugInfo.scopes : [];

    if (!scopes.includes("pages_show_list")) {
      parts.push("Missing pages_show_list permission — reconnect and approve all permissions.");
    }

    const pageIds = extractPageIdsFromGranularScopes(debugInfo.granularScopes);
    const pagesScope = debugInfo.granularScopes.find(
      (entry) =>
        typeof entry?.scope === "string" &&
        (entry.scope === "pages_show_list" || entry.scope.startsWith("pages_")),
    );
    const targetIds = Array.isArray(pagesScope?.target_ids) ? pagesScope.target_ids : null;

    if (pagesScope && targetIds && targetIds.length === 0) {
      parts.push("You skipped Page selection on the Facebook permission screen. Reconnect and select your Page.");
    } else if (pageIds.length > 0) {
      parts.push(
        `Meta shows you selected Page ID(s) ${pageIds.join(", ")} but Page tokens could not be loaded. For Instagram-linked Pages, ensure Instagram permissions are in your Meta app configuration.`,
      );
    }
  }

  return parts.join(" ");
}

/**
 * Fetch all Pages the user manages (follows Graph API paging).
 */
async function fetchUserPagesFromAccountsEndpoint(userAccessToken) {
  const allPages = [];
  let requestUrl = `${GRAPH_BASE_URL}/me/accounts`;
  let requestParams = {
    fields: "id,name,access_token,tasks",
    access_token: userAccessToken,
    limit: 100,
  };

  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const response = await axios.get(requestUrl, {
      params: requestParams,
      timeout: 15000,
    });

    const rawPages = Array.isArray(response.data?.data) ? response.data.data : [];
    logFb("pages.me_accounts_page", {
      pageIndex,
      rawCount: rawPages.length,
      rawPageIds: rawPages.map((p) => String(p.id)),
    });
    allPages.push(...mapGraphPages(rawPages));

    const nextUrl = response.data?.paging?.next;
    if (!nextUrl || typeof nextUrl !== "string") {
      break;
    }

    requestUrl = nextUrl;
    requestParams = undefined;
  }

  logFb("pages.me_accounts_done", { total: allPages.length, pages: summarizePages(allPages) });
  return allPages;
}

async function fetchUserPagesFromMeField(userAccessToken) {
  const response = await axios.get(`${GRAPH_BASE_URL}/me`, {
    params: {
      fields: "accounts.limit(100){id,name,access_token}",
      access_token: userAccessToken,
    },
    timeout: 15000,
  });

  const rawPages = Array.isArray(response.data?.accounts?.data)
    ? response.data.accounts.data
    : [];
  const pages = mapGraphPages(rawPages);
  logFb("pages.me_field_done", {
    total: pages.length,
    pages: summarizePages(pages),
  });
  return pages;
}

/**
 * Fetch all Pages the user manages (follows Graph API paging).
 */
async function fetchUserPages(userAccessToken) {
  logFb("pages.fetch_start", { userToken: maskToken(userAccessToken) });

  let allPages = [];
  let source = "none";
  let lastError = null;

  try {
    allPages = await fetchUserPagesFromAccountsEndpoint(userAccessToken);
    source = "me/accounts";
  } catch (error) {
    lastError = error;
    logFbWarn("pages.me_accounts_failed", { error: getGraphErrorMessage(error) });
  }

  if (!allPages.length) {
    try {
      logFbWarn("pages.me_accounts_empty", { trying: "me?fields=accounts" });
      allPages = await fetchUserPagesFromMeField(userAccessToken);
      source = "me.accounts";
    } catch (error) {
      lastError = error;
      logFbWarn("pages.me_field_failed", { error: getGraphErrorMessage(error) });
    }
  }

  if (!allPages.length) {
    try {
      logFbWarn("pages.me_field_empty", { trying: "granular_scopes" });
      const debugInfo = await debugAccessToken(userAccessToken);
      allPages = await fetchUserPagesFromGranularScopes(userAccessToken, debugInfo);
      source = "granular_scopes";
    } catch (error) {
      lastError = error;
      logFbWarn("pages.granular_failed", { error: getGraphErrorMessage(error) });
    }
  }

  if (!allPages.length && lastError) {
    logFbWarn("pages.fetch_all_failed", {
      error: getGraphErrorMessage(lastError),
      code: lastError?.response?.data?.error?.code || null,
    });
  }

  logFb("pages.fetch_done", {
    source,
    total: allPages.length,
    pages: summarizePages(allPages),
  });

  return allPages;
}

/**
 * Post an image to a Facebook Page as an organic photo.
 *
 * - No caption: direct POST /photos (published).
 * - With caption/link: upload unpublished photo, then POST /feed with
 *   message + attached_media so the text (including product URL) actually
 *   shows on the Page post. Never use /feed?link= (that becomes a link card).
 */
async function postImageToPage({
  pageId,
  pageAccessToken,
  imageUrl,
  caption,
}) {
  const message = typeof caption === "string" ? caption.trim() : "";
  const photoUrl = String(imageUrl || "").trim();

  try {
    if (!message) {
      const form = new URLSearchParams();
      form.set("url", photoUrl);
      form.set("access_token", pageAccessToken);

      logFb("facebook.photo_post_request", {
        pageId,
        mode: "photos_only",
        imageUrl: photoUrl.slice(0, 120),
        captionLength: 0,
      });

      const response = await axios.post(
        `${GRAPH_BASE_URL}/${pageId}/photos`,
        form.toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 60000,
        },
      );
      return {
        postId: response.data?.post_id || response.data?.id || null,
        photoId: response.data?.id || null,
        format: "photo",
        caption: null,
        raw: response.data,
      };
    }

    // 1) Upload photo unpublished so we can attach it to a feed post with message.
    const uploadForm = new URLSearchParams();
    uploadForm.set("url", photoUrl);
    uploadForm.set("published", "false");
    uploadForm.set("access_token", pageAccessToken);

    const uploadResponse = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/photos`,
      uploadForm.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
      },
    );

    const photoId =
      uploadResponse.data?.id || uploadResponse.data?.photo_id || null;
    if (!photoId) {
      const error = new Error("Facebook did not return a photo id.");
      error.statusCode = 502;
      throw error;
    }

    // 2) Create Page post with image + message text (product URL lives here).
    const feedForm = new URLSearchParams();
    feedForm.set("message", message);
    feedForm.set(
      "attached_media[0]",
      JSON.stringify({ media_fbid: String(photoId) }),
    );
    feedForm.set("access_token", pageAccessToken);

    logFb("facebook.photo_post_request", {
      pageId,
      mode: "photo_with_message",
      imageUrl: photoUrl.slice(0, 120),
      photoId: String(photoId),
      captionLength: message.length,
      captionPreview: message.slice(0, 160),
    });

    const feedResponse = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/feed`,
      feedForm.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
      },
    );

    return {
      postId: feedResponse.data?.id || feedResponse.data?.post_id || null,
      photoId: String(photoId),
      format: "photo_with_message",
      caption: message,
      raw: {
        photo: uploadResponse.data,
        feed: feedResponse.data,
      },
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post image to Facebook Page.");
  }
}

/**
 * Free Amazon-style organic link card (no Ads Manager).
 * POST /{page-id}/feed with link + message + optional SHOP_NOW CTA.
 * Tap opens the product URL. No ad account / billing required.
 */
async function postLinkCardToPage({
  pageId,
  pageAccessToken,
  link,
  message = "",
  name = "",
  description = "",
  imageUrl = "",
  ctaType = "SHOP_NOW",
}) {
  const normalizedLink = String(link || "").trim();
  if (!normalizedLink) {
    const error = new Error("link is required for a Facebook link card post.");
    error.statusCode = 400;
    throw error;
  }

  let finalLink = normalizedLink;
  if (!/^https?:\/\//i.test(finalLink)) {
    finalLink = `https://${finalLink}`;
  }
  try {
    const parsed = new URL(finalLink);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const error = new Error("link must be http(s).");
      error.statusCode = 400;
      throw error;
    }
    finalLink = parsed.toString();
  } catch (error) {
    if (error.statusCode) throw error;
    const err = new Error("link must be a valid URL.");
    err.statusCode = 400;
    throw err;
  }

  const caption = typeof message === "string" ? message.trim() : "";
  const linkName = typeof name === "string" ? name.trim() : "";
  const linkDescription =
    typeof description === "string" ? description.trim() : "";
  const picture = String(imageUrl || "").trim();

  async function postOnce(withCta) {
    const form = new URLSearchParams();
    form.set("link", finalLink);
    if (caption) {
      form.set("message", caption);
    }
    if (linkName) {
      form.set("name", linkName);
    }
    if (linkDescription) {
      form.set("description", linkDescription);
    }
    // Soft override; OG scrape of link usually wins (we point link at our OG card).
    if (picture && /^https?:\/\//i.test(picture)) {
      form.set("picture", picture);
    }
    if (withCta && ctaType) {
      form.set(
        "call_to_action",
        JSON.stringify({
          type: ctaType,
          value: { link: finalLink },
        }),
      );
    }
    form.set("access_token", pageAccessToken);

    logFb("facebook.link_card_request", {
      pageId,
      withCta: Boolean(withCta),
      ctaType: withCta ? ctaType : null,
      link: finalLink.slice(0, 160),
      hasPicture: Boolean(picture),
      hasName: Boolean(linkName),
      captionLength: caption.length,
    });

    const response = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/feed`,
      form.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
      },
    );

    return {
      postId: response.data?.id || response.data?.post_id || null,
      photoId: null,
      format: withCta ? "organic_link_card_cta" : "organic_link_card",
      caption: caption || null,
      shareLink: finalLink,
      raw: response.data,
    };
  }

  try {
    try {
      return await postOnce(true);
    } catch (ctaError) {
      logFbWarn("facebook.link_card_cta_failed", {
        pageId,
        reason: getGraphErrorDetails(ctaError)?.message || String(ctaError?.message || ctaError),
      });
      return await postOnce(false);
    }
  } catch (error) {
    throw wrapGraphError(error, "Failed to post organic link card to Facebook Page.");
  }
}

/**
 * List recent posts on a Facebook Page (requires pages_read_engagement on token).
 */
async function listPagePosts({ pageId, pageAccessToken, limit = 25 }) {
  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/${pageId}/posts`, {
      params: {
        fields: "id,message,created_time,full_picture,permalink_url,status_type",
        access_token: pageAccessToken,
        limit: Math.min(Math.max(Number(limit) || 25, 1), 50),
      },
      timeout: 30000,
    });

    const rows = Array.isArray(response.data?.data) ? response.data.data : [];

    return {
      posts: rows.map((row) => ({
        id: String(row.id || ""),
        message: typeof row.message === "string" ? row.message : "",
        createdTime: row.created_time || null,
        imageUrl: typeof row.full_picture === "string" ? row.full_picture : null,
        permalinkUrl: typeof row.permalink_url === "string" ? row.permalink_url : null,
        statusType: typeof row.status_type === "string" ? row.status_type : null,
      })),
      paging: response.data?.paging || null,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to list Facebook Page posts.");
  }
}

/**
 * Delete a post from a Facebook Page (requires pages_manage_posts on token).
 */
async function deletePagePost({ postId, pageAccessToken }) {
  try {
    const response = await axios.delete(`${GRAPH_BASE_URL}/${postId}`, {
      params: {
        access_token: pageAccessToken,
      },
      timeout: 30000,
    });

    return {
      deleted: response.data?.success === true,
      raw: response.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to delete Facebook Page post.");
  }
}

/**
 * Update caption/message on a Facebook Page post (requires pages_manage_posts).
 */
async function updatePagePost({ postId, pageAccessToken, message }) {
  if (!postId || !pageAccessToken) {
    const error = new Error("postId and pageAccessToken are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const response = await axios.post(`${GRAPH_BASE_URL}/${postId}`, null, {
      params: {
        message: typeof message === "string" ? message : "",
        access_token: pageAccessToken,
      },
      timeout: 30000,
    });

    return {
      updated: response.data?.success !== false,
      raw: response.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to update Facebook Page post.");
  }
}

/**
 * List recent Instagram media for a linked Business/Creator account.
 */
async function listInstagramMedia({ igUserId, pageAccessToken, limit = 25 }) {
  if (!igUserId || !pageAccessToken) {
    const error = new Error("igUserId and pageAccessToken are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/${igUserId}/media`, {
      params: {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
        access_token: pageAccessToken,
        limit: Math.min(Math.max(Number(limit) || 25, 1), 50),
      },
      timeout: 30000,
    });

    const rows = Array.isArray(response.data?.data) ? response.data.data : [];

    return {
      posts: rows.map((row) => ({
        id: String(row.id || ""),
        caption: typeof row.caption === "string" ? row.caption : "",
        mediaType: typeof row.media_type === "string" ? row.media_type : null,
        imageUrl:
          typeof row.media_url === "string"
            ? row.media_url
            : typeof row.thumbnail_url === "string"
              ? row.thumbnail_url
              : null,
        permalinkUrl: typeof row.permalink === "string" ? row.permalink : null,
        createdTime: row.timestamp || null,
      })),
      paging: response.data?.paging || null,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to list Instagram posts.");
  }
}

/**
 * Delete a published Instagram media item.
 */
async function deleteInstagramMedia({ mediaId, pageAccessToken }) {
  if (!mediaId || !pageAccessToken) {
    const error = new Error("mediaId and pageAccessToken are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const response = await axios.delete(`${GRAPH_BASE_URL}/${mediaId}`, {
      params: {
        access_token: pageAccessToken,
      },
      timeout: 30000,
    });

    return {
      deleted: response.data?.success === true,
      raw: response.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to delete Instagram post.");
  }
}

/**
 * Publish a photo as a Facebook Page Story (24h).
 * 1) Upload unpublished photo via /{page-id}/photos
 * 2) Publish via /{page-id}/photo_stories
 */
async function postPhotoStoryToPage({ pageId, pageAccessToken, imageUrl }) {
  if (!pageId || !pageAccessToken || !imageUrl) {
    const error = new Error("pageId, pageAccessToken, and imageUrl are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const uploadResponse = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/photos`,
      null,
      {
        params: {
          url: imageUrl,
          published: false,
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    const photoId = uploadResponse.data?.id || uploadResponse.data?.photo_id || null;
    if (!photoId) {
      const error = new Error("Facebook did not return a photo_id for the story upload.");
      error.statusCode = 502;
      throw error;
    }

    const storyResponse = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/photo_stories`,
      null,
      {
        params: {
          photo_id: photoId,
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    return {
      postId: storyResponse.data?.post_id || storyResponse.data?.id || null,
      photoId: String(photoId),
      success: storyResponse.data?.success !== false,
      raw: storyResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post photo story to Facebook Page.");
  }
}

/**
 * Publish an image to Instagram (Business/Creator linked to the Facebook Page).
 * Uses the Page access token.
 */
async function postImageToInstagram({ igUserId, pageAccessToken, imageUrl, caption }) {
  if (!igUserId || !pageAccessToken || !imageUrl) {
    const error = new Error("igUserId, pageAccessToken, and imageUrl are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const createResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media`,
      null,
      {
        params: {
          image_url: imageUrl,
          caption: caption || "",
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    const creationId = createResponse.data?.id;
    if (!creationId) {
      const error = new Error("Instagram did not return a media container id.");
      error.statusCode = 502;
      throw error;
    }

    await waitForInstagramMediaContainer(creationId, pageAccessToken);

    const publishResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    const mediaId =
      publishResponse.data?.id ||
      publishResponse.data?.media_id ||
      publishResponse.data?.post_id ||
      null;

    if (!mediaId) {
      logFbWarn("instagram.publish_missing_media_id", {
        igUserId,
        creationId: String(creationId),
        response: publishResponse.data || null,
      });
    }

    return {
      mediaId: mediaId ? String(mediaId) : null,
      creationId: String(creationId),
      raw: publishResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post image to Instagram.");
  }
}

/**
 * Publish an image as an Instagram Story (media_type=STORIES).
 * Captions are not supported on Stories via the Content Publishing API.
 */
async function postImageStoryToInstagram({ igUserId, pageAccessToken, imageUrl }) {
  if (!igUserId || !pageAccessToken || !imageUrl) {
    const error = new Error("igUserId, pageAccessToken, and imageUrl are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const createResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media`,
      null,
      {
        params: {
          image_url: imageUrl,
          media_type: "STORIES",
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    const creationId = createResponse.data?.id;
    if (!creationId) {
      const error = new Error("Instagram did not return a Stories media container id.");
      error.statusCode = 502;
      throw error;
    }

    await waitForInstagramMediaContainer(creationId, pageAccessToken);

    const publishResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    const mediaId =
      publishResponse.data?.id ||
      publishResponse.data?.media_id ||
      publishResponse.data?.post_id ||
      null;

    return {
      mediaId: mediaId ? String(mediaId) : null,
      creationId: String(creationId),
      raw: publishResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post image story to Instagram.");
  }
}

async function postVideoToPage({
  pageId,
  pageAccessToken,
  videoUrl,
  caption,
}) {
  if (!pageId || !pageAccessToken || !videoUrl) {
    const error = new Error("pageId, pageAccessToken, and videoUrl are required.");
    error.statusCode = 400;
    throw error;
  }

  const message = typeof caption === "string" ? caption.trim() : "";

  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/videos`,
      null,
      {
        params: {
          file_url: videoUrl,
          description: message,
          access_token: pageAccessToken,
        },
        timeout: 120000,
      },
    );

    return {
      postId: response.data?.id || response.data?.post_id || null,
      format: "video",
      raw: response.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post video to Facebook Page.");
  }
}

/**
 * Publish a reel to Instagram (Business/Creator linked to the Facebook Page).
 */
async function postReelToInstagram({ igUserId, pageAccessToken, videoUrl, caption }) {
  if (!igUserId || !pageAccessToken || !videoUrl) {
    const error = new Error("igUserId, pageAccessToken, and videoUrl are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const createResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media`,
      null,
      {
        params: {
          media_type: "REELS",
          video_url: videoUrl,
          caption: caption || "",
          share_to_feed: true,
          access_token: pageAccessToken,
        },
        timeout: 120000,
      },
    );

    const creationId = createResponse.data?.id;
    if (!creationId) {
      const error = new Error("Instagram did not return a reel container id.");
      error.statusCode = 502;
      throw error;
    }

    await waitForInstagramMediaContainer(creationId, pageAccessToken, {
      maxAttempts: 30,
      delayMs: 3000,
    });

    const publishResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: pageAccessToken,
        },
        timeout: 120000,
      },
    );

    const mediaId =
      publishResponse.data?.id ||
      publishResponse.data?.media_id ||
      publishResponse.data?.post_id ||
      null;

    if (!mediaId) {
      logFbWarn("instagram.publish_missing_media_id", {
        igUserId,
        creationId: String(creationId),
        response: publishResponse.data || null,
      });
    }

    return {
      mediaId: mediaId ? String(mediaId) : null,
      creationId: String(creationId),
      raw: publishResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post reel to Instagram.");
  }
}

/**
 * Publish a multi-image carousel to Instagram.
 */
async function postCarouselToInstagram({
  igUserId,
  pageAccessToken,
  imageUrls,
  caption = "",
}) {
  if (!igUserId || !pageAccessToken) {
    const error = new Error("igUserId and pageAccessToken are required.");
    error.statusCode = 400;
    throw error;
  }

  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (urls.length < 2) {
    const error = new Error("Instagram carousel needs at least 2 public image URLs.");
    error.statusCode = 400;
    throw error;
  }

  if (urls.length > 10) {
    const error = new Error("Instagram carousel supports a maximum of 10 images.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const childIds = [];
    for (const imageUrl of urls) {
      const createResponse = await axios.post(
        `${GRAPH_BASE_URL}/${igUserId}/media`,
        null,
        {
          params: {
            image_url: imageUrl,
            is_carousel_item: true,
            access_token: pageAccessToken,
          },
          timeout: 60000,
        },
      );
      const creationId = createResponse.data?.id;
      if (!creationId) {
        const error = new Error("Instagram did not return a carousel item id.");
        error.statusCode = 502;
        throw error;
      }
      await waitForInstagramMediaContainer(creationId, pageAccessToken);
      childIds.push(String(creationId));
    }

    const carouselResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media`,
      null,
      {
        params: {
          media_type: "CAROUSEL",
          children: childIds.join(","),
          caption: caption || "",
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    const carouselId = carouselResponse.data?.id;
    if (!carouselId) {
      const error = new Error("Instagram did not return a carousel container id.");
      error.statusCode = 502;
      throw error;
    }

    await waitForInstagramMediaContainer(carouselId, pageAccessToken);

    const publishResponse = await axios.post(
      `${GRAPH_BASE_URL}/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: carouselId,
          access_token: pageAccessToken,
        },
        timeout: 60000,
      },
    );

    return {
      mediaId:
        publishResponse.data?.id ||
        publishResponse.data?.media_id ||
        null,
      creationId: String(carouselId),
      childIds,
      raw: publishResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post carousel to Instagram.");
  }
}

/**
 * Publish multiple photos as one Facebook Page feed post.
 */
async function postMultiPhotoToPage({
  pageId,
  pageAccessToken,
  imageUrls,
  caption = "",
}) {
  if (!pageId || !pageAccessToken) {
    const error = new Error("pageId and pageAccessToken are required.");
    error.statusCode = 400;
    throw error;
  }

  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (urls.length < 2) {
    const error = new Error("Facebook multi-photo post needs at least 2 image URLs.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const photoIds = [];
    for (const imageUrl of urls) {
      const uploadResponse = await axios.post(
        `${GRAPH_BASE_URL}/${pageId}/photos`,
        null,
        {
          params: {
            url: imageUrl,
            published: false,
            access_token: pageAccessToken,
          },
          timeout: 60000,
        },
      );
      const photoId = uploadResponse.data?.id || uploadResponse.data?.photo_id;
      if (!photoId) {
        const error = new Error("Facebook did not return a photo id for carousel upload.");
        error.statusCode = 502;
        throw error;
      }
      photoIds.push(String(photoId));
    }

    const params = new URLSearchParams();
    params.append("message", caption || "");
    params.append("access_token", pageAccessToken);
    photoIds.forEach((photoId, index) => {
      params.append(
        `attached_media[${index}]`,
        JSON.stringify({ media_fbid: photoId }),
      );
    });

    const feedResponse = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/feed`,
      params,
      { timeout: 60000 },
    );

    return {
      postId: feedResponse.data?.id || feedResponse.data?.post_id || null,
      photoIds,
      raw: feedResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post multi-photo carousel to Facebook Page.");
  }
}

module.exports = {
  FACEBOOK_SCOPES,
  FACEBOOK_INSTAGRAM_SCOPES,
  buildOAuthScopes,
  getFacebookLoginConfigId,
  getInstagramLoginConfigId,
  resolveOAuthAuthParams,
  getFacebookConfig,
  buildFacebookOAuthUrl,
  createOAuthState,
  createSessionId,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  exchangeForLongLivedTokenWithFallback,
  fetchFacebookUserId,
  resolveFacebookUserFromToken,
  getGraphErrorDetails,
  fetchUserPages,
  enrichPagesWithInstagram,
  fetchInstagramAccountForPage,
  postImageToPage,
  postLinkCardToPage,
  postPhotoStoryToPage,
  postImageToInstagram,
  postImageStoryToInstagram,
  postCarouselToInstagram,
  postVideoToPage,
  postReelToInstagram,
  postMultiPhotoToPage,
  listPagePosts,
  deletePagePost,
  updatePagePost,
  listInstagramMedia,
  deleteInstagramMedia,
  debugAccessToken,
  buildEmptyPagesHelpMessage,
  extractPageIdsFromGranularScopes,
  fetchPageById,
};
