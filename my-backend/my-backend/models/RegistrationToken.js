const mongoose = require("mongoose");

const registrationTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{10}$/, "Mobile number must be 10 digits."],
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

module.exports = mongoose.model("RegistrationToken", registrationTokenSchema);
