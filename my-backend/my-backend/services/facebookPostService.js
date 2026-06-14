const mongoose = require("mongoose");
const FacebookConnection = require("../models/FacebookConnection");
const {
  postImageToPage,
  listPagePosts,
  deletePagePost,
  readPageEngagement,
  debugAccessToken,
} = require("./facebookService");

const META_REVIEW_TEST_IMAGE_URL =
  process.env.META_REVIEW_TEST_IMAGE_URL ||
  "https://res.cloudinary.com/di5yny8zy/image/upload/v1777641545/resized_1080x1350_u3t3fv.jpg";

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

/**
 * Run the Graph API calls Meta App Review expects for Page permissions.
 */
async function runMetaReviewTestForUser({ userId }) {
  const connection = await getFacebookConnectionForUser(userId);
  const pageId = connection.selectedPage.pageId;
  const pageAccessToken = connection.selectedPage.pageAccessToken;
  const pageName = connection.selectedPage.pageName;

  const tokenDebug = await debugAccessToken(pageAccessToken);

  const engagement = await readPageEngagement({ pageId, pageAccessToken });

  const listed = await listPagePosts({
    pageId,
    pageAccessToken,
    limit: 5,
  });

  const posted = await postImageToPage({
    pageId,
    pageAccessToken,
    imageUrl: META_REVIEW_TEST_IMAGE_URL,
    caption: "GCR Graphix — Meta App Review API test",
  });

  return {
    userId: String(connection.userId),
    pageId,
    pageName,
    configuredScopes: (process.env.FACEBOOK_SCOPES || "").trim() || null,
    tokenDebug,
    calls: {
      pages_read_engagement: {
        endpoint: `GET /${pageId}?fields=name,fan_count`,
        success: true,
        pageName: engagement.name,
        fanCount: engagement.fanCount,
      },
      pages_manage_posts_list: {
        endpoint: `GET /${pageId}/posts`,
        success: true,
        count: listed.posts.length,
      },
      pages_manage_posts_create: {
        endpoint: `POST /${pageId}/photos`,
        success: true,
        postId: posted.postId,
      },
    },
    nextSteps: [
      "Wait 15–30 minutes, then refresh Meta App Review → Permissions.",
      "pages_manage_posts should show 1 of 1 API test call(s).",
      "Ensure tokenDebug.appId matches your Meta Developer App ID.",
      "If scopes are missing, reconnect Facebook after updating FACEBOOK_SCOPES on Render.",
    ],
  };
}

module.exports = {
  postPosterForUser,
  listPostsForUser,
  deletePostForUser,
  runMetaReviewTestForUser,
  getFacebookStatusByUserIds,
  buildFacebookConnectUrl,
  isValidObjectId,
};
