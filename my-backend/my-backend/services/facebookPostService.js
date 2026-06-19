const mongoose = require("mongoose");
const FacebookConnection = require("../models/FacebookConnection");
const { postImageToPage, postImageToInstagram } = require("./facebookService");

function isValidObjectId(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    return false;
  }

  return String(new mongoose.Types.ObjectId(value)) === value;
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
 * Post a public image URL to the Instagram account linked to the user's Facebook Page.
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

  const connection = await FacebookConnection.findOne({ userId }).lean();
  if (!connection?.selectedPage?.pageId || !connection.selectedPage.pageAccessToken) {
    const error = new Error(
      "This user has not selected a Facebook Page yet. Complete Connect Facebook and save a Page first.",
    );
    error.statusCode = 400;
    throw error;
  }

  const instagramAccount = connection.selectedPage.instagramAccount;
  if (!instagramAccount?.igUserId) {
    const error = new Error(
      "This user's Facebook Page does not have a linked Instagram Business account.",
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
      instagram = await postPosterToInstagramForUser({ userId, imageUrl, caption });
    } catch (error) {
      instagram = {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { facebook, instagram };
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
    map.set(String(connection.userId), {
      facebookConnected: true,
      facebookPageSelected: Boolean(connection.selectedPage?.pageId),
      facebookPageName: connection.selectedPage?.pageName || null,
    });
  }

  return map;
}

function buildFacebookConnectUrl(userId, apiBaseUrl) {
  const base = (apiBaseUrl || process.env.API_BASE_URL || "http://localhost:5000").replace(
    /\/$/,
    "",
  );
  return `${base}/auth/facebook?userId=${encodeURIComponent(userId)}`;
}

module.exports = {
  postPosterForUser,
  postPosterToInstagramForUser,
  approvePosterForUser,
  getUserSocialApproveEligibility,
  getFacebookStatusByUserIds,
  buildFacebookConnectUrl,
  isValidObjectId,
};
