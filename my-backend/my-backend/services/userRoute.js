const express = require("express");
const multer = require("multer");
const User = require("../models/User");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const { uploadBufferToCloudinary } = require("./cloudnaryService");
const { normalizeEnhancePriority } = require("../utils/posterEnhancementService");
const { getFacebookStatusByUserIds } = require("./facebookPostService");

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

  if (["politician", "polition", "leader"].includes(normalizedValue)) {
    return "Politician";
  }
  if (["shopkeeper", "shop"].includes(normalizedValue)) {
    return "Shopkeeper";
  }

  return "";
}

function applyOccupationFields(payload, body) {
  const post = getFirstValue(body, ["post", "Post", "profession", "Profession"]);
  const address = getFirstValue(body, ["address", "Address", "shopAddress"]);
  const party = getFirstValue(body, ["party", "Party", "politicalParty"]);
  const shopType = getFirstValue(body, ["shopType", "ShopType", "shop_type"]);

  payload.address = address;
  payload.shopType = shopType;

  if (payload.occupationType === "Politician") {
    payload.post = post;
    payload.party = party;
    payload.shopType = "";
    return payload;
  }

  if (payload.occupationType === "Shopkeeper") {
    if (!payload.address) {
      payload.address = post;
    }
    payload.post = "";
    payload.party = "";
    return payload;
  }

  payload.post = post;
  payload.party = party;
  payload.shopType = "";
  return payload;
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

  const payload = {
    name: getFirstValue(body, ["name", "Name"]),
    mobileNumber: getFirstValue(body, ["mobileNumber", "mobile", "MobileNo", "Mobile Number"]).replace(/\D/g, ""),
    caste: getFirstValue(body, ["caste", "cast", "Cast"]),
    occupationType: occupationType || undefined,
    wardNo: getFirstValue(body, ["wardNo", "wardNumber", "Ward NO", "Ward NO:"]),
    gender: getFirstValue(body, ["gender", "Gender"]),
    city: getFirstValue(body, ["city", "City"]),
    category: category || undefined,
    state: getFirstValue(body, ["state", "State"]),
    district: getFirstValue(body, ["district", "District"]),
    pincode: getFirstValue(body, ["pincode", "pinCode", "Pincode", "zip"]).replace(/\D/g, ""),
    userImageUrl: getFirstValue(body, ["userImageUrl", "userImageSource", "userImage"]),
    enhancePriority: normalizeEnhancePriority(
      getFirstValue(body, ["enhancePriority", "EnhancePriority", "posterQuality", "posterPriority"]),
      "medium"
    ),
    post: "",
    address: "",
    party: "",
  };

  return applyOccupationFields(payload, body);
}

function validateUserPayload(payload) {
  const requiredFields = [
    "name",
    "mobileNumber",
    "city",
    "state",
    "pincode",
  ];

  if (payload.occupationType !== "Shopkeeper") {
    requiredFields.push("wardNo");
  }

  return requiredFields.filter((field) => !payload[field]);
}

function validateFieldFormats(payload) {
  const errors = [];

  if (payload.mobileNumber && !/^\d{10}$/.test(payload.mobileNumber.replace(/\D/g, ""))) {
    errors.push({
      field: "mobileNumber",
      message: "Mobile number must be 10 digits.",
    });
  }

  if (payload.pincode && !/^\d{6}$/.test(payload.pincode)) {
    errors.push({
      field: "pincode",
      message: "Pincode must be 6 digits.",
    });
  }

  return errors;
}

function formatUserResponse(user) {
  return {
    _id: user._id,
    name: user.name,
    mobileNumber: user.mobileNumber,
    caste: user.caste || "",
    occupationType: user.occupationType || "",
    post: user.post || "",
    address: user.address || "",
    shopType: user.shopType || "",
    party: user.party || "",
    wardNo: user.wardNo,
    gender: user.gender || "",
    city: user.city,
    category: user.category || "",
    state: user.state,
    district: user.district || "",
    pincode: user.pincode,
    userImageUrl: user.userImageUrl || "",
    userImagePublicId: user.userImagePublicId || "",
    enhancePriority: user.enhancePriority || "medium",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function buildUserSearchQuery(search) {
  const term = String(search || "").trim();
  if (!term) {
    return {};
  }

  const pattern = new RegExp(
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i"
  );

  return {
    $or: [
      { name: pattern },
      { mobileNumber: pattern },
      { city: pattern },
      { state: pattern },
      { district: pattern },
      { pincode: pattern },
      { wardNo: pattern },
      { party: pattern },
      { post: pattern },
      { address: pattern },
      { shopType: pattern },
      { caste: pattern },
      { category: pattern },
      { occupationType: pattern },
      { enhancePriority: pattern },
    ],
  };
}

function getUserImageFileName(payload, originalName) {
  const extension = String(originalName || "").match(/\.[^.]+$/)?.[0] || ".jpg";
  const mobile = payload.mobileNumber.replace(/\D/g, "");
  return `user-${mobile || Date.now()}${extension}`;
}

router.post("/users", requireAuth, requireDb, upload.single("userImage"), async (req, res) => {
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

    const formatErrors = validateFieldFormats(payload);
    if (formatErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: formatErrors[0].message,
        errors: formatErrors,
      });
    }

    if (req.file) {
      try {
        const uploadResult = await uploadBufferToCloudinary(
          req.file.buffer,
          getUserImageFileName(payload, req.file.originalname),
          {
            folder: process.env.CLOUDINARY_USER_FOLDER || "user-images",
          }
        );

        payload.userImageUrl = uploadResult.imageUrl;
        payload.userImagePublicId = uploadResult.publicId;
      } catch (uploadError) {
        return res.status(502).json({
          success: false,
          message: "Failed to upload user image to Cloudinary.",
          error: getErrorMessage(uploadError),
        });
      }
    }

    const user = await User.create(payload);

    return res.status(201).json({
      success: true,
      message: "User data saved successfully.",
      data: formatUserResponse(user),
    });
  } catch (error) {
    if (error && error.name === "MongooseError" && /buffering timed out/i.test(error.message)) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected. Check MONGO_URI on Render and Atlas Network Access.",
      });
    }

    if (error && error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors || {}).map((entry) => ({
        field: entry.path,
        message: entry.message,
      }));

      return res.status(400).json({
        success: false,
        message: validationErrors[0]?.message || "Validation failed.",
        errors: validationErrors,
      });
    }

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

router.get("/users", requireAuth, requireDb, async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const users = await User.find(buildUserSearchQuery(search))
      .sort({ createdAt: -1 })
      .select("-__v");

    const facebookByUser = await getFacebookStatusByUserIds(users.map((user) => user._id));
    const defaultFacebook = {
      facebookConnected: false,
      facebookPageSelected: false,
      facebookPageName: null,
    };

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully.",
      count: users.length,
      data: users.map((user) => ({
        ...formatUserResponse(user),
        facebook: facebookByUser.get(String(user._id)) || defaultFacebook,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch users.",
      error: getErrorMessage(error),
    });
  }
});

router.put("/users/:id", requireAuth, requireDb, upload.single("userImage"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const existingUser = await User.findById(id);

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

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

    const formatErrors = validateFieldFormats(payload);
    if (formatErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: formatErrors[0].message,
        errors: formatErrors,
      });
    }

    if (req.file) {
      try {
        const uploadResult = await uploadBufferToCloudinary(
          req.file.buffer,
          getUserImageFileName(payload, req.file.originalname),
          {
            folder: process.env.CLOUDINARY_USER_FOLDER || "user-images",
          }
        );

        payload.userImageUrl = uploadResult.imageUrl;
        payload.userImagePublicId = uploadResult.publicId;
      } catch (uploadError) {
        return res.status(502).json({
          success: false,
          message: "Failed to upload user image to Cloudinary.",
          error: getErrorMessage(uploadError),
        });
      }
    } else {
      payload.userImageUrl = existingUser.userImageUrl || "";
      payload.userImagePublicId = existingUser.userImagePublicId || "";
    }

    Object.assign(existingUser, payload);
    await existingUser.save();

    return res.status(200).json({
      success: true,
      message: "User updated successfully.",
      data: formatUserResponse(existingUser),
    });
  } catch (error) {
    if (error && error.name === "MongooseError" && /buffering timed out/i.test(error.message)) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected. Check MONGO_URI on Render and Atlas Network Access.",
      });
    }

    if (error && error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors || {}).map((entry) => ({
        field: entry.path,
        message: entry.message,
      }));

      return res.status(400).json({
        success: false,
        message: validationErrors[0]?.message || "Validation failed.",
        errors: validationErrors,
      });
    }

    if (error && error.code === 11000 && error.keyPattern && error.keyPattern.mobileNumber) {
      return res.status(409).json({
        success: false,
        message: "Mobile number already exists.",
        field: "mobileNumber",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update user.",
      error: getErrorMessage(error),
    });
  }
});

router.get("/users/:id", requireAuth, requireDb, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const user = await User.findById(id).select("-__v");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const facebookByUser = await getFacebookStatusByUserIds([user._id]);
    const defaultFacebook = {
      facebookConnected: false,
      facebookPageSelected: false,
      facebookPageName: null,
    };

    return res.status(200).json({
      success: true,
      message: "User fetched successfully.",
      data: {
        ...formatUserResponse(user),
        facebook: facebookByUser.get(String(user._id)) || defaultFacebook,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user.",
      error: getErrorMessage(error),
    });
  }
});

module.exports = {
  router,
};
