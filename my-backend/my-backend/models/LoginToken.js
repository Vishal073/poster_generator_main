const mongoose = require("mongoose");

/**
 * One-time magic link for passwordless end-user login (shared via WhatsApp).
 * Default TTL: 2 hours (LOGIN_TOKEN_TTL_HOURS). Marked usedAt on first successful login.
 */
const loginTokenSchema = new mongoose.Schema(
  {
    token: {
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
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("LoginToken", loginTokenSchema);
