const axios = require("axios");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function getGraphErrorMessage(error) {
  const fb = error?.response?.data?.error;
  if (fb && typeof fb === "object") {
    const parts = [
      fb.error_user_msg,
      fb.error_user_title,
      fb.message,
      fb.code != null ? `code ${fb.code}` : null,
      fb.error_subcode != null ? `subcode ${fb.error_subcode}` : null,
    ].filter(Boolean);
    if (parts.length) {
      return parts.join(" — ");
    }
  }
  return error?.message || String(error);
}

function wrapAdsError(error, fallback) {
  const err = new Error(getGraphErrorMessage(error) || fallback);
  err.statusCode = error?.response?.status || 502;
  err.facebook = error?.response?.data?.error || null;
  err.cause = error;
  return err;
}

function normalizeAdAccountId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function normalizeHttpUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getAdsAccessToken(fallbackUserToken = "") {
  const fromEnv =
    typeof process.env.FACEBOOK_ADS_ACCESS_TOKEN === "string"
      ? process.env.FACEBOOK_ADS_ACCESS_TOKEN.trim()
      : "";
  if (fromEnv) {
    return { token: fromEnv, source: "env_system_user" };
  }
  const userToken = String(fallbackUserToken || "").trim();
  if (userToken) {
    return { token: userToken, source: "user_oauth" };
  }
  return { token: "", source: "none" };
}

/**
 * List ad accounts available to this token (needs ads_management / ads_read).
 */
async function listAdAccounts(accessToken) {
  try {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/adaccounts`, {
      params: {
        fields: "id,account_id,name,account_status,currency,disable_reason",
        limit: 25,
        access_token: accessToken,
      },
      timeout: 30000,
    });
    return Array.isArray(response.data?.data) ? response.data.data : [];
  } catch (error) {
    throw wrapAdsError(error, "Failed to list Facebook ad accounts.");
  }
}

async function resolveAdAccountId(accessToken, preferredId = "") {
  const fromEnv = normalizeAdAccountId(
    preferredId || process.env.FACEBOOK_AD_ACCOUNT_ID || "",
  );
  if (fromEnv) {
    return fromEnv;
  }

  const accounts = await listAdAccounts(accessToken);
  const active = accounts.find(
    (row) => Number(row.account_status) === 1 || row.account_status === "1",
  );
  const chosen = active || accounts[0];
  if (!chosen?.id && !chosen?.account_id) {
    const error = new Error(
      "No Facebook Ad Account found. Set FACEBOOK_AD_ACCOUNT_ID in .env, or assign an Ad Account to the system user in Business Manager.",
    );
    error.statusCode = 400;
    throw error;
  }
  return normalizeAdAccountId(chosen.id || `act_${chosen.account_id}`);
}

async function uploadAdImageHash({
  adAccountId,
  imageUrl,
  accessToken,
}) {
  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${adAccountId}/adimages`,
      null,
      {
        params: {
          url: imageUrl,
          access_token: accessToken,
        },
        timeout: 120000,
      },
    );

    const images = response.data?.images;
    if (images && typeof images === "object") {
      const first = Object.values(images)[0];
      if (first?.hash) {
        return String(first.hash);
      }
    }

    if (response.data?.hash) {
      return String(response.data.hash);
    }

    throw new Error("Ad image upload did not return an image hash.");
  } catch (error) {
    throw wrapAdsError(error, "Failed to upload image to Facebook Ads.");
  }
}

async function createBuyNowCreative({
  adAccountId,
  pageId,
  imageHash,
  imageUrl,
  message,
  buyUrl,
  accessToken,
  ctaType = "BUY_NOW",
}) {
  const linkData = {
    link: buyUrl,
    message: message || "Buy now",
    call_to_action: {
      type: ctaType,
      value: { link: buyUrl },
    },
  };

  if (imageHash) {
    linkData.image_hash = imageHash;
  } else if (imageUrl) {
    linkData.picture = imageUrl;
  }

  const objectStorySpec = {
    page_id: pageId,
    link_data: linkData,
  };

  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${adAccountId}/adcreatives`,
      null,
      {
        params: {
          name: `Buy Now ${Date.now()}`,
          object_story_spec: JSON.stringify(objectStorySpec),
          access_token: accessToken,
        },
        timeout: 60000,
      },
    );

    const creativeId = response.data?.id;
    if (!creativeId) {
      throw new Error("Facebook did not return an ad creative id.");
    }
    return {
      creativeId: String(creativeId),
      raw: response.data,
    };
  } catch (error) {
    throw wrapAdsError(error, "Failed to create Buy Now ad creative.");
  }
}

async function createPausedBuyNowCampaign({ adAccountId, accessToken, name }) {
  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${adAccountId}/campaigns`,
      null,
      {
        params: {
          name: name || `Buy Now Campaign ${Date.now()}`,
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
          special_ad_categories: JSON.stringify([]),
          // Required when budget is on ad sets (ABO), not campaign CBO.
          is_adset_budget_sharing_enabled: false,
          access_token: accessToken,
        },
        timeout: 60000,
      },
    );
    const campaignId = response.data?.id;
    if (!campaignId) {
      throw new Error("Facebook did not return a campaign id.");
    }
    return String(campaignId);
  } catch (error) {
    throw wrapAdsError(error, "Failed to create Facebook ad campaign.");
  }
}

async function createPausedBuyNowAdSet({
  adAccountId,
  campaignId,
  pageId,
  accessToken,
  name,
}) {
  const dailyBudget = Math.max(
    100,
    Number(process.env.FACEBOOK_ADS_DAILY_BUDGET) || 50000,
  );
  const country = (process.env.FACEBOOK_ADS_COUNTRY || "IN").trim() || "IN";

  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${adAccountId}/adsets`,
      null,
      {
        params: {
          name: name || `Buy Now AdSet ${Date.now()}`,
          campaign_id: campaignId,
          daily_budget: dailyBudget,
          billing_event: "IMPRESSIONS",
          optimization_goal: "LINK_CLICKS",
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          destination_type: "WEBSITE",
          targeting: JSON.stringify({
            geo_locations: { countries: [country] },
            age_min: 18,
          }),
          promoted_object: JSON.stringify({ page_id: pageId }),
          status: "PAUSED",
          access_token: accessToken,
        },
        timeout: 60000,
      },
    );
    const adSetId = response.data?.id;
    if (!adSetId) {
      throw new Error("Facebook did not return an ad set id.");
    }
    return String(adSetId);
  } catch (error) {
    throw wrapAdsError(error, "Failed to create Facebook ad set.");
  }
}

async function createPausedBuyNowAd({
  adAccountId,
  adSetId,
  creativeId,
  accessToken,
  name,
}) {
  try {
    const response = await axios.post(
      `${GRAPH_BASE_URL}/${adAccountId}/ads`,
      null,
      {
        params: {
          name: name || `Buy Now Ad ${Date.now()}`,
          adset_id: adSetId,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: "PAUSED",
          access_token: accessToken,
        },
        timeout: 60000,
      },
    );
    const adId = response.data?.id;
    if (!adId) {
      throw new Error("Facebook did not return an ad id.");
    }
    return String(adId);
  } catch (error) {
    throw wrapAdsError(error, "Failed to create Facebook ad.");
  }
}

/**
 * Create a PAUSED Traffic ad with Buy Now CTA on the Page.
 * Prefers FACEBOOK_ADS_ACCESS_TOKEN (Business system user) over user OAuth.
 */
async function createBuyNowAdForPage({
  userAccessToken = "",
  pageId,
  imageUrl,
  buyUrl,
  message = "",
  adAccountId = "",
}) {
  const { token: accessToken, source: tokenSource } = getAdsAccessToken(
    userAccessToken,
  );

  if (!accessToken) {
    const error = new Error(
      "Buy Now ads need FACEBOOK_ADS_ACCESS_TOKEN in .env (Business Manager system user token with ads_management). User Facebook Login cannot request ads scopes on this app.",
    );
    error.statusCode = 400;
    throw error;
  }
  if (!pageId) {
    const error = new Error("Facebook Page id is required for Buy Now ads.");
    error.statusCode = 400;
    throw error;
  }

  const link = normalizeHttpUrl(buyUrl);
  if (!link) {
    const error = new Error("Buy Now link must be a valid http(s) URL.");
    error.statusCode = 400;
    throw error;
  }

  const poster = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(poster)) {
    const error = new Error("A public image URL is required for Buy Now ads.");
    error.statusCode = 400;
    throw error;
  }

  const accountId = await resolveAdAccountId(accessToken, adAccountId);
  console.log("[facebook-ads] using ad account", accountId, "token:", tokenSource);

  let imageHash = null;
  try {
    imageHash = await uploadAdImageHash({
      adAccountId: accountId,
      imageUrl: poster,
      accessToken,
    });
  } catch (error) {
    console.warn(
      "[facebook-ads] ad image hash upload failed, falling back to picture URL:",
      getGraphErrorMessage(error),
    );
  }

  let creative;
  try {
    creative = await createBuyNowCreative({
      adAccountId: accountId,
      pageId,
      imageHash,
      imageUrl: poster,
      message: String(message || "").trim() || "Buy now",
      buyUrl: link,
      accessToken,
      ctaType: "BUY_NOW",
    });
  } catch (buyNowError) {
    console.warn(
      "[facebook-ads] BUY_NOW creative failed, retrying SHOP_NOW:",
      getGraphErrorMessage(buyNowError),
      buyNowError?.facebook || null,
    );
    try {
      creative = await createBuyNowCreative({
        adAccountId: accountId,
        pageId,
        imageHash,
        imageUrl: poster,
        message: String(message || "").trim() || "Shop now",
        buyUrl: link,
        accessToken,
        ctaType: "SHOP_NOW",
      });
    } catch (shopNowError) {
      console.error(
        "[facebook-ads] SHOP_NOW creative also failed:",
        getGraphErrorMessage(shopNowError),
        {
          pageId,
          adAccountId: accountId,
          tokenSource,
          facebook: shopNowError?.facebook || null,
        },
      );
      const wrapped = new Error(
        `Buy Now creative Permissions error for Page ${pageId} on ${accountId}. Assign System User to this Page with ADVERTISE (+ CREATE_CONTENT) and to the Ad Account with ADVERTISE/MANAGE, then regenerate token. Meta: ${getGraphErrorMessage(shopNowError)}`,
      );
      wrapped.statusCode = 403;
      wrapped.facebook = shopNowError?.facebook || buyNowError?.facebook || null;
      wrapped.cause = shopNowError;
      throw wrapped;
    }
  }

  const campaignId = await createPausedBuyNowCampaign({
    adAccountId: accountId,
    accessToken,
  });
  const adSetId = await createPausedBuyNowAdSet({
    adAccountId: accountId,
    campaignId,
    pageId,
    accessToken,
  });
  const adId = await createPausedBuyNowAd({
    adAccountId: accountId,
    adSetId,
    creativeId: creative.creativeId,
    accessToken,
  });

  return {
    format: "buy_now_ad",
    adAccountId: accountId,
    campaignId,
    adSetId,
    adId,
    creativeId: creative.creativeId,
    buyUrl: link,
    status: "PAUSED",
    tokenSource,
    message:
      "Buy Now ad created as PAUSED. Open Meta Ads Manager and set the ad to ACTIVE to show the Buy Now button (this uses ad spend).",
  };
}

module.exports = {
  listAdAccounts,
  resolveAdAccountId,
  createBuyNowAdForPage,
  getAdsAccessToken,
  normalizeHttpUrl,
  getGraphErrorMessage,
};
