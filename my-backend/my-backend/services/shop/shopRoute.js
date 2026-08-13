const express = require("express");
const mongoose = require("mongoose");
const Shop = require("../../models/Shop");
const Product = require("../../models/Product");
const Order = require("../../models/Order");
const {
  normalizeShopSlug,
  normalizeProductId,
  formatProductSummary,
  formatProductDetail,
  getProductStock,
  hasColorOptions,
  generateOrderNumber,
  sanitizeShippingInput,
  validateShipping,
  formatOrderForClient,
  decrementProductStock,
} = require("../../utils/shopHelpers");
const { resolveShopBySlug, formatShopForPublicWithOwner } = require("../../utils/shopUserSync");
const {
  isRazorpayConfigured,
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
} = require("./razorpayService");
const { sendShopOrderNotificationEmail } = require("../emailService");

const router = express.Router();

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

router.use(requireDb);

const RESERVED_SHOP_SLUGS = new Set(["admin"]);

/** GET /shop/:shopSlug — shop info + active product list */
router.get("/shop/:shopSlug", async (req, res) => {
  try {
    const shopSlug = normalizeShopSlug(req.params.shopSlug);
    if (!shopSlug || RESERVED_SHOP_SLUGS.has(shopSlug)) {
      return res.status(404).json({
        success: false,
        message: "Shop not found.",
      });
    }

    const shop = await resolveShopBySlug(shopSlug);
    if (!shop || shop.isActive === false) {
      return res.status(404).json({
        success: false,
        message: "Shop not found.",
      });
    }

    const products = await Product.find({
      shopSlug: shop.slug,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      shop: await formatShopForPublicWithOwner(shop),
      products: products.map(formatProductSummary),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load shop.",
      error: getErrorMessage(error),
    });
  }
});

/** GET /shop/:shopSlug/:productId — single product detail */
router.get("/shop/:shopSlug/:productId", async (req, res) => {
  try {
    const shopSlug = normalizeShopSlug(req.params.shopSlug);
    const productId = normalizeProductId(req.params.productId);

    if (!shopSlug || !productId || RESERVED_SHOP_SLUGS.has(shopSlug)) {
      return res.status(404).json({
        success: false,
        message: "Shop not found.",
      });
    }

    const shop = await resolveShopBySlug(shopSlug);
    if (!shop || shop.isActive === false) {
      return res.status(404).json({
        success: false,
        message: "Shop not found.",
      });
    }

    const product = await Product.findOne({
      shopSlug: shop.slug,
      productId,
      isActive: true,
    }).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    return res.status(200).json({
      success: true,
      shop: await formatShopForPublicWithOwner(shop),
      product: formatProductDetail(product),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load product.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/:shopSlug/orders — create pending order after shipping step */
router.post("/shop/:shopSlug/orders", async (req, res) => {
  try {
    const shopSlug = normalizeShopSlug(req.params.shopSlug);
    if (!shopSlug) {
      return res.status(400).json({
        success: false,
        message: "Invalid shop name.",
      });
    }

    const productSlug = normalizeProductId(req.body?.productId);
    if (!productSlug) {
      return res.status(400).json({
        success: false,
        message: "Product id is required.",
      });
    }

    const shipping = sanitizeShippingInput(req.body?.shipping);
    const shippingError = validateShipping(shipping);
    if (shippingError) {
      return res.status(400).json({
        success: false,
        message: shippingError,
      });
    }

    const shop = await resolveShopBySlug(shopSlug);
    if (!shop || shop.isActive === false) {
      return res.status(404).json({
        success: false,
        message: "Shop not found.",
      });
    }

    const product = await Product.findOne({
      shopSlug: shop.slug,
      productId: productSlug,
      isActive: true,
    }).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const size =
      product.category === "readywear"
        ? String(req.body?.size || "")
            .trim()
            .slice(0, 20)
        : null;

    const color = hasColorOptions(product)
      ? String(req.body?.color || "")
          .trim()
          .slice(0, 80)
      : null;

    if (product.category === "readywear") {
      if (!size) {
        return res.status(400).json({
          success: false,
          message: "Size is required for this product.",
        });
      }
      if (!product.sizes.includes(size)) {
        return res.status(400).json({
          success: false,
          message: "Invalid size selected.",
        });
      }
    }

    if (hasColorOptions(product)) {
      if (!color) {
        return res.status(400).json({
          success: false,
          message: "Color is required for this product.",
        });
      }
      if (!product.colorOptions.some((option) => option.name === color)) {
        return res.status(400).json({
          success: false,
          message: "Invalid color selected.",
        });
      }
    }

    const availableStock = getProductStock(product, size, color);
    if (availableStock <= 0) {
      return res.status(409).json({
        success: false,
        message: "This product is out of stock.",
      });
    }

    let orderNumber = generateOrderNumber();
    let createdOrder = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        createdOrder = await Order.create({
          orderNumber,
          shopId: shop._id,
          shopSlug,
          productId: product._id,
          productSlug,
          productName: product.name,
          size,
          color,
          unitPrice: product.price,
          quantity: 1,
          shipping,
          paymentStatus: "pending",
        });
        break;
      } catch (error) {
        if (error?.code === 11000 && attempt < 2) {
          orderNumber = generateOrderNumber();
          continue;
        }
        throw error;
      }
    }

    return res.status(201).json({
      success: true,
      order: formatOrderForClient(createdOrder),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create order.",
      error: getErrorMessage(error),
    });
  }
});

function getMongoId(value) {
  const id = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }
  return id;
}

/** POST /shop/payments/razorpay/create — create Razorpay order for a pending shop order */
router.post("/shop/payments/razorpay/create", async (req, res) => {
  try {
    if (!isRazorpayConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Online payment is not configured yet.",
      });
    }

    const orderId = getMongoId(req.body?.orderId);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Valid order id is required.",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.paymentStatus === "paid") {
      return res.status(409).json({
        success: false,
        message: "This order is already paid.",
      });
    }

    const amount = order.unitPrice * order.quantity;

    const payment = await createRazorpayOrder({
      amountInRupees: amount,
      receipt: order.orderNumber,
      notes: {
        orderNumber: order.orderNumber,
        shopSlug: order.shopSlug,
        productSlug: order.productSlug,
      },
    });

    order.razorpayOrderId = payment.razorpayOrderId;
    order.paymentStatus = "pending";
    await order.save();

    return res.status(200).json({
      success: true,
      payment: {
        keyId: payment.keyId,
        razorpayOrderId: payment.razorpayOrderId,
        amount: payment.amount,
        currency: payment.currency,
        orderNumber: order.orderNumber,
        orderId: String(order._id),
        description: order.productName,
        prefill: {
          name: order.shipping?.name || "",
          contact: order.shipping?.mobile || "",
          email: order.shipping?.email || "",
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to start payment.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/payments/razorpay/verify — verify Razorpay payment and mark order paid */
router.post("/shop/payments/razorpay/verify", async (req, res) => {
  try {
    if (!isRazorpayConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Online payment is not configured yet.",
      });
    }

    const orderId = getMongoId(req.body?.orderId);
    const razorpayOrderId = String(req.body?.razorpay_order_id || "").trim();
    const razorpayPaymentId = String(req.body?.razorpay_payment_id || "").trim();
    const razorpaySignature = String(req.body?.razorpay_signature || "").trim();

    if (!orderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification details are incomplete.",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (
      order.paymentStatus === "paid" &&
      order.razorpayPaymentId === razorpayPaymentId
    ) {
      return res.status(200).json({
        success: true,
        order: formatOrderForClient(order),
        message: "Payment already verified.",
      });
    }

    if (order.paymentStatus === "paid") {
      return res.status(409).json({
        success: false,
        message: "This order is already paid.",
      });
    }

    if (order.razorpayOrderId && order.razorpayOrderId !== razorpayOrderId) {
      return res.status(400).json({
        success: false,
        message: "Payment does not match this order.",
      });
    }

    const isValid = verifyRazorpayPaymentSignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!isValid) {
      order.paymentStatus = "failed";
      await order.save();

      return res.status(400).json({
        success: false,
        message: "Payment verification failed.",
      });
    }

    const product = await Product.findById(order.productId).lean();
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const availableStock = getProductStock(product, order.size, order.color);
    if (availableStock <= 0) {
      return res.status(409).json({
        success: false,
        message: "Product went out of stock before payment completed.",
      });
    }

    const stockResult = await decrementProductStock(
      order.productId,
      order.size,
      order.color,
    );
    if (!stockResult.ok) {
      return res.status(409).json({
        success: false,
        message: stockResult.message,
      });
    }

    order.paymentStatus = "paid";
    order.razorpayOrderId = razorpayOrderId;
    order.razorpayPaymentId = razorpayPaymentId;
    order.razorpaySignature = razorpaySignature;
    await order.save();

    const shop = await Shop.findById(order.shopId).lean();
    void sendShopOrderNotificationEmail({
      order,
      shopName: shop?.name || order.shopSlug,
    });

    return res.status(200).json({
      success: true,
      order: formatOrderForClient(order),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to verify payment.",
      error: getErrorMessage(error),
    });
  }
});

module.exports = { router };
