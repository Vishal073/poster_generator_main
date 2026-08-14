const Shop = require("../../models/Shop");
const Product = require("../../models/Product");
const {
  getProductStock,
  decrementProductStock,
  formatOrderForClient,
} = require("../../utils/shopHelpers");
const { sendShopOrderNotificationEmail } = require("../emailService");

async function finalizeShopOrderPayment(order, paymentDetails = {}) {
  if (!order) {
    return { ok: false, status: 404, message: "Order not found." };
  }

  if (order.paymentStatus === "paid") {
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

  const shop = await Shop.findById(order.shopId).lean();
  void sendShopOrderNotificationEmail({
    order,
    shopName: shop?.name || order.shopSlug,
  });

  return {
    ok: true,
    status: 200,
    order: formatOrderForClient(order),
  };
}

module.exports = {
  finalizeShopOrderPayment,
};
