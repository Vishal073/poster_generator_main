/**
 * Structured Facebook OAuth logs for Render (grep: FB-DEBUG).
 * Never log full access tokens.
 */

function maskToken(token) {
  if (typeof token !== "string" || !token.trim()) {
    return null;
  }
  const value = token.trim();
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function summarizePages(pages) {
  return (Array.isArray(pages) ? pages : []).map((page) => ({
    pageId: page?.pageId || page?.id || null,
    pageName: page?.pageName || page?.name || null,
    hasPageToken: Boolean(page?.pageAccessToken || page?.access_token),
    instagramUsername: page?.instagramAccount?.username || null,
    instagramIgUserId: page?.instagramAccount?.igUserId || null,
  }));
}

function summarizeGranularScopes(granularScopes) {
  return (Array.isArray(granularScopes) ? granularScopes : []).map((entry) => ({
    scope: entry?.scope || null,
    target_ids: Array.isArray(entry?.target_ids) ? entry.target_ids.map(String) : [],
  }));
}

function logFb(step, details = {}) {
  const payload = {
    step,
    at: new Date().toISOString(),
    ...details,
  };
  console.info("[FB-DEBUG]", JSON.stringify(payload));
}

function logFbWarn(step, details = {}) {
  const payload = {
    step,
    at: new Date().toISOString(),
    ...details,
  };
  console.warn("[FB-DEBUG]", JSON.stringify(payload));
}

function logFbError(step, error, details = {}) {
  const payload = {
    step,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    ...details,
  };
  console.error("[FB-DEBUG]", JSON.stringify(payload));
}

module.exports = {
  logFb,
  logFbWarn,
  logFbError,
  maskToken,
  summarizePages,
  summarizeGranularScopes,
};
