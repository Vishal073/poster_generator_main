function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeShopSlug(value) {
  return slugify(value);
}

function normalizeProductId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function readStockMap(stockMap, size) {
  if (stockMap instanceof Map) {
    return Number(stockMap.get(size)) || 0;
  }
  if (stockMap && typeof stockMap === "object") {
    return Number(stockMap[size]) || 0;
  }
  return 0;
}

function formatStockBySize(stockBySize) {
  if (stockBySize instanceof Map) {
    return Object.fromEntries(stockBySize.entries());
  }
  return stockBySize || {};
}

function hasColorOptions(product) {
  return Array.isArray(product?.colorOptions) && product.colorOptions.length > 0;
}

function findColorOption(product, colorName) {
  if (!hasColorOptions(product) || !colorName) {
    return null;
  }
  return product.colorOptions.find((option) => option.name === colorName) || null;
}

function getProductStock(product, size, colorName) {
  if (hasColorOptions(product)) {
    const option = findColorOption(product, colorName);
    if (!option) {
      return 0;
    }

    if (product.category === "readywear") {
      if (!size) {
        return 0;
      }
      return readStockMap(option.stockBySize, size);
    }

    return Number(option.stock) || 0;
  }

  if (product.category === "readywear") {
    if (!size) {
      return 0;
    }
    return readStockMap(product.stockBySize, size);
  }

  return Number(product.stock) || 0;
}

function getTotalProductStock(product) {
  if (hasColorOptions(product)) {
    return product.colorOptions.reduce((sum, option) => {
      if (product.category === "readywear") {
        const stockMap = formatStockBySize(option.stockBySize);
        return (
          sum +
          Object.values(stockMap).reduce(
            (optionSum, count) => optionSum + (Number(count) || 0),
            0,
          )
        );
      }
      return sum + (Number(option.stock) || 0);
    }, 0);
  }

  if (product.category === "readywear") {
    const stockMap = formatStockBySize(product.stockBySize);
    return Object.values(stockMap).reduce(
      (sum, count) => sum + (Number(count) || 0),
      0,
    );
  }

  return Number(product.stock) || 0;
}

function formatColorOptions(product) {
  if (!hasColorOptions(product)) {
    return undefined;
  }

  return product.colorOptions.map((option) => ({
    name: option.name,
    images: option.images || [],
    stock: product.category === "other" ? Number(option.stock) || 0 : undefined,
    stockBySize:
      product.category === "readywear"
        ? formatStockBySize(option.stockBySize)
        : undefined,
  }));
}

function getProductDisplayImages(product) {
  if (hasColorOptions(product)) {
    const colorImages = product.colorOptions.flatMap((option) => option.images || []);
    if (colorImages.length > 0) {
      return colorImages;
    }
  }
  return product.images || [];
}

function formatShopForPublic(shop) {
  return {
    id: String(shop._id),
    name: shop.name,
    slug: shop.slug,
    description: shop.description || "",
    logoUrl: shop.logoUrl || "",
    upiConfigured: Boolean(String(shop.upiId || "").trim()),
  };
}

function formatShopForAdmin(shop) {
  return {
    ...formatShopForPublic(shop),
    upiId: shop.upiId || "",
    upiPayeeName: shop.upiPayeeName || "",
  };
}

function normalizeUpiId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 100);
}

function isValidUpiId(upiId) {
  return /^[\w.-]{2,256}@[\w]{2,64}$/.test(upiId);
}

function buildUpiPaymentUri({ upiId, payeeName, amountInRupees, orderNumber }) {
  const params = new URLSearchParams();
  params.set("pa", upiId);
  if (payeeName) {
    params.set("pn", String(payeeName).trim().slice(0, 120));
  }
  params.set("am", Number(amountInRupees).toFixed(2));
  params.set("cu", "INR");
  params.set("tn", `Order ${orderNumber}`.slice(0, 80));
  params.set("tr", orderNumber.slice(0, 40));
  return `upi://pay?${params.toString()}`;
}

function formatShopAdminSummary(shop, productCount = 0) {
  return {
    ...formatShopForPublic(shop),
    productCount,
  };
}

function formatProductSummary(product) {
  const stockBySize =
    product.stockBySize instanceof Map
      ? Object.fromEntries(product.stockBySize.entries())
      : product.stockBySize || {};

  const colorOptions = formatColorOptions(product);
  const images = getProductDisplayImages(product);

  return {
    id: String(product._id),
    productId: product.productId,
    shopSlug: product.shopSlug,
    name: product.name,
    description: product.description,
    images,
    videos: product.videos || [],
    category: product.category,
    sizes: product.sizes || [],
    colorOptions,
    price: product.price,
    stock:
      product.category === "other" && !colorOptions
        ? getProductStock(product)
        : undefined,
    stockBySize:
      product.category === "readywear" && !colorOptions ? stockBySize : undefined,
  };
}

function formatProductDetail(product) {
  return formatProductSummary(product);
}

function generateOrderNumber() {
  const datePart = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `GCR-${datePart}-${randomPart}`;
}

function sanitizeShippingInput(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    name: String(raw.name || "").trim().slice(0, 120),
    mobile: String(raw.mobile || "").trim().replace(/\D/g, "").slice(0, 10),
    addressLine1: String(raw.addressLine1 || "").trim().slice(0, 200),
    addressLine2: String(raw.addressLine2 || "").trim().slice(0, 200),
    city: String(raw.city || "").trim().slice(0, 80),
    state: String(raw.state || "").trim().slice(0, 80),
    pincode: String(raw.pincode || "").trim().replace(/\D/g, "").slice(0, 6),
    email: String(raw.email || "").trim().slice(0, 120),
  };
}

function validateShipping(shipping) {
  if (!shipping) {
    return "Shipping details are required.";
  }
  if (!shipping.name) {
    return "Full name is required.";
  }
  if (!/^\d{10}$/.test(shipping.mobile)) {
    return "Mobile number must be 10 digits.";
  }
  if (!shipping.addressLine1) {
    return "Address line 1 is required.";
  }
  if (!shipping.city) {
    return "City is required.";
  }
  if (!shipping.state) {
    return "State is required.";
  }
  if (!/^\d{6}$/.test(shipping.pincode)) {
    return "Pincode must be 6 digits.";
  }
  if (shipping.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) {
    return "Email address is invalid.";
  }
  return null;
}

function formatOrderForClient(order) {
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    shopSlug: order.shopSlug,
    productSlug: order.productSlug,
    productName: order.productName,
    size: order.size || null,
    color: order.color || null,
    unitPrice: order.unitPrice,
    quantity: order.quantity,
    amount: order.unitPrice * order.quantity,
    paymentStatus: order.paymentStatus,
    paymentGateway: order.paymentGateway || null,
    shipping: order.shipping,
    createdAt: order.createdAt,
    customerMarkedPaidAt: order.customerMarkedPaidAt || null,
  };
}

async function decrementProductStock(productId, size, colorName) {
  const Product = require("../models/Product");
  const product = await Product.findById(productId);
  if (!product) {
    return { ok: false, message: "Product not found." };
  }

  if (hasColorOptions(product)) {
    const option = product.colorOptions.find((item) => item.name === colorName);
    if (!option) {
      return { ok: false, message: "Invalid color selected." };
    }

    if (product.category === "readywear") {
      if (!size) {
        return { ok: false, message: "Size is required." };
      }

      const current = readStockMap(option.stockBySize, size);
      if (current <= 0) {
        return {
          ok: false,
          message: "Selected size is out of stock for this color.",
        };
      }

      if (!option.stockBySize) {
        option.stockBySize = new Map();
      }
      option.stockBySize.set(size, current - 1);
    } else if (option.stock <= 0) {
      return { ok: false, message: "Selected color is out of stock." };
    } else {
      option.stock -= 1;
    }

    await product.save();
    return { ok: true, product: product.toObject() };
  }

  if (product.category === "readywear") {
    const stockPath = `stockBySize.${size}`;
    const updated = await Product.findOneAndUpdate(
      {
        _id: productId,
        [stockPath]: { $gt: 0 },
      },
      {
        $inc: { [stockPath]: -1 },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return { ok: false, message: "Selected size is out of stock." };
    }

    return { ok: true, product: updated };
  }

  const updated = await Product.findOneAndUpdate(
    {
      _id: productId,
      stock: { $gt: 0 },
    },
    {
      $inc: { stock: -1 },
    },
    { new: true },
  ).lean();

  if (!updated) {
    return { ok: false, message: "Product is out of stock." };
  }

  return { ok: true, product: updated };
}

module.exports = {
  slugify,
  normalizeShopSlug,
  normalizeProductId,
  hasColorOptions,
  getProductStock,
  getTotalProductStock,
  formatShopForPublic,
  formatShopForAdmin,
  formatShopAdminSummary,
  normalizeUpiId,
  isValidUpiId,
  buildUpiPaymentUri,
  formatProductSummary,
  formatProductDetail,
  generateOrderNumber,
  sanitizeShippingInput,
  validateShipping,
  formatOrderForClient,
  decrementProductStock,
};
