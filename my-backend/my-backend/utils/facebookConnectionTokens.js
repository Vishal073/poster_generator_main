const FacebookConnection = require("../models/FacebookConnection");
const {
  hydrateConnectionTokens,
  sealConnectionTokens,
} = require("./facebookConnectionTokenFields");
const {
  exchangeForLongLivedToken,
  fetchUserPages,
  enrichPagesWithInstagram,
} = require("../services/facebookService");
const { logFb, logFbWarn } = require("../services/facebookDebugLog");

const DEFAULT_USER_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const REFRESH_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function computeUserTokenExpiresAt(expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  const ttlMs =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : DEFAULT_USER_TOKEN_TTL_MS;
  return new Date(Date.now() + ttlMs);
}

function shouldRefreshUserToken(userTokenExpiresAt) {
  if (!userTokenExpiresAt) {
    return true;
  }

  const expiresAtMs = new Date(userTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return true;
  }

  return expiresAtMs - Date.now() <= REFRESH_BEFORE_EXPIRY_MS;
}

async function refreshConnectionUserToken(connection, options = {}) {
  const hydrated = hydrateConnectionTokens(connection);
  if (!hydrated?.userAccessToken) {
    return hydrated;
  }

  if (!shouldRefreshUserToken(hydrated.userTokenExpiresAt)) {
    return hydrated;
  }

  try {
    const refreshed = await exchangeForLongLivedToken(hydrated.userAccessToken);
    hydrated.userAccessToken = refreshed.accessToken;
    hydrated.userTokenExpiresAt = computeUserTokenExpiresAt(refreshed.expiresIn);

    if (options.syncPages !== false && connection?.userId) {
      const rawPages = await fetchUserPages(hydrated.userAccessToken);
      let pages = rawPages;
      if (hydrated.includeInstagramPermissions) {
        pages = await enrichPagesWithInstagram(rawPages, hydrated.userAccessToken);
      }
      hydrated.pages = pages;

      if (hydrated.selectedPage?.pageId) {
        const refreshedSelected = pages.find(
          (page) => page.pageId === hydrated.selectedPage.pageId,
        );
        if (refreshedSelected) {
          hydrated.selectedPage = refreshedSelected;
        }
      }
    }

    if (options.save !== false && connection?.userId) {
      const sealed = sealConnectionTokens({
        userAccessToken: hydrated.userAccessToken,
        userTokenExpiresAt: hydrated.userTokenExpiresAt,
        pages: hydrated.pages,
        selectedPage: hydrated.selectedPage,
      });

      await FacebookConnection.updateOne(
        { userId: connection.userId },
        { $set: sealed },
      );

      logFb("oauth.token_refreshed", {
        userId: String(connection.userId),
        expiresAt: hydrated.userTokenExpiresAt.toISOString(),
      });
    }

    return hydrated;
  } catch (error) {
    logFbWarn("oauth.token_refresh_failed", {
      userId: connection?.userId ? String(connection.userId) : null,
      error: error.message,
    });
    return hydrated;
  }
}

async function loadDecryptedConnection(filter, options = {}) {
  const connection = await FacebookConnection.findOne(filter);
  if (!connection) {
    return null;
  }

  if (options.refresh !== false) {
    const refreshed = await refreshConnectionUserToken(connection, {
      save: true,
      syncPages: false,
    });
    connection.userAccessToken = refreshed.userAccessToken;
    connection.userTokenExpiresAt = refreshed.userTokenExpiresAt;
    if (Array.isArray(refreshed.pages)) {
      connection.pages = refreshed.pages;
    }
    if (refreshed.selectedPage) {
      connection.selectedPage = refreshed.selectedPage;
    }
  }

  return connection;
}

async function loadDecryptedConnectionLean(filter, options = {}) {
  const connection = await FacebookConnection.findOne(filter).lean();
  if (!connection) {
    return null;
  }

  const hydrated = hydrateConnectionTokens(connection);

  if (options.refresh === false) {
    return hydrated;
  }

  return refreshConnectionUserToken(hydrated, {
    save: true,
    syncPages: false,
  });
}

module.exports = {
  computeUserTokenExpiresAt,
  shouldRefreshUserToken,
  hydrateConnectionTokens,
  sealConnectionTokens,
  refreshConnectionUserToken,
  loadDecryptedConnection,
  loadDecryptedConnectionLean,
  REFRESH_BEFORE_EXPIRY_MS,
};
