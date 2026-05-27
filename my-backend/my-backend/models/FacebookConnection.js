const mongoose = require("mongoose");

/**
 * Stores Facebook OAuth session data and the user's selected Page for posting.
 * Created after OAuth callback; updated when the user picks a Page.
 */
const facebookPageSchema = new mongoose.Schema(
  {
    pageId: { type: String, required: true, trim: true },
    pageName: { type: String, required: true, trim: true },
    pageAccessToken: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const facebookConnectionSchema = new mongoose.Schema(
  {
    // Temporary session id passed to the frontend after OAuth redirect
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    // Optional link to your app's User document
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      unique: true,
    },
    facebookUserId: {
      type: String,
      trim: true,
      default: "",
    },
    // Long-lived user access token (used to refresh page tokens if needed)
    userAccessToken: {
      type: String,
      trim: true,
      default: "",
    },
    // All Pages returned from /me/accounts during OAuth
    pages: {
      type: [facebookPageSchema],
      default: [],
    },
    // Page the user chose for auto-posting
    selectedPage: {
      type: facebookPageSchema,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("FacebookConnection", facebookConnectionSchema);
