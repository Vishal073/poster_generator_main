const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
      index: true,
    },
    shopSlug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    productId: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 10000,
    },
    images: {
      type: [String],
      default: [],
    },
    category: {
      type: String,
      enum: ["readywear", "other"],
      default: "other",
    },
    sizes: {
      type: [String],
      default: [],
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    stockBySize: {
      type: Map,
      of: Number,
      default: undefined,
    },
    stock: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

productSchema.index({ shopSlug: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model("Product", productSchema);
