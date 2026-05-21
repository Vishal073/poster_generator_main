const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^\d{10}$/, "Mobile number must be 10 digits."],
    },
    caste: {
      type: String,
      trim: true,
      default: "",
    },
    post: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    occupationType: {
      type: String,
      enum: ["Politician", "Shopkeeper"],
      default: undefined,
    },
    party: {
      type: String,
      trim: true,
      default: "",
    },
    wardNo: {
      type: String,
      required: true,
      trim: true,
    },
    gender: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["SC", "ST", "OBC", "General"],
      default: undefined,
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    district: {
      type: String,
      trim: true,
      default: "",
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{6}$/, "Pincode must be 6 digits."],
    },
    userImageUrl: {
      type: String,
      trim: true,
      default: "",
    },
    userImagePublicId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
