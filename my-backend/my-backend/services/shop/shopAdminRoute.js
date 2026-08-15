const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const Product = require("../../models/Product");
const Shop = require("../../models/Shop");
const Order = require("../../models/Order");
const { requireAuth } = require("../../middleware/requireAuth");
const { uploadBufferToCloudinary } = require("../cloudnaryService");
const {
  normalizeShopSlug,
  normalizeProductId,
  slugify,
  formatProductSummary,
  formatShopForAdmin,
  formatOrderForClient,
  normalizeUpiId,
  isValidUpiId,
} = require("../../utils/shopHelpers");
const {
  resolveShopBySlug,
  listMerchantsForAdmin,
} = require("../../utils/shopUserSync");
const { finalizeShopOrderPayment } = require("./shopOrderPayment");

const router = express.Router();
const MAX_PRODUCT_IMAGES = 12;
const MAX_PRODUCT_VIDEOS = 3;
const MAX_COLOR_OPTIONS = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const colorImageFields = Array.from({ length: MAX_COLOR_OPTIONS }, (_, index) => ({
  name: `colorImages_${index}`,
  maxCount: MAX_PRODUCT_IMAGES,
}));

const productMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_BYTES,
    files:
      MAX_PRODUCT_IMAGES +
      MAX_PRODUCT_VIDEOS +
      MAX_COLOR_OPTIONS * MAX_PRODUCT_IMAGES,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "productImages") {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return cb(new Error("Only image files are allowed for product images."));
      }
      return cb(null, true);
    }

    if (file.fieldname === "productVideos") {
      if (!file.mimetype || !file.mimetype.startsWith("video/")) {
        return cb(new Error("Only video files are allowed for product videos."));
      }
      return cb(null, true);
    }

    if (/^colorImages_\d+$/.test(file.fieldname)) {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return cb(new Error("Only image files are allowed for color images."));
      }
      return cb(null, true);
    }

    return cb(new Error(`Unexpected upload field: ${file.fieldname}`));
  },
}).fields([
  { name: "productImages", maxCount: MAX_PRODUCT_IMAGES },
  { name: "productVideos", maxCount: MAX_PRODUCT_VIDEOS },
  ...colorImageFields,
]);

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

function getUploadedFiles(req, fieldName) {
  if (Array.isArray(req.files?.[fieldName])) {
    return req.files[fieldName];
  }

  if (Array.isArray(req.files)) {
    return req.files.filter((file) => file.fieldname === fieldName);
  }

  return [];
}

function assertFileSizes(files, maxBytes, label) {
  for (const file of files) {
    if (file.size > maxBytes) {
      const error = new Error(`${label} must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`);
      error.statusCode = 400;
      throw error;
    }
  }
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

function parseMediaUrls(body, options) {
  const urls = [];
  const arrayKey = options.arrayKey;
  const textKey = options.textKey;
  const singleKey = options.singleKey;
  const maxCount = options.maxCount;

  if (Array.isArray(body?.[arrayKey])) {
    body[arrayKey].forEach((item) => {
      const value = String(item || "").trim().slice(0, 500);
      if (value) {
        urls.push(value);
      }
    });
  }

  const textValue = body?.[textKey];
  if (typeof textValue === "string" && textValue.trim()) {
    textValue
      .split(/[\n,]+/)
      .map((item) => item.trim().slice(0, 500))
      .filter(Boolean)
      .forEach((value) => urls.push(value));
  }

  const singleUrl = String(body?.[singleKey] || "").trim().slice(0, 500);
  if (singleUrl) {
    urls.unshift(singleUrl);
  }

  return [...new Set(urls)].slice(0, maxCount);
}

function parseImageUrls(body) {
  return parseMediaUrls(body, {
    arrayKey: "images",
    textKey: "imageUrls",
    singleKey: "imageUrl",
    maxCount: MAX_PRODUCT_IMAGES,
  });
}

function parseVideoUrls(body) {
  return parseMediaUrls(body, {
    arrayKey: "videos",
    textKey: "videoUrls",
    singleKey: "videoUrl",
    maxCount: MAX_PRODUCT_VIDEOS,
  });
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

async function uploadProductVideos(files) {
  const urls = [];

  for (const file of files || []) {
    const uploaded = await uploadBufferToCloudinary(
      file.buffer,
      file.originalname,
      {
        folder: "shop-products",
        resource_type: "video",
      },
    );
    if (uploaded?.videoUrl) {
      urls.push(uploaded.videoUrl);
    }
  }

  return urls;
}

function parseColorOptionImageUrls(item) {
  const urls = [];

  if (Array.isArray(item?.imageUrls)) {
    item.imageUrls.forEach((value) => {
      const url = String(value || "").trim().slice(0, 500);
      if (url) {
        urls.push(url);
      }
    });
  } else if (typeof item?.imageUrls === "string" && item.imageUrls.trim()) {
    item.imageUrls
      .split(/[\n,]+/)
      .map((value) => value.trim().slice(0, 500))
      .filter(Boolean)
      .forEach((value) => urls.push(value));
  } else if (Array.isArray(item?.images)) {
    item.images.forEach((value) => {
      const url = String(value || "").trim().slice(0, 500);
      if (url) {
        urls.push(url);
      }
    });
  }

  return [...new Set(urls)].slice(0, MAX_PRODUCT_IMAGES);
}

async function parseColorOptions(body, req, category, sizes, defaultStock) {
  let raw = body?.colorOptions;
  if (typeof raw === "string" && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  const options = [];

  for (let index = 0; index < raw.length && index < MAX_COLOR_OPTIONS; index += 1) {
    const item = raw[index];
    const name = String(item?.name || "").trim().slice(0, 80);
    if (!name) {
      continue;
    }

    const imageUrls = parseColorOptionImageUrls(item);
    const uploadedFiles = getUploadedFiles(req, `colorImages_${index}`);
    assertFileSizes(uploadedFiles, MAX_IMAGE_BYTES, "Each color image");
    const uploadedImages = await uploadProductImages(uploadedFiles);
    const images = [...imageUrls, ...uploadedImages].slice(0, MAX_PRODUCT_IMAGES);
    const stock = Math.max(0, Number(item?.stock ?? defaultStock) || 0);

    const option = {
      name,
      images,
      stock: category === "other" ? stock : 0,
    };

    if (category === "readywear") {
      option.stockBySize = parseStockBySize(
        item?.stockBySize || { defaultStock: item?.stock ?? defaultStock },
        sizes,
      );
    }

    options.push(option);
  }

  return options;
}

function flattenColorOptionImages(colorOptions) {
  return colorOptions.flatMap((option) => option.images || []).slice(0, MAX_PRODUCT_IMAGES);
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
  const videoUrls = parseVideoUrls(body);
  const isActive = body?.isActive !== false;
  const sizes = category === "readywear" ? parseSizes(body?.sizes) : [];
  const defaultStock =
    category === "other"
      ? Math.max(0, Number(body?.stock) || 0)
      : Math.max(0, Number(body?.defaultStock ?? body?.stock) || 0);

  return {
    name,
    productId,
    description,
    category,
    price,
    imageUrls,
    videoUrls,
    isActive,
    sizes,
    stock: category === "other" ? defaultStock : 0,
    stockBySize:
      category === "readywear"
        ? parseStockBySize(body?.stockBySize, sizes)
        : undefined,
    defaultStock,
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

function validateColorOptions(colorOptions) {
  const names = new Set();
  for (const option of colorOptions) {
    if (names.has(option.name)) {
      return "Each color name must be unique.";
    }
    names.add(option.name);
    if (!option.images || option.images.length === 0) {
      return `Add at least one image for color "${option.name}".`;
    }
  }
  return null;
}

async function resolveUploadedMedia(req, input) {
  const imageFiles = getUploadedFiles(req, "productImages");
  const videoFiles = getUploadedFiles(req, "productVideos");

  assertFileSizes(imageFiles, MAX_IMAGE_BYTES, "Each image");
  assertFileSizes(videoFiles, MAX_VIDEO_BYTES, "Each video");

  const uploadedImages = await uploadProductImages(imageFiles);
  const uploadedVideos = await uploadProductVideos(videoFiles);
  const colorOptions = await parseColorOptions(
    req.body,
    req,
    input.category,
    input.sizes,
    input.defaultStock,
  );

  const hasColorOptions = colorOptions.length > 0;
  const fallbackImages = [...input.imageUrls, ...uploadedImages].slice(
    0,
    MAX_PRODUCT_IMAGES,
  );

  return {
    images: hasColorOptions ? flattenColorOptionImages(colorOptions) : fallbackImages,
    videos: [...input.videoUrls, ...uploadedVideos].slice(0, MAX_PRODUCT_VIDEOS),
    colorOptions,
  };
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
      shop: formatShopForAdmin(shop),
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
  productMediaUpload,
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

      const media = await resolveUploadedMedia(req, input);
      const colorValidationError = validateColorOptions(media.colorOptions);
      if (colorValidationError) {
        return res.status(400).json({
          success: false,
          message: colorValidationError,
        });
      }

      const payload = {
        shopId: shop._id,
        shopSlug: shop.slug,
        productId: input.productId,
        name: input.name,
        description: input.description,
        images: media.images,
        videos: media.videos,
        colorOptions: media.colorOptions,
        category: input.category,
        sizes: input.sizes,
        price: input.price,
        isActive: input.isActive,
      };

      if (media.colorOptions.length > 0) {
        payload.stock = 0;
        payload.stockBySize = undefined;
      } else if (input.category === "readywear") {
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
      const statusCode = error?.statusCode === 400 ? 400 : 500;
      return res.status(statusCode).json({
        success: false,
        message: error?.statusCode === 400 ? getErrorMessage(error) : "Failed to add product.",
        error: getErrorMessage(error),
      });
    }
  },
);

/** PUT /shop/admin/:shopSlug/products/:productId — update a product (admin only) */
router.put(
  "/shop/admin/:shopSlug/products/:productId",
  requireAuth,
  productMediaUpload,
  async (req, res) => {
    try {
      const shopSlug = normalizeShopSlug(req.params.shopSlug);
      const currentProductId = normalizeProductId(req.params.productId);

      if (!shopSlug || !currentProductId) {
        return res.status(400).json({
          success: false,
          message: "Invalid shop or product id.",
        });
      }

      const shop = await resolveShopBySlug(shopSlug);
      if (!shop) {
        return res.status(404).json({
          success: false,
          message: "Shop not found.",
        });
      }

      const existing = await Product.findOne({
        shopSlug: shop.slug,
        productId: currentProductId,
      });

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Product not found.",
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

      const media = await resolveUploadedMedia(req, input);
      const colorValidationError = validateColorOptions(media.colorOptions);
      if (colorValidationError) {
        return res.status(400).json({
          success: false,
          message: colorValidationError,
        });
      }

      existing.name = input.name;
      existing.description = input.description;
      existing.category = input.category;
      existing.price = input.price;
      existing.sizes = input.sizes;
      existing.images = media.images;
      existing.videos = media.videos;
      existing.colorOptions = media.colorOptions;
      existing.isActive = input.isActive;

      if (media.colorOptions.length > 0) {
        existing.stock = 0;
        existing.stockBySize = undefined;
      } else if (input.category === "readywear") {
        existing.stockBySize = input.stockBySize;
        existing.stock = 0;
      } else {
        existing.stock = input.stock;
        existing.stockBySize = undefined;
      }

      await existing.save();

      return res.status(200).json({
        success: true,
        product: formatProductSummary(existing.toObject()),
      });
    } catch (error) {
      const statusCode = error?.statusCode === 400 ? 400 : 500;
      return res.status(statusCode).json({
        success: false,
        message:
          error?.statusCode === 400 ? getErrorMessage(error) : "Failed to update product.",
        error: getErrorMessage(error),
      });
    }
  },
);

function getMongoId(value) {
  const id = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }
  return id;
}

/** PUT /shop/admin/:shopSlug/settings — UPI payment settings */
router.put("/shop/admin/:shopSlug/settings", requireAuth, async (req, res) => {
  try {
    const shopSlug = normalizeShopSlug(req.params.shopSlug);
    if (!shopSlug) {
      return res.status(400).json({
        success: false,
        message: "Invalid shop name.",
      });
    }

    const shop = await Shop.findOne({ slug: shopSlug });
    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Shop not found.",
      });
    }

    const upiId = normalizeUpiId(req.body?.upiId);
    const upiPayeeName = String(req.body?.upiPayeeName || "")
      .trim()
      .slice(0, 120);

    if (upiId && !isValidUpiId(upiId)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid UPI ID (e.g. name@paytm or 9876543210@ybl).",
      });
    }

    shop.upiId = upiId;
    shop.upiPayeeName = upiPayeeName || shop.name;
    await shop.save();

    return res.status(200).json({
      success: true,
      shop: formatShopForAdmin(shop.toObject()),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to save shop settings.",
      error: getErrorMessage(error),
    });
  }
});

/** GET /shop/admin/orders — all orders across shops (register before :shopSlug route) */
router.get("/shop/admin/orders", requireAuth, async (req, res) => {
  try {
    const query = {};
    const shopSlug = normalizeShopSlug(req.query.shopSlug || req.query.shop);

    if (shopSlug) {
      query.shopSlug = shopSlug;
    }

    const paymentStatus = String(req.query.paymentStatus || "").trim();
    const allowedPaymentStatuses = [
      "pending",
      "awaiting_confirmation",
      "paid",
      "failed",
    ];
    if (paymentStatus && allowedPaymentStatuses.includes(paymentStatus)) {
      query.paymentStatus = paymentStatus;
    }

    const fulfillmentStatus = String(req.query.fulfillmentStatus || "").trim();
    const allowedFulfillmentStatuses = [
      "pending",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
    ];
    if (
      fulfillmentStatus &&
      allowedFulfillmentStatuses.includes(fulfillmentStatus)
    ) {
      query.fulfillmentStatus = fulfillmentStatus;
    }

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.status(200).json({
      success: true,
      orders: orders.map(formatOrderForClient),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load orders.",
      error: getErrorMessage(error),
    });
  }
});

/** GET /shop/admin/:shopSlug/orders — orders for one shop */
router.get("/shop/admin/:shopSlug/orders", requireAuth, async (req, res) => {
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
        message: "Shop not found.",
      });
    }

    const orders = await Order.find({ shopSlug: shop.slug })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({
      success: true,
      orders: orders.map(formatOrderForClient),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load orders.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/admin/:shopSlug/orders/:orderId/confirm-payment */
router.post(
  "/shop/admin/:shopSlug/orders/:orderId/confirm-payment",
  requireAuth,
  async (req, res) => {
    try {
      const shopSlug = normalizeShopSlug(req.params.shopSlug);
      const orderId = getMongoId(req.params.orderId);

      if (!shopSlug || !orderId) {
        return res.status(400).json({
          success: false,
          message: "Invalid shop or order id.",
        });
      }

      const shop = await resolveShopBySlug(shopSlug);
      if (!shop) {
        return res.status(404).json({
          success: false,
          message: "Shop not found.",
        });
      }

      const order = await Order.findOne({ _id: orderId, shopSlug: shop.slug });
      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      if (
        order.paymentStatus !== "awaiting_confirmation" &&
        order.paymentStatus !== "pending"
      ) {
        return res.status(409).json({
          success: false,
          message: "This order cannot be confirmed.",
        });
      }

      const result = await finalizeShopOrderPayment(order, {
        paymentGateway: "upi_manual",
      });

      return res.status(result.status).json({
        success: result.ok,
        order: result.order,
        message: result.message,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to confirm payment.",
        error: getErrorMessage(error),
      });
    }
  },
);

const VALID_FULFILLMENT_STATUSES = new Set([
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);

/** POST /shop/admin/:shopSlug/orders/:orderId/fulfillment */
router.post(
  "/shop/admin/:shopSlug/orders/:orderId/fulfillment",
  requireAuth,
  async (req, res) => {
    try {
      const shopSlug = normalizeShopSlug(req.params.shopSlug);
      const orderId = getMongoId(req.params.orderId);

      if (!shopSlug || !orderId) {
        return res.status(400).json({
          success: false,
          message: "Invalid shop or order id.",
        });
      }

      const shop = await resolveShopBySlug(shopSlug);
      if (!shop) {
        return res.status(404).json({
          success: false,
          message: "Shop not found.",
        });
      }

      const order = await Order.findOne({ _id: orderId, shopSlug: shop.slug });
      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      if (order.paymentStatus !== "paid") {
        return res.status(409).json({
          success: false,
          message: "Only paid orders can be updated for fulfillment.",
        });
      }

      const fulfillmentStatus = String(req.body?.fulfillmentStatus || "")
        .trim()
        .toLowerCase();

      if (!VALID_FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
        return res.status(400).json({
          success: false,
          message: "Valid fulfillment status is required.",
        });
      }

      const trackingNumber = String(req.body?.trackingNumber || "")
        .trim()
        .slice(0, 120);
      const fulfillmentNotes = String(req.body?.fulfillmentNotes || "")
        .trim()
        .slice(0, 500);

      order.fulfillmentStatus = fulfillmentStatus;
      order.trackingNumber = trackingNumber;
      order.fulfillmentNotes = fulfillmentNotes;

      if (fulfillmentStatus === "shipped" && !order.shippedAt) {
        order.shippedAt = new Date();
      }
      if (fulfillmentStatus === "delivered") {
        if (!order.shippedAt) {
          order.shippedAt = new Date();
        }
        order.deliveredAt = new Date();
      }

      await order.save();

      return res.status(200).json({
        success: true,
        order: formatOrderForClient(order),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to update fulfillment.",
        error: getErrorMessage(error),
      });
    }
  },
);

module.exports = { router };
