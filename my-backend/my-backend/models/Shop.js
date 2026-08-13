const mongoose = require("mongoose");

const shopSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    logoUrl: {
      type: String,
      default: "",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
      sparse: true,
    },
    upiId: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },
    upiPayeeName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Shop", shopSchema);
