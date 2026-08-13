const FacebookConnection = require("../models/FacebookConnection");
const {
  hydrateConnectionTokens,
  refreshConnectionUserToken,
  REFRESH_BEFORE_EXPIRY_MS,
} = require("../utils/facebookConnectionTokens");
const { logFb, logFbWarn } = require("./facebookDebugLog");

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshExpiringFacebookTokens() {
  const cutoff = new Date(Date.now() + REFRESH_BEFORE_EXPIRY_MS);

  const connections = await FacebookConnection.find({
    userAccessToken: { $exists: true, $ne: "" },
    $or: [
      { userTokenExpiresAt: { $exists: false } },
      { userTokenExpiresAt: null },
      { userTokenExpiresAt: { $lte: cutoff } },
    ],
  })
    .select("_id userId userAccessToken userTokenExpiresAt includeInstagramPermissions selectedPage pages")
    .lean();

  if (!connections.length) {
    return { checked: 0, refreshed: 0, failed: 0 };
  }

  let refreshed = 0;
  let failed = 0;

  for (const connection of connections) {
    try {
      const hydrated = hydrateConnectionTokens(connection);
      const before = hydrated.userAccessToken;
      const afterConnection = await refreshConnectionUserToken(hydrated, {
        save: true,
        syncPages: true,
      });

      if (afterConnection?.userAccessToken && afterConnection.userAccessToken !== before) {
        refreshed += 1;
      }
    } catch (error) {
      failed += 1;
      logFbWarn("oauth.token_refresh_job_failed", {
        userId: connection.userId ? String(connection.userId) : null,
        error: error.message,
      });
    }
  }

  logFb("oauth.token_refresh_job_done", {
    checked: connections.length,
    refreshed,
    failed,
  });

  return { checked: connections.length, refreshed, failed };
}

function startFacebookTokenRefreshJob(options = {}) {
  const intervalMs = Number(options.intervalMs) || DEFAULT_INTERVAL_MS;

  const run = () => {
    refreshExpiringFacebookTokens().catch((error) => {
      logFbWarn("oauth.token_refresh_job_error", { error: error.message });
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return timer;
}

module.exports = {
  refreshExpiringFacebookTokens,
  startFacebookTokenRefreshJob,
};
