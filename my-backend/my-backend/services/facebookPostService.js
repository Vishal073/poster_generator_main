const mongoose = require("mongoose");
const FacebookConnection = require("../models/FacebookConnection");
const FacebookOAuthState = require("../models/FacebookOAuthState");
const {
  postImageToPage,
  postImageToInstagram,
  listPagePosts,
  deletePagePost,
} = require("./facebookService");

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

function buildSelectedPageSnapshot(page) {
  if (!page) {
    return null;
  }

  return {
    pageId: page.pageId,
    pageName: page.pageName,
    pageAccessToken: page.pageAccessToken,
    instagramAccount: page.instagramAccount?.igUserId ? page.instagramAccount : null,
  };
}

/**
 * Post a public image URL to the Facebook Page saved for this app user.
 */
async function postPosterForUser({ userId, imageUrl, caption = "" }) {
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

  const result = await postImageToPage({
    pageId: connection.selectedPage.pageId,
    pageAccessToken: connection.selectedPage.pageAccessToken,
    imageUrl: imageUrl.trim(),
    caption: typeof caption === "string" ? caption.trim() : "",
  });

  return {
    userId: String(connection.userId),
    pageId: connection.selectedPage.pageId,
    pageName: connection.selectedPage.pageName,
    postId: result.postId,
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
    .select("userId selectedPage facebookUserId updatedAt")
    .lean();

  for (const connection of connections) {
    const instagramAccount = connection.selectedPage?.instagramAccount;
    map.set(String(connection.userId), {
      facebookConnected: true,
      facebookPageSelected: Boolean(connection.selectedPage?.pageId),
      facebookPageName: connection.selectedPage?.pageName || null,
      instagramConnected: Boolean(instagramAccount?.igUserId),
      instagramUsername: instagramAccount?.username || null,
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
  approvePosterForUser,
  getUserSocialApproveEligibility,
  buildSelectedPageSnapshot,
  listPostsForUser,
  deletePostForUser,
  getFacebookStatusByUserIds,
  disconnectFacebookForUser,
  buildFacebookConnectUrl,
  resolvePublicApiBaseUrl,
  isValidObjectId,
};
