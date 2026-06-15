const axios = require("axios");
const crypto = require("crypto");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Default scopes for Page posting. Override via FACEBOOK_SCOPES in .env if needed.
// pages_read_engagement is required by Meta for /photos and App Review with pages_manage_posts.
const FACEBOOK_SCOPES = (
  process.env.FACEBOOK_SCOPES ||
  [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "instagram_basic",
    "instagram_content_publish",
  ].join(",")
).trim();

function getFacebookLoginConfigId() {
  const raw = process.env.FACEBOOK_LOGIN_CONFIG_ID;
  return typeof raw === "string" ? raw.trim() : "";
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
 */
function buildFacebookOAuthUrl(state, options = {}) {
  const { appId, redirectUri } = getFacebookConfig();
  const useMobile = Boolean(options.mobile);
  const reconnect = Boolean(options.reconnect);
  const configId = getFacebookLoginConfigId();

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
    params.set("scope", FACEBOOK_SCOPES);
  }

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
      console.warn(
        `[Instagram] Could not load linked account for Page ${pageId}:`,
        lastErrorMessage,
      );
    }
  }

  if (lastErrorMessage) {
    console.warn(
      `[Instagram] No linked account for Page ${pageId} after token attempts. Last error: ${lastErrorMessage}`,
    );
  }

  return null;
}

async function enrichPagesWithInstagram(pages, userAccessToken) {
  return Promise.all(
    pages.map(async (page) => {
      const instagramAccount = await fetchInstagramAccountForPage({
        pageId: page.pageId,
        pageAccessToken: page.pageAccessToken,
        userAccessToken,
      });
      return {
        ...page,
        instagramAccount,
      };
    }),
  );
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
    return {
      isValid: Boolean(data?.is_valid),
      userId: data?.user_id ? String(data.user_id) : null,
      scopes: Array.isArray(data?.scopes) ? data.scopes : [],
      granularScopes: Array.isArray(data?.granular_scopes) ? data.granular_scopes : [],
    };
  } catch (error) {
    console.warn("[Facebook OAuth] debug_token failed:", getGraphErrorMessage(error));
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
    if (!debugInfo.scopes.includes("pages_show_list")) {
      parts.push("Missing pages_show_list permission — reconnect and approve all permissions.");
    }

    const pagesScope = debugInfo.granularScopes.find(
      (entry) =>
        typeof entry?.scope === "string" &&
        (entry.scope === "pages_show_list" || entry.scope.startsWith("pages_")),
    );
    const targetIds = Array.isArray(pagesScope?.target_ids) ? pagesScope.target_ids : null;
    if (pagesScope && targetIds && targetIds.length === 0) {
      parts.push("You skipped Page selection on the Facebook permission screen. Reconnect and select your Page.");
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
    allPages.push(...mapGraphPages(rawPages));

    const nextUrl = response.data?.paging?.next;
    if (!nextUrl || typeof nextUrl !== "string") {
      break;
    }

    requestUrl = nextUrl;
    requestParams = undefined;
  }

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
  return mapGraphPages(rawPages);
}

/**
 * Fetch all Pages the user manages (follows Graph API paging).
 */
async function fetchUserPages(userAccessToken) {
  try {
    let allPages = await fetchUserPagesFromAccountsEndpoint(userAccessToken);
    if (!allPages.length) {
      allPages = await fetchUserPagesFromMeField(userAccessToken);
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

    return {
      mediaId: publishResponse.data?.id || null,
      creationId: String(creationId),
      raw: publishResponse.data,
    };
  } catch (error) {
    throw wrapGraphError(error, "Failed to post image to Instagram.");
  }
}

module.exports = {
  FACEBOOK_SCOPES,
  getFacebookLoginConfigId,
  getFacebookConfig,
  buildFacebookOAuthUrl,
  createOAuthState,
  createSessionId,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchFacebookUserId,
  fetchUserPages,
  enrichPagesWithInstagram,
  fetchInstagramAccountForPage,
  postImageToPage,
  postImageToInstagram,
  listPagePosts,
  deletePagePost,
  debugAccessToken,
  buildEmptyPagesHelpMessage,
};
