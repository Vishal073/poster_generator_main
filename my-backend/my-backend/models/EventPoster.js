const mongoose = require("mongoose");

const textLineStyleSchema = new mongoose.Schema(
  {
    fontSize: Number,
    fontFamily: String,
    fontColor: String,
    fontWeight: String,
  },
  { _id: false },
);

const layoutSchema = new mongoose.Schema(
  {
    language: { type: String, default: "en" },
    insetFromBottom: { type: Number, default: 150 },
    insetLeft: { type: Number, default: 40 },
    insetRight: { type: Number, default: 40 },
    imagePosition: { type: String, default: "left" },
    imageWidth: { type: Number, default: 300 },
    imageHeight: { type: Number, default: 300 },
    imageShape: { type: String, default: "circle" },
    imageCornerRadius: { type: Number, default: 16 },
    imageGap: { type: Number, default: 16 },
    imageMaxSize: { type: Number, default: 350 },
    lineGap: { type: Number, default: 0 },
    lineGaps: { type: [Number], default: [16, 16] },
    fontSize: { type: Number, default: 40 },
    fontColor: { type: String, default: "#2a2a2a" },
    fontFamily: { type: String, default: "Helvetica Neue" },
    textOpacity: { type: Number, default: 1 },
    textBlendMode: { type: String, default: "source-over" },
    textBlockAlign: { type: String, default: "left" },
    textLineAlignments: { type: [String], default: ["left", "left", "left"] },
  },
  { _id: false },
);

const facebookConfigSchema = new mongoose.Schema(
  {
    uploadToFacebook: { type: Boolean, default: false },
    uploadToInstagram: { type: Boolean, default: false },
    sendWhatsApp: { type: Boolean, default: true },
    facebookCaption: { type: String, default: "", trim: true },
    instagramCaption: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const posterConfigSchema = new mongoose.Schema(
  {
    textLineStyles: { type: [textLineStyleSchema], default: undefined },
    layout: { type: layoutSchema, default: undefined },
    includeUserImage: { type: Boolean, default: true },
    addWatermark: { type: Boolean, default: true },
    watermarkPosition: { type: String, default: "top-right" },
    facebook: { type: facebookConfigSchema, default: undefined },
  },
  { _id: false },
);

const eventPosterSchema = new mongoose.Schema(
  {
    posterId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    publicId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    imageUrl: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    folder: { type: String, trim: true, default: "", index: true },
    date: { type: String, trim: true, default: "" },
    eventName: { type: String, trim: true, default: "" },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    format: { type: String, trim: true, default: "" },
    config: { type: posterConfigSchema, required: true },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("EventPoster", eventPosterSchema);
