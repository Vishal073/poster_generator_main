const { normalizeEnhancePriority } = require("./posterEnhancementService");

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
    getFirstValue(body, ["occupationType", "occupation", "type", "politicianOrShopkeeper"]),
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
      "medium",
    ),
    post: "",
    address: "",
    party: "",
  };

  return applyOccupationFields(payload, body);
}

function validateUserPayload(payload) {
  const requiredFields = ["name", "mobileNumber", "city", "state", "pincode"];

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

function getUserImageFileName(payload, originalName) {
  const extension = String(originalName || "").match(/\.[^.]+$/)?.[0] || ".jpg";
  const mobile = payload.mobileNumber.replace(/\D/g, "");
  return `user-${mobile || Date.now()}${extension}`;
}

module.exports = {
  buildUserPayload,
  validateUserPayload,
  validateFieldFormats,
  getUserImageFileName,
};
