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
  buildUpiPaymentUri,
  isValidUpiId,
} = require("../../utils/shopHelpers");
const { resolveShopBySlug, formatShopForPublicWithOwner } = require("../../utils/shopUserSync");
const {
  isRazorpayConfigured,
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
} = require("./razorpayService");
const {
  isPaytmConfigured,
  createPaytmTransaction,
} = require("./paytmService");
const { getShopPaymentConfig } = require("./shopPaymentGateway");
const { sendShopPaymentPendingEmail } = require("../emailService");
const { finalizeShopOrderPayment } = require("./shopOrderPayment");
const { verifyOnlineShopOrder } = require("./shopPaymentVerify");

const router = express.Router();

function getShopPublicBaseUrl() {
  return (
    process.env.SHOP_PUBLIC_URL?.trim().replace(/\/$/, "") ||
    "https://gcrgraphix.com"
  );
}

function buildPaytmReturnUrl({ shopSlug, productSlug, orderId }) {
  const base = getShopPublicBaseUrl();
  return `${base}/shop/${encodeURIComponent(shopSlug)}/${encodeURIComponent(productSlug)}/success?shopOrderId=${encodeURIComponent(orderId)}`;
}

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

const RESERVED_SHOP_SLUGS = new Set(["admin", "payments"]);

function getMongoId(value) {
  const id = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }
  return id;
}

/** GET /shop/payments/config — active payment gateway for checkout (must be before /shop/:shopSlug) */
router.get("/shop/payments/config", async (req, res) => {
  try {
    const config = getShopPaymentConfig();
    if (!config.provider) {
      return res.status(503).json({
        success: false,
        message: "Online payment is not configured yet.",
        config,
      });
    }

    return res.status(200).json({
      success: true,
      config,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load payment configuration.",
      error: getErrorMessage(error),
    });
  }
});

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

    const result = await finalizeShopOrderPayment(order, {
      paymentGateway: "razorpay",
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    return res.status(result.status).json({
      success: result.ok,
      order: result.order,
      message: result.message,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to verify payment.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/payments/paytm/create — create Paytm transaction for a pending shop order */
router.post("/shop/payments/paytm/create", async (req, res) => {
  try {
    if (!isPaytmConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Paytm payment is not configured yet.",
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
    const paytmOrderId = `${order.orderNumber}-${Date.now()}`.slice(0, 50);

    const payment = await createPaytmTransaction({
      orderId: paytmOrderId,
      orderAmount: amount,
      customerDetails: {
        customerId: order.shipping?.mobile || orderId,
        name: order.shipping?.name || "",
        email: order.shipping?.email || "",
        mobile: order.shipping?.mobile || "",
      },
      callbackUrl: buildPaytmReturnUrl({
        shopSlug: order.shopSlug,
        productSlug: order.productSlug,
        orderId: String(order._id),
      }),
    });

    order.paytmOrderId = payment.paytmOrderId;
    order.paytmTxnToken = payment.txnToken;
    order.paymentGateway = "paytm";
    order.paymentStatus = "pending";
    await order.save();

    return res.status(200).json({
      success: true,
      payment: {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        amount,
        paytmOrderId: payment.paytmOrderId,
        txnToken: payment.txnToken,
        mid: payment.mid,
        host: payment.host,
        mode: payment.mode,
        amountFormatted: payment.amount,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to start Paytm payment.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/payments/paytm/verify — verify Paytm payment and mark order paid */
router.post("/shop/payments/paytm/verify", async (req, res) => {
  try {
    const orderId = getMongoId(req.body?.orderId);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Valid order id is required.",
      });
    }

    const order = await Order.findById(orderId);
    const result = await verifyOnlineShopOrder(order);

    return res.status(result.status).json({
      success: result.ok,
      order: result.order,
      message: result.message,
      paytmStatus: result.gatewayStatus,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to verify Paytm payment.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/payments/verify — verify payment using the order's gateway */
router.post("/shop/payments/verify", async (req, res) => {
  try {
    const orderId = getMongoId(req.body?.orderId);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Valid order id is required.",
      });
    }

    const order = await Order.findById(orderId);
    const result = await verifyOnlineShopOrder(order);

    return res.status(result.status).json({
      success: result.ok,
      order: result.order,
      message: result.message,
      gatewayStatus: result.gatewayStatus,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to verify payment.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/payments/upi/details — UPI QR payment details for a pending order */
router.post("/shop/payments/upi/details", async (req, res) => {
  try {
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

    const shop = await Shop.findById(order.shopId).lean();
    const upiId = String(shop?.upiId || "").trim().toLowerCase();
    if (!upiId || !isValidUpiId(upiId)) {
      return res.status(503).json({
        success: false,
        message: "UPI payment is not set up for this shop yet.",
      });
    }

    const amount = order.unitPrice * order.quantity;
    const payeeName = String(shop?.upiPayeeName || shop?.name || "").trim();
    const upiUri = buildUpiPaymentUri({
      upiId,
      payeeName,
      amountInRupees: amount,
      orderNumber: order.orderNumber,
    });

    order.paymentGateway = "upi_manual";
    await order.save();

    return res.status(200).json({
      success: true,
      payment: {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        amount,
        upiId,
        payeeName,
        upiUri,
        paymentStatus: order.paymentStatus,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load UPI payment details.",
      error: getErrorMessage(error),
    });
  }
});

/** POST /shop/payments/upi/mark-paid — customer confirms UPI payment sent */
router.post("/shop/payments/upi/mark-paid", async (req, res) => {
  try {
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
      return res.status(200).json({
        success: true,
        order: formatOrderForClient(order),
        message: "Payment already confirmed.",
      });
    }

    if (order.paymentStatus === "awaiting_confirmation") {
      return res.status(200).json({
        success: true,
        order: formatOrderForClient(order),
        message: "Payment already submitted for confirmation.",
      });
    }

    order.paymentStatus = "awaiting_confirmation";
    order.paymentGateway = "upi_manual";
    order.customerMarkedPaidAt = new Date();
    await order.save();

    const shop = await Shop.findById(order.shopId).lean();
    void sendShopPaymentPendingEmail({
      order,
      shopName: shop?.name || order.shopSlug,
    });

    return res.status(200).json({
      success: true,
      order: formatOrderForClient(order),
      message: "Payment submitted. The shop will confirm shortly.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to submit payment confirmation.",
      error: getErrorMessage(error),
    });
  }
});

module.exports = { router };
