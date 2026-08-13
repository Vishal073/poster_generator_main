const mongoose = require("mongoose");
const {
  sealPlainTokensBeforeSave,
  decryptLoadedConnectionDoc,
} = require("../utils/facebookConnectionTokenFields");

/**
 * Stores Facebook OAuth session data and the user's selected Page for posting.
 * Created after OAuth callback; updated when the user picks a Page.
 * Access tokens are encrypted at rest (AES-256-GCM) before save.
 */
const facebookPageSchema = new mongoose.Schema(
  {
    pageId: { type: String, required: true, trim: true },
    pageName: { type: String, required: true, trim: true },
    pageAccessToken: { type: String, required: true, trim: true },
    instagramAccount: {
      type: new mongoose.Schema(
        {
          igUserId: { type: String, required: true, trim: true },
          username: { type: String, trim: true, default: "" },
          name: { type: String, trim: true, default: "" },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { _id: false },
);

const facebookConnectionSchema = new mongoose.Schema(
  {
    sessionId: {
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
      unique: true,
    },
    facebookUserId: {
      type: String,
      trim: true,
      default: "",
    },
    userAccessToken: {
      type: String,
      trim: true,
      default: "",
    },
    userTokenExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    pages: {
      type: [facebookPageSchema],
      default: [],
    },
    selectedPage: {
      type: facebookPageSchema,
      default: null,
    },
    includeInstagramPermissions: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

facebookConnectionSchema.pre("save", function encryptTokensBeforeSave(next) {
  try {
    sealPlainTokensBeforeSave(this);
    next();
  } catch (error) {
    next(error);
  }
});

function decryptMany(docs) {
  if (!docs) {
    return;
  }

  if (Array.isArray(docs)) {
    for (const doc of docs) {
      decryptLoadedConnectionDoc(doc);
    }
    return;
  }

  decryptLoadedConnectionDoc(docs);
}

facebookConnectionSchema.post("init", decryptMany);
facebookConnectionSchema.post("save", decryptMany);
facebookConnectionSchema.post("find", decryptMany);
facebookConnectionSchema.post("findOne", decryptMany);

module.exports = mongoose.model("FacebookConnection", facebookConnectionSchema);
