const Shop = require("../models/Shop");
const Product = require("../models/Product");
const User = require("../models/User");
const { slugify, formatShopAdminSummary, formatShopForPublic } = require("./shopHelpers");

function buildShopDescription(user) {
  return [user.shopType, user.address, user.city].filter(Boolean).join(" · ");
}

function getUserShopSlug(user) {
  const baseSlug = slugify(user.name);
  if (baseSlug) {
    return baseSlug;
  }
  return `shop-${String(user._id).slice(-8)}`;
}

async function ensureUniqueSlug(baseSlug, userId) {
  let slug = baseSlug;
  let attempt = 0;

  while (attempt < 5) {
    const existing = await Shop.findOne({ slug }).lean();
    if (!existing || String(existing.userId) === String(userId)) {
      return slug;
    }
    attempt += 1;
    slug = `${baseSlug}-${String(userId).slice(-6)}`;
  }

  return `${baseSlug}-${Date.now().toString(36)}`;
}

async function ensureShopForUser(user) {
  const plainUser =
    typeof user.toObject === "function" ? user.toObject({ depopulate: true }) : user;

  let shop = await Shop.findOne({ userId: plainUser._id });
  const description = buildShopDescription(plainUser);

  if (shop) {
    shop.name = plainUser.name;
    shop.description = description;
    shop.isActive = true;
    await shop.save();
    return shop;
  }

  const slug = await ensureUniqueSlug(getUserShopSlug(plainUser), plainUser._id);

  shop = await Shop.create({
    name: plainUser.name,
    slug,
    description,
    isActive: true,
    userId: plainUser._id,
  });

  return shop;
}

async function syncAllShopkeeperShops() {
  const users = await User.find({
    $or: [
      { occupationType: "Shopkeeper" },
      { shopType: { $exists: true, $nin: ["", null] } },
    ],
  })
    .sort({ name: 1 })
    .lean();

  const shops = [];
  for (const user of users) {
    shops.push(await ensureShopForUser(user));
  }
  return shops;
}

async function resolveShopBySlug(shopSlug) {
  const shop = await Shop.findOne({ slug: shopSlug }).lean();
  if (shop) {
    return shop;
  }

  const shopkeepers = await User.find({ occupationType: "Shopkeeper" }).lean();
  const matchedUser = shopkeepers.find(
    (user) => getUserShopSlug(user) === shopSlug,
  );

  if (!matchedUser) {
    return null;
  }

  const ensured = await ensureShopForUser(matchedUser);
  return typeof ensured.toObject === "function"
    ? ensured.toObject({ depopulate: true })
    : ensured;
}

async function listMerchantsForAdmin() {
  const syncedShops = await syncAllShopkeeperShops();
  const shops = syncedShops
    .map((shop) =>
      typeof shop.toObject === "function"
        ? shop.toObject({ depopulate: true })
        : shop,
    )
    .filter((shop) => shop.userId);

  const shopSlugs = shops.map((shop) => shop.slug);
  const productCounts = shopSlugs.length
    ? await Product.aggregate([
        { $match: { shopSlug: { $in: shopSlugs } } },
        { $group: { _id: "$shopSlug", count: { $sum: 1 } } },
      ])
    : [];

  const countBySlug = new Map(
    productCounts.map((row) => [String(row._id), row.count]),
  );

  const userIds = shops.map((shop) => shop.userId).filter(Boolean);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select("name shopType city occupationType")
        .lean()
    : [];
  const userById = new Map(users.map((user) => [String(user._id), user]));

  return shops.map((shop) => {
    const user = shop.userId ? userById.get(String(shop.userId)) : null;
    const summary = formatShopAdminSummary(shop, countBySlug.get(shop.slug) || 0);
    return {
      ...summary,
      shopType: user?.shopType || "",
      city: user?.city || "",
      userId: user ? String(user._id) : String(shop.userId),
    };
  });
}

function normalizeOwnerPhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

async function formatShopForPublicWithOwner(shop) {
  const base = formatShopForPublic(shop);
  if (!shop?.userId) {
    return { ...base, ownerPhone: "" };
  }

  const user = await User.findById(shop.userId).select("mobileNumber").lean();
  return {
    ...base,
    ownerPhone: normalizeOwnerPhone(user?.mobileNumber),
  };
}

module.exports = {
  buildShopDescription,
  getUserShopSlug,
  ensureShopForUser,
  syncAllShopkeeperShops,
  resolveShopBySlug,
  listMerchantsForAdmin,
  formatShopForPublicWithOwner,
};
