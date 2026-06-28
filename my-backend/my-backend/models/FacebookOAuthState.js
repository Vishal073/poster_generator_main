const mongoose = require("mongoose");

/**
 * Short-lived CSRF state for the Facebook OAuth redirect flow.
 * Documents auto-expire via MongoDB TTL index.
 */
const facebookOAuthStateSchema = new mongoose.Schema(
  {
    state: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    returnTo: {
      type: String,
      enum: ["admin", "portal"],
      default: "admin",
    },
    includeInstagram: {
      type: Boolean,
      default: false,
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

module.exports = mongoose.model("FacebookOAuthState", facebookOAuthStateSchema);
