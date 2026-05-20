const express = require("express");
const multer = require("multer");
const User = require("../models/User");
const { requireAuth } = require("../middleware/requireAuth");
const { uploadBufferToCloudinary } = require("./cloudnaryService");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function getFirstValue(body, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = body[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value != null && typeof value !== "object") {
      return String(value).trim();
    }
  }

  return "";
}

function normalizeOccupationType(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();

  if (["politician", "polition"].includes(normalizedValue)) {
    return "Politician";
  }
  if (normalizedValue === "shopkeeper") {
    return "Shopkeeper";
  }

  return "";
}

function normalizeCategory(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();

  if (normalizedValue === "sc") {
    return "SC";
  }
  if (normalizedValue === "st") {
    return "ST";
  }
  if (["obc", "bc"].includes(normalizedValue)) {
    return "OBC";
  }
  if (normalizedValue === "general") {
    return "General";
  }

  return "";
}

function buildUserPayload(body) {
  const occupationType = normalizeOccupationType(
    getFirstValue(body, ["occupationType", "occupation", "type", "politicianOrShopkeeper"])
  );
  const category = normalizeCategory(getFirstValue(body, ["category", "Category"]));

  return {
    name: getFirstValue(body, ["name", "Name"]),
    mobileNumber: getFirstValue(body, ["mobileNumber", "mobile", "MobileNo", "Mobile Number"]),
    caste: getFirstValue(body, ["caste", "cast", "Cast"]),
    profession: getFirstValue(body, ["profession", "Profession"]),
    occupationType: occupationType || undefined,
    party: getFirstValue(body, ["party", "Party", "politicalParty"]),
    wardNo: getFirstValue(body, ["wardNo", "wardNumber", "Ward NO", "Ward NO:"]),
    gender: getFirstValue(body, ["gender", "Gender"]),
    city: getFirstValue(body, ["city", "City"]),
    category: category || undefined,
    state: getFirstValue(body, ["state", "State"]),
    district: getFirstValue(body, ["district", "District"]),
    userImageUrl: getFirstValue(body, ["userImageUrl", "userImageSource", "userImage"]),
  };
}

function validateUserPayload(payload) {
  const requiredFields = [
    "name",
    "mobileNumber",
    "wardNo",
    "city",
    "state",
  ];
  return requiredFields.filter((field) => !payload[field]);
}

function getUserImageFileName(payload, originalName) {
  const extension = String(originalName || "").match(/\.[^.]+$/)?.[0] || ".jpg";
  const mobile = payload.mobileNumber.replace(/\D/g, "");
  return `user-${mobile || Date.now()}${extension}`;
}

router.post("/users", requireAuth, upload.single("userImage"), async (req, res) => {
  try {
    const body = req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const payload = buildUserPayload(body);
    const missingFields = validateUserPayload(payload);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing.",
        missingFields,
      });
    }

    if (req.file) {
      const uploadResult = await uploadBufferToCloudinary(
        req.file.buffer,
        getUserImageFileName(payload, req.file.originalname),
        {
          folder: process.env.CLOUDINARY_USER_FOLDER || "user-images",
        }
      );

      payload.userImageUrl = uploadResult.imageUrl;
      payload.userImagePublicId = uploadResult.publicId;
    }

    const user = await User.create(payload);

    return res.status(201).json({
      success: true,
      message: "User data saved successfully.",
      data: user,
    });
  } catch (error) {
    if (error && error.code === 11000 && error.keyPattern && error.keyPattern.mobileNumber) {
      return res.status(409).json({
        success: false,
        message: "Mobile number already exists.",
        field: "mobileNumber",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to save user data.",
      error: getErrorMessage(error),
    });
  }
});

module.exports = {
  router,
};
