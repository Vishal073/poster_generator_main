const axios = require("axios");
const crypto = require("crypto");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Default scopes for Page posting. Override via FACEBOOK_SCOPES in .env if Meta shows "Invalid Scopes".
// Dev test example: FACEBOOK_SCOPES=pages_show_list
const FACEBOOK_SCOPES = (
  process.env.FACEBOOK_SCOPES ||
  [
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
  ].join(",")
).trim();

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
 */
function buildFacebookOAuthUrl(state, options = {}) {
  const { appId, redirectUri } = getFacebookConfig();
  const useMobile = Boolean(options.mobile);
  const reconnect = Boolean(options.reconnect);

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: FACEBOOK_SCOPES,
    response_type: "code",
  });

  if (useMobile) {
    params.set("display", "touch");
  }

  // Ask Facebook to show login/permissions again (switch account or refresh Page list)
  if (reconnect) {
    params.set("auth_type", "rerequest");
  }

  const host = useMobile ? "m.facebook.com" : "www.facebook.com";
  return `https://${host}/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
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

function wrapGraphError(error, fallbackMessage) {
  const wrapped = new Error(getGraphErrorMessage(error) || fallbackMessage);
  wrapped.statusCode = error?.response?.status || 502;
  wrapped.details = error?.response?.data || null;
  return wrapped;
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
    throw wrapGraphError(error, "Failed to exchange for long-lived access token.");
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

function mapGraphPages(rawPages) {
  return rawPages.map((page) => ({
    pageId: String(page.id),
    pageName: page.name || "Unnamed Page",
    pageAccessToken: page.access_token || "",
  }));
}

/**
 * Fetch all Pages the user manages (follows Graph API paging).
 */
async function fetchUserPages(userAccessToken) {
  const allPages = [];
  let requestUrl = `${GRAPH_BASE_URL}/me/accounts`;
  let requestParams = {
    fields: "id,name,access_token",
    access_token: userAccessToken,
    limit: 100,
  };

  try {
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const response = await axios.get(requestUrl, {
        params: requestParams,
        timeout: 15000,
      });

      const rawPages = Array.isArray(response.data?.data) ? response.data.data : [];
      allPages.push(...mapGraphPages(rawPages));

      const nextUrl = response.data?.paging?.next;
      if (!nextUrl || typeof nextUrl !== "string") {
        break;
      }

      requestUrl = nextUrl;
      requestParams = undefined;
    }

    return allPages;
  } catch (error) {
    throw wrapGraphError(error, "Failed to fetch Facebook Pages.");
  }
}

/**
 * Post an image to a Facebook Page feed using the Page access token.
 */
async function postImageToPage({ pageId, pageAccessToken, imageUrl, caption }) {
  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/photos`,
      null,
      {
        params: {
          url: imageUrl,
          caption: caption || "",
          access_token: pageAccessToken,
        },
        timeout: 30000,
      },
    );

    return {
      postId: response.data?.id || response.data?.post_id || null,
      raw: response.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post image to Facebook Page.");
  }
}

module.exports = {
  FACEBOOK_SCOPES,
  getFacebookConfig,
  buildFacebookOAuthUrl,
  createOAuthState,
  createSessionId,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchFacebookUserId,
  fetchUserPages,
  postImageToPage,
};
