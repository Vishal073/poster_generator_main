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

function getProductStock(product, size) {
  if (product.category === "readywear") {
    if (!size) {
      return 0;
    }
    const stockMap = product.stockBySize;
    if (stockMap instanceof Map) {
      return Number(stockMap.get(size)) || 0;
    }
    if (stockMap && typeof stockMap === "object") {
      return Number(stockMap[size]) || 0;
    }
    return 0;
  }
  return Number(product.stock) || 0;
}

function formatShopForPublic(shop) {
  return {
    id: String(shop._id),
    name: shop.name,
    slug: shop.slug,
    description: shop.description || "",
    logoUrl: shop.logoUrl || "",
  };
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

  return {
    id: String(product._id),
    productId: product.productId,
    shopSlug: product.shopSlug,
    name: product.name,
    description: product.description,
    images: product.images || [],
    category: product.category,
    sizes: product.sizes || [],
    price: product.price,
    stock: product.category === "other" ? getProductStock(product) : undefined,
    stockBySize: product.category === "readywear" ? stockBySize : undefined,
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
    unitPrice: order.unitPrice,
    quantity: order.quantity,
    amount: order.unitPrice * order.quantity,
    paymentStatus: order.paymentStatus,
    shipping: order.shipping,
    createdAt: order.createdAt,
  };
}

async function decrementProductStock(productId, size) {
  const Product = require("../models/Product");
  const product = await Product.findById(productId).lean();
  if (!product) {
    return { ok: false, message: "Product not found." };
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
  getProductStock,
  formatShopForPublic,
  formatShopAdminSummary,
  formatProductSummary,
  formatProductDetail,
  generateOrderNumber,
  sanitizeShippingInput,
  validateShipping,
  formatOrderForClient,
  decrementProductStock,
};
