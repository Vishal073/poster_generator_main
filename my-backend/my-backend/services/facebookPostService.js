const mongoose = require("mongoose");
const FacebookConnection = require("../models/FacebookConnection");
const FacebookOAuthState = require("../models/FacebookOAuthState");
const {
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
} = require("./facebookService");
const { createBuyNowAdForPage } = require("./facebookAdsService");
const { buildOgShareCardUrl } = require("./ogShareCardRoute");

function isValidObjectId(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    return false;
  }

  return String(new mongoose.Types.ObjectId(value)) === value;
}

async function getFacebookConnectionForUser(userId) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await FacebookConnection.findOne({ userId }).lean();
  if (!connection) {
    const error = new Error("This user has not connected Facebook yet.");
    error.statusCode = 404;
    throw error;
  }

  if (!connection.selectedPage?.pageId || !connection.selectedPage?.pageAccessToken) {
    const error = new Error(
      "This user has not selected a Facebook Page yet. Complete Connect Facebook and save a Page first.",
    );
    error.statusCode = 400;
    throw error;
  }

  return connection;
}

function toPlainFacebookPage(page) {
  if (!page) {
    return null;
  }

  const plain =
    typeof page.toObject === "function"
      ? page.toObject({ depopulate: true })
      : typeof page.toJSON === "function"
        ? page.toJSON()
        : page;

  const pageId = String(plain.pageId || plain.id || "").trim();
  const pageName =
    (typeof plain.pageName === "string" && plain.pageName.trim()) ||
    (typeof plain.name === "string" && plain.name.trim()) ||
    "Unnamed Page";
  const pageAccessToken =
    (typeof plain.pageAccessToken === "string" && plain.pageAccessToken.trim()) ||
    (typeof plain.access_token === "string" && plain.access_token.trim()) ||
    "";

  return {
    pageId,
    pageName,
    pageAccessToken,
    instagramAccount: plain.instagramAccount?.igUserId
      ? {
          igUserId: String(plain.instagramAccount.igUserId),
          username:
            typeof plain.instagramAccount.username === "string"
              ? plain.instagramAccount.username
              : "",
          name:
            typeof plain.instagramAccount.name === "string"
              ? plain.instagramAccount.name
              : "",
        }
      : null,
  };
}

function buildSelectedPageSnapshot(page) {
  const plain = toPlainFacebookPage(page);
  if (!plain?.pageId || !plain.pageName || !plain.pageAccessToken) {
    return null;
  }

  return {
    pageId: plain.pageId,
    pageName: plain.pageName,
    pageAccessToken: plain.pageAccessToken,
    instagramAccount: plain.instagramAccount?.igUserId ? plain.instagramAccount : null,
  };
}

/**
 * Append product URL to organic photo/video message (fallback only).
 */
function buildPhotoMessage(caption = "", shareLink = "") {
  const message = typeof caption === "string" ? caption.trim() : "";
  let raw = typeof shareLink === "string" ? shareLink.trim() : "";
  if (!raw) return message;

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let link = raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return message;
    }
    link = parsed.toString();
  } catch {
    return message;
  }

  if (!message) return link;
  if (message.includes(link)) return message;
  return `${message}\n\n${link}`;
}

function isBuyNowAdsEnabled() {
  const raw = process.env.FACEBOOK_BUY_NOW_ADS_ENABLED;
  // Default OFF — free organic link card (Amazon-style). Ads only if explicitly enabled.
  return raw === "1" || raw === "true" || raw === "yes";
}

function normalizeShareLink(shareLink = "") {
  let raw = typeof shareLink === "string" ? shareLink.trim() : "";
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * Post a public image URL to the Facebook Page saved for this app user.
 * With shareLink (default): free organic link card (tap → URL). No Ads Manager.
 * Optional paid Ads CTA: FACEBOOK_BUY_NOW_ADS_ENABLED=1 + ads token/account.
 */
async function postPosterForUser({
  userId,
  imageUrl,
  caption = "",
  shareLink = "",
}) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
    const error = new Error("imageUrl is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const pageId = connection.selectedPage.pageId;
  const pageName = connection.selectedPage.pageName;
  const pageAccessToken = connection.selectedPage.pageAccessToken;
  const link = normalizeShareLink(shareLink);
  const captionText = typeof caption === "string" ? caption.trim() : "";

  if (link && isBuyNowAdsEnabled()) {
    try {
      const adResult = await createBuyNowAdForPage({
        userAccessToken: connection.userAccessToken || "",
        pageId,
        imageUrl: imageUrl.trim(),
        buyUrl: link,
        message: captionText,
      });

      console.log("[facebook] Buy Now ad created", {
        userId: String(userId),
        adId: adResult.adId,
        creativeId: adResult.creativeId,
        status: adResult.status,
        tokenSource: adResult.tokenSource,
      });

      return {
        userId: String(connection.userId),
        pageId,
        pageName,
        postId: adResult.adId,
        shareLink: adResult.buyUrl,
        caption: captionText || null,
        format: adResult.format,
        adAccountId: adResult.adAccountId,
        campaignId: adResult.campaignId,
        adSetId: adResult.adSetId,
        adId: adResult.adId,
        creativeId: adResult.creativeId,
        adStatus: adResult.status,
        message: adResult.message,
      };
    } catch (error) {
      const msg = String(error?.message || "");
      const tokenMissing =
        !String(process.env.FACEBOOK_ADS_ACCESS_TOKEN || "").trim() &&
        /FACEBOOK_ADS_ACCESS_TOKEN/i.test(msg);
      if (tokenMissing) {
        const wrapped = new Error(
          "Buy Now ads need FACEBOOK_ADS_ACCESS_TOKEN + FACEBOOK_AD_ACCOUNT_ID (only when FACEBOOK_BUY_NOW_ADS_ENABLED=1).",
        );
        wrapped.statusCode = 403;
        wrapped.cause = error;
        throw wrapped;
      }

      if (
        /Permissions error|required permission|not visible to you|access this profile|No write permission on ad account/i.test(
          msg,
        ) ||
        error?.facebook?.code === 200 ||
        error?.facebook?.code === 10
      ) {
        const wrapped = new Error(
          `Buy Now ads permission failed: ${msg}`,
        );
        wrapped.statusCode = 403;
        wrapped.cause = error;
        wrapped.facebook = error?.facebook || null;
        throw wrapped;
      }
      throw error;
    }
  }

  if (link) {
    const cardTitle =
      captionText.split("\n").map((line) => line.trim()).find(Boolean) ||
      "Shop now";
    const ogCardUrl = buildOgShareCardUrl({
      destinationUrl: link,
      imageUrl: imageUrl.trim(),
      title: cardTitle,
      description: captionText || "Tap Shop now to continue.",
    });

    if (ogCardUrl) {
      try {
        const linkResult = await postLinkCardToPage({
          pageId,
          pageAccessToken,
          link: ogCardUrl,
          message: captionText,
          name: cardTitle,
          description: "Tap Shop now",
          imageUrl: imageUrl.trim(),
          ctaType: "SHOP_NOW",
        });

        console.log("[facebook] Amazon-style Shop now link card posted", {
          userId: String(userId),
          postId: linkResult.postId,
          format: linkResult.format,
          ogCardUrl: ogCardUrl.slice(0, 120),
          shopLink: link,
        });

        return {
          userId: String(connection.userId),
          pageId,
          pageName,
          postId: linkResult.postId,
          caption: captionText || null,
          shareLink: link,
          format: linkResult.format,
          message:
            "Posted free Amazon-style link card with your poster + Shop now (tap opens your product URL). No Ads Manager / no spend.",
        };
      } catch (linkError) {
        console.warn(
          "[facebook] Shop now link card failed, falling back to photo + caption:",
          linkError?.message || linkError,
        );
      }
    } else {
      console.warn(
        "[facebook] OG share card URL unavailable (set API_BASE_URL). Falling back to photo + caption link.",
      );
    }

    const message = buildPhotoMessage(captionText, link);
    const result = await postImageToPage({
      pageId,
      pageAccessToken,
      imageUrl: imageUrl.trim(),
      caption: message,
    });

    return {
      userId: String(connection.userId),
      pageId,
      pageName,
      postId: result.postId,
      caption: message || null,
      shareLink: link,
      format: result.format || "photo_with_message",
      message:
        "Posted free organic photo with poster + Buy Now link in caption. No ads spend.",
    };
  }

  const message = buildPhotoMessage(captionText, "");
  console.log("[facebook] photo caption built", {
    userId: String(userId),
    hasShareLink: false,
    captionLength: message.length,
    captionPreview: message.slice(0, 200),
  });

  const result = await postImageToPage({
    pageId,
    pageAccessToken,
    imageUrl: imageUrl.trim(),
    caption: message,
  });

  return {
    userId: String(connection.userId),
    pageId,
    pageName,
    postId: result.postId,
    caption: message || null,
    shareLink: null,
    format: result.format || "photo",
  };
}

/**
 * Post a public image URL to Instagram linked to the user's selected Facebook Page.
 */
async function postPosterToInstagramForUser({ userId, imageUrl, caption = "" }) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
    const error = new Error("imageUrl is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const instagramAccount = connection.selectedPage?.instagramAccount;

  if (!instagramAccount?.igUserId) {
    const error = new Error(
      "No Instagram Business account is linked to this user's Facebook Page. Link Instagram to the Page in Meta, then reconnect Facebook.",
    );
    error.statusCode = 400;
    throw error;
  }

  const result = await postImageToInstagram({
    igUserId: instagramAccount.igUserId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    imageUrl: imageUrl.trim(),
    caption: typeof caption === "string" ? caption.trim() : "",
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    igUserId: instagramAccount.igUserId,
    username: instagramAccount.username || null,
    mediaId: result.mediaId,
  };
}

async function postCarouselForUser({ userId, imageUrls, caption = "" }) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (urls.length < 2) {
    const error = new Error("At least 2 image URLs are required for a carousel.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const result = await postMultiPhotoToPage({
    pageId: connection.selectedPage.pageId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    imageUrls: urls,
    caption: typeof caption === "string" ? caption.trim() : "",
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    postId: result.postId,
    photoIds: result.photoIds,
  };
}

async function postCarouselToInstagramForUser({ userId, imageUrls, caption = "" }) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (urls.length < 2) {
    const error = new Error("At least 2 image URLs are required for an Instagram carousel.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const instagramAccount = connection.selectedPage?.instagramAccount;

  if (!instagramAccount?.igUserId) {
    const error = new Error(
      "No Instagram Business account is linked to this user's Facebook Page. Link Instagram to the Page in Meta, then reconnect Facebook.",
    );
    error.statusCode = 400;
    throw error;
  }

  const result = await postCarouselToInstagram({
    igUserId: instagramAccount.igUserId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    imageUrls: urls,
    caption: typeof caption === "string" ? caption.trim() : "",
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    igUserId: instagramAccount.igUserId,
    username: instagramAccount.username || null,
    mediaId: result.mediaId,
    childIds: result.childIds,
  };
}

/**
 * Publish a public image URL as a Facebook Page Story for this app user.
 */
async function postPosterStoryForUser({ userId, imageUrl }) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
    const error = new Error("imageUrl is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);

  const result = await postPhotoStoryToPage({
    pageId: connection.selectedPage.pageId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    imageUrl: imageUrl.trim(),
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    postId: result.postId,
    photoId: result.photoId,
  };
}

/**
 * Publish a public image URL as an Instagram Story for this app user.
 */
async function postPosterStoryToInstagramForUser({ userId, imageUrl }) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
    const error = new Error("imageUrl is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const instagramAccount = connection.selectedPage?.instagramAccount;

  if (!instagramAccount?.igUserId) {
    const error = new Error(
      "No Instagram Business account is linked to this user's Facebook Page. Link Instagram to the Page in Meta, then reconnect Facebook.",
    );
    error.statusCode = 400;
    throw error;
  }

  const result = await postImageStoryToInstagram({
    igUserId: instagramAccount.igUserId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    imageUrl: imageUrl.trim(),
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    igUserId: instagramAccount.igUserId,
    username: instagramAccount.username || null,
    mediaId: result.mediaId,
  };
}

async function postReelForUser({
  userId,
  videoUrl,
  caption = "",
  shareLink = "",
}) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.trim()) {
    const error = new Error("videoUrl is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const message = buildPhotoMessage(caption, shareLink);

  const result = await postVideoToPage({
    pageId: connection.selectedPage.pageId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    videoUrl: videoUrl.trim(),
    caption: message,
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    postId: result.postId,
    shareLink: shareLink?.trim() || null,
  };
}

async function postReelToInstagramForUser({ userId, videoUrl, caption = "" }) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.trim()) {
    const error = new Error("videoUrl is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const instagramAccount = connection.selectedPage?.instagramAccount;

  if (!instagramAccount?.igUserId) {
    const error = new Error(
      "No Instagram Business account is linked to this user's Facebook Page. Link Instagram to the Page in Meta, then reconnect Facebook.",
    );
    error.statusCode = 400;
    throw error;
  }

  const result = await postReelToInstagram({
    igUserId: instagramAccount.igUserId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    videoUrl: videoUrl.trim(),
    caption: typeof caption === "string" ? caption.trim() : "",
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    igUserId: instagramAccount.igUserId,
    username: instagramAccount.username || null,
    mediaId: result.mediaId,
  };
}

/**
 * Whether this user can use WhatsApp "Approve" to post the pending poster.
 */
async function getUserSocialApproveEligibility(userId) {
  if (!isValidObjectId(userId)) {
    return { canApprove: false, hasInstagram: false, pageName: null };
  }

  const connection = await FacebookConnection.findOne({ userId }).select("selectedPage").lean();
  if (!connection?.selectedPage?.pageId || !connection.selectedPage.pageAccessToken) {
    return { canApprove: false, hasInstagram: false, pageName: null };
  }

  return {
    canApprove: true,
    hasInstagram: Boolean(connection.selectedPage.instagramAccount?.igUserId),
    pageName: connection.selectedPage.pageName || null,
  };
}

/**
 * Post poster to Facebook Page and Instagram (when linked) after user taps Approve on WhatsApp.
 */
async function approvePosterForUser({ userId, imageUrl, caption = "" }) {
  const facebook = await postPosterForUser({ userId, imageUrl, caption });

  let instagram = null;
  const eligibility = await getUserSocialApproveEligibility(userId);
  if (eligibility.hasInstagram) {
    try {
      const posted = await postPosterToInstagramForUser({ userId, imageUrl, caption });
      instagram = {
        success: true,
        ...posted,
      };
    } catch (error) {
      instagram = {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { facebook, instagram };
}

async function listPostsForUser({ userId, limit = 25 }) {
  const connection = await getFacebookConnectionForUser(userId);

  const result = await listPagePosts({
    pageId: connection.selectedPage.pageId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    limit,
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    posts: result.posts,
    paging: result.paging,
  };
}

async function deletePostForUser({ userId, postId }) {
  if (!postId || typeof postId !== "string" || !postId.trim()) {
    const error = new Error("postId is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);

  const result = await deletePagePost({
    postId: postId.trim(),
    pageAccessToken: connection.selectedPage.pageAccessToken,
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    postId: postId.trim(),
    deleted: result.deleted,
  };
}

async function updatePostForUser({ userId, postId, message }) {
  if (!postId || typeof postId !== "string" || !postId.trim()) {
    const error = new Error("postId is required.");
    error.statusCode = 400;
    throw error;
  }

  if (typeof message !== "string") {
    const error = new Error("message is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);

  const result = await updatePagePost({
    postId: postId.trim(),
    pageAccessToken: connection.selectedPage.pageAccessToken,
    message,
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    postId: postId.trim(),
    caption: message,
    updated: result.updated,
  };
}

async function listInstagramPostsForUser({ userId, limit = 25 }) {
  const connection = await getFacebookConnectionForUser(userId);
  const instagramAccount = connection.selectedPage?.instagramAccount;

  if (!instagramAccount?.igUserId) {
    return {
      userId: String(connection.userId),
      connected: false,
      igUserId: null,
      username: null,
      posts: [],
      paging: null,
    };
  }

  const result = await listInstagramMedia({
    igUserId: instagramAccount.igUserId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    limit,
  });

  return {
    userId: String(connection.userId),
    connected: true,
    igUserId: instagramAccount.igUserId,
    username: instagramAccount.username || null,
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    posts: result.posts,
    paging: result.paging,
  };
}

async function deleteInstagramPostForUser({ userId, mediaId }) {
  if (!mediaId || typeof mediaId !== "string" || !mediaId.trim()) {
    const error = new Error("mediaId is required.");
    error.statusCode = 400;
    throw error;
  }

  const connection = await getFacebookConnectionForUser(userId);
  const instagramAccount = connection.selectedPage?.instagramAccount;

  if (!instagramAccount?.igUserId) {
    const error = new Error("This user has no Instagram account linked to their Facebook Page.");
    error.statusCode = 400;
    throw error;
  }

  const result = await deleteInstagramMedia({
    mediaId: mediaId.trim(),
    pageAccessToken: connection.selectedPage.pageAccessToken,
  });

  return {
    userId: String(connection.userId),
    igUserId: instagramAccount.igUserId,
    username: instagramAccount.username || null,
    mediaId: mediaId.trim(),
    deleted: result.deleted,
  };
}

async function listSocialPostsForUser({ userId, limit = 25 }) {
  const facebook = await listPostsForUser({ userId, limit });
  let instagram = {
    userId: String(userId),
    connected: false,
    igUserId: null,
    username: null,
    posts: [],
    paging: null,
  };

  try {
    instagram = await listInstagramPostsForUser({ userId, limit });
  } catch (error) {
    console.warn(
      "[Social posts] Instagram list skipped:",
      error?.message || String(error),
    );
  }

  return {
    userId: String(userId),
    facebook,
    instagram,
  };
}

/**
 * Batch lookup Facebook link status for user list in admin portal.
 */
async function getFacebookStatusByUserIds(userIds) {
  const validIds = userIds.filter((id) => isValidObjectId(String(id)));
  const map = new Map();

  if (!validIds.length) {
    return map;
  }

  const connections = await FacebookConnection.find({ userId: { $in: validIds } })
    .select("userId selectedPage facebookUserId includeInstagramPermissions updatedAt")
    .lean();

  for (const connection of connections) {
    const instagramAccount = connection.selectedPage?.instagramAccount;
    const wantsInstagram = Boolean(connection.includeInstagramPermissions);
    map.set(String(connection.userId), {
      facebookConnected: true,
      facebookPageSelected: Boolean(connection.selectedPage?.pageId),
      facebookPageName: connection.selectedPage?.pageName || null,
      instagramConnected: wantsInstagram && Boolean(instagramAccount?.igUserId),
      instagramUsername:
        wantsInstagram && instagramAccount?.username ? instagramAccount.username : null,
    });
  }

  return map;
}

/**
 * Remove all Facebook OAuth data stored for an app user.
 */
async function disconnectFacebookForUser(userId) {
  if (!isValidObjectId(userId)) {
    const error = new Error("userId must be a valid MongoDB User _id.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedUserId = new mongoose.Types.ObjectId(userId);
  const connection = await FacebookConnection.findOneAndDelete({
    userId: normalizedUserId,
  }).lean();
  const oauthDeleteResult = await FacebookOAuthState.deleteMany({
    userId: normalizedUserId,
  });

  return {
    connectionRemoved: Boolean(connection),
    removedPageName: connection?.selectedPage?.pageName || null,
    oauthStatesRemoved: oauthDeleteResult.deletedCount || 0,
  };
}

function resolvePublicApiBaseUrl(req) {
  const fromEnv =
    typeof process.env.API_BASE_URL === "string" ? process.env.API_BASE_URL.trim() : "";
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }

  if (req && typeof req.get === "function") {
    const forwardedHost = req.get("x-forwarded-host");
    const forwardedProto = req.get("x-forwarded-proto");
    if (forwardedHost) {
      const host = forwardedHost.split(",")[0].trim();
      const proto = (forwardedProto || "https").split(",")[0].trim();
      return `${proto}://${host}`.replace(/\/$/, "");
    }

    const host = req.get("host");
    if (host) {
      const proto = req.protocol || "http";
      return `${proto}://${host}`.replace(/\/$/, "");
    }
  }

  return "http://localhost:5000";
}

function buildFacebookConnectUrl(userId, apiBaseUrl, req) {
  const base = (apiBaseUrl || resolvePublicApiBaseUrl(req)).replace(/\/$/, "");
  return `${base}/auth/facebook?userId=${encodeURIComponent(userId)}`;
}

module.exports = {
  postPosterForUser,
  postPosterToInstagramForUser,
  postCarouselForUser,
  postCarouselToInstagramForUser,
  postPosterStoryForUser,
  postPosterStoryToInstagramForUser,
  postReelForUser,
  postReelToInstagramForUser,
  approvePosterForUser,
  getUserSocialApproveEligibility,
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
  isValidObjectId,
};
