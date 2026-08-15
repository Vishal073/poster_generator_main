const Shop = require("../../models/Shop");
const Product = require("../../models/Product");
const {
  getProductStock,
  decrementProductStock,
  formatOrderForClient,
} = require("../../utils/shopHelpers");
const {
  sendShopOrderNotificationEmail,
  isSmtpConfigured,
} = require("../emailService");
const { notifyShopOrderCustomer } = require("./shopOrderCustomerNotification");

async function notifyShopOrderPaid(order, shopName) {
  if (!order || order.orderNotificationEmailSentAt) {
    return { sent: false, reason: "already-sent-or-missing-order" };
  }

  if (!isSmtpConfigured()) {
    console.warn(
      `Shop order email skipped for ${order.orderNumber}: SMTP is not configured.`,
    );
    return { sent: false, reason: "smtp-not-configured" };
  }

  const result = await sendShopOrderNotificationEmail({
    order,
    shopName,
  });

  if (result.sent) {
    order.orderNotificationEmailSentAt = new Date();
    await order.save();
  }

  return result;
}

async function finalizeShopOrderPayment(order, paymentDetails = {}) {
  if (!order) {
    return { ok: false, status: 404, message: "Order not found." };
  }

  const shop = await Shop.findById(order.shopId).lean();
  const shopName = shop?.name || order.shopSlug;

  if (order.paymentStatus === "paid") {
    await notifyShopOrderPaid(order, shopName);
    await notifyShopOrderCustomer(order, shopName);

    return {
      ok: true,
      status: 200,
      order: formatOrderForClient(order),
      message: "Payment already verified.",
    };
  }

  const product = await Product.findById(order.productId).lean();
  if (!product) {
    return { ok: false, status: 404, message: "Product not found." };
  }

  const availableStock = getProductStock(product, order.size, order.color);
  if (availableStock <= 0) {
    return {
      ok: false,
      status: 409,
      message: "Product went out of stock before payment completed.",
    };
  }

  const stockResult = await decrementProductStock(
    order.productId,
    order.size,
    order.color,
  );
  if (!stockResult.ok) {
    return { ok: false, status: 409, message: stockResult.message };
  }

  order.paymentStatus = "paid";
  if (paymentDetails.paymentGateway) {
    order.paymentGateway = paymentDetails.paymentGateway;
  }
  if (paymentDetails.razorpayOrderId) {
    order.razorpayOrderId = paymentDetails.razorpayOrderId;
  }
  if (paymentDetails.razorpayPaymentId) {
    order.razorpayPaymentId = paymentDetails.razorpayPaymentId;
  }
  if (paymentDetails.razorpaySignature) {
    order.razorpaySignature = paymentDetails.razorpaySignature;
  }
  if (paymentDetails.paytmTxnId) {
    order.paytmTxnId = paymentDetails.paytmTxnId;
  }
  order.fulfillmentStatus = "processing";
  await order.save();

  await notifyShopOrderPaid(order, shopName);
  await notifyShopOrderCustomer(order, shopName);

  return {
    ok: true,
    status: 200,
    order: formatOrderForClient(order),
  };
}

module.exports = {
  finalizeShopOrderPayment,
};
