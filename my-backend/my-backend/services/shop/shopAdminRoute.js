const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const Product = require("../../models/Product");
const { requireAuth } = require("../../middleware/requireAuth");
const { uploadBufferToCloudinary } = require("../cloudnaryService");
const {
  normalizeShopSlug,
  normalizeProductId,
  slugify,
  formatProductSummary,
} = require("../../utils/shopHelpers");
const {
  resolveShopBySlug,
  listMerchantsForAdmin,
} = require("../../utils/shopUserSync");

const router = express.Router();
const MAX_PRODUCT_IMAGES = 12;

const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: MAX_PRODUCT_IMAGES,
  },
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireDb(req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: "Database is not connected.",
    });
  }
  return next();
}

function parseSizes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseStockBySize(raw, sizes) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw)
      .map(([size, stock]) => [String(size).trim(), Number(stock)])
      .filter(([size, stock]) => size && Number.isFinite(stock) && stock >= 0);
    return new Map(entries);
  }

  const defaultStock = Math.max(0, Number(raw?.defaultStock ?? raw?.stock ?? 0) || 0);
  return new Map(sizes.map((size) => [size, defaultStock]));
}

function parseImageUrls(body) {
  const urls = [];

  if (Array.isArray(body?.images)) {
    body.images.forEach((item) => {
      const value = String(item || "").trim().slice(0, 500);
      if (value) {
        urls.push(value);
      }
    });
  }

  const imageUrlsText = body?.imageUrls;
  if (typeof imageUrlsText === "string" && imageUrlsText.trim()) {
    imageUrlsText
      .split(/[\n,]+/)
      .map((item) => item.trim().slice(0, 500))
      .filter(Boolean)
      .forEach((value) => urls.push(value));
  }

  const singleUrl = String(body?.imageUrl || "").trim().slice(0, 500);
  if (singleUrl) {
    urls.unshift(singleUrl);
  }

  return [...new Set(urls)].slice(0, MAX_PRODUCT_IMAGES);
}

async function uploadProductImages(files) {
  const urls = [];

  for (const file of files || []) {
    const uploaded = await uploadBufferToCloudinary(
      file.buffer,
      file.originalname,
      { folder: "shop-products" },
    );
    if (uploaded?.imageUrl) {
      urls.push(uploaded.imageUrl);
    }
  }

  return urls;
}

function sanitizeProductInput(body) {
  const name = String(body?.name || "").trim().slice(0, 200);
  const productId = normalizeProductId(
    body?.productId || slugify(body?.name || ""),
  );
  const description = String(body?.description || "").trim().slice(0, 10000);
  const category = body?.category === "readywear" ? "readywear" : "other";
  const price = Number(body?.price);
  const imageUrls = parseImageUrls(body);
  const isActive = body?.isActive !== false;

  return {
    name,
    productId,
    description,
    category,
    price,
    imageUrls,
    isActive,
    sizes: category === "readywear" ? parseSizes(body?.sizes) : [],
    stock: category === "other" ? Math.max(0, Number(body?.stock) || 0) : 0,
    stockBySize:
      category === "readywear"
        ? parseStockBySize(body?.stockBySize, parseSizes(body?.sizes))
        : undefined,
  };
}

function validateProductInput(product) {
  if (!product.name) {
    return "Product name is required.";
  }
  if (!product.productId) {
    return "Product id is required.";
  }
  if (!Number.isFinite(product.price) || product.price < 0) {
    return "Valid price is required.";
  }
  if (product.category === "readywear" && product.sizes.length === 0) {
    return "At least one size is required for readywear.";
  }
  return null;
}

router.use(requireDb);

/** GET /shop/admin/shops — list merchants from Shopkeeper users in DB */
router.get("/shop/admin/shops", requireAuth, async (req, res) => {
  try {
    const shops = await listMerchantsForAdmin();

    return res.status(200).json({
      success: true,
      shops,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load shops.",
      error: getErrorMessage(error),
    });
  }
});

/** GET /shop/admin/:shopSlug/products — all products for admin list */
router.get("/shop/admin/:shopSlug/products", requireAuth, async (req, res) => {
  try {
    const shopSlug = normalizeShopSlug(req.params.shopSlug);
    if (!shopSlug) {
      return res.status(400).json({
        success: false,
        message: "Invalid shop name.",
      });
    }

    const shop = await resolveShopBySlug(shopSlug);
    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Shop not found. Register a user with occupation Shop first.",
      });
    }

    const products = await Product.find({ shopSlug: shop.slug })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      shop: {
        id: String(shop._id),
        name: shop.name,
        slug: shop.slug,
      },
      products: products.map(formatProductSummary),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load products.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/admin/:shopSlug/products — add a product */
router.post(
  "/shop/admin/:shopSlug/products",
  requireAuth,
  productImageUpload.array("productImages", MAX_PRODUCT_IMAGES),
  async (req, res) => {
  try {
    const shopSlug = normalizeShopSlug(req.params.shopSlug);
    if (!shopSlug) {
      return res.status(400).json({
        success: false,
        message: "Invalid shop name.",
      });
    }

    const shop = await resolveShopBySlug(shopSlug);
    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Shop not found. Register a user with occupation Shop first.",
      });
    }

    const input = sanitizeProductInput(req.body);
    const validationError = validateProductInput(input);
    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const existing = await Product.findOne({
      shopSlug: shop.slug,
      productId: input.productId,
    }).lean();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "A product with this id already exists.",
      });
    }

    const uploadedImages = await uploadProductImages(req.files);
    const images = [...input.imageUrls, ...uploadedImages].slice(
      0,
      MAX_PRODUCT_IMAGES,
    );

    const payload = {
      shopId: shop._id,
      shopSlug: shop.slug,
      productId: input.productId,
      name: input.name,
      description: input.description,
      images,
      category: input.category,
      sizes: input.sizes,
      price: input.price,
      isActive: input.isActive,
    };

    if (input.category === "readywear") {
      payload.stockBySize = input.stockBySize;
    } else {
      payload.stock = input.stock;
    }

    const product = await Product.create(payload);

    return res.status(201).json({
      success: true,
      product: formatProductSummary(product.toObject()),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to add product.",
      error: getErrorMessage(error),
    });
  }
},
);

module.exports = { router };
