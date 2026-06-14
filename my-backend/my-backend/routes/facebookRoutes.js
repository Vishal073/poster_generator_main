const express = require("express");
const {
  startFacebookAuth,
  handleFacebookCallback,
  getFacebookOAuthConfig,
  getFacebookPages,
  saveSelectedPage,
  getFacebookConnectionByUser,
  getFacebookConnectUrl,
  postFacebookForUser,
  listFacebookPostsForUser,
  deleteFacebookPostForUser,
  postFacebookImage,
} = require("../controllers/facebookController");

const router = express.Router();

// Step 1: Redirect user to Facebook OAuth consent screen
router.get("/auth/facebook", startFacebookAuth);

// Step 2: Facebook redirects here with ?code=...&state=...
router.get("/auth/facebook/callback", handleFacebookCallback);

// Step 3: Frontend loads Pages for the OAuth session
router.get("/facebook/oauth-config", getFacebookOAuthConfig);

router.get("/facebook/pages", getFacebookPages);

// Step 4: Persist user's selected Page
router.post("/facebook/save-page", saveSelectedPage);

// Look up Facebook connection by app User _id
router.get("/facebook/connection/:userId", getFacebookConnectionByUser);

// Connect URL for admin user list button
router.get("/facebook/connect-url/:userId", getFacebookConnectUrl);

// One-click post using saved tokens for app user
router.post("/facebook/post-for-user", postFacebookForUser);

// List / delete posts on the user's selected Page
router.get("/facebook/posts/:userId", listFacebookPostsForUser);
router.delete("/facebook/posts/:userId/:postId", deleteFacebookPostForUser);

// Low-level post with explicit page tokens (testing)
router.post("/facebook/post-image", postFacebookImage);

module.exports = router;
