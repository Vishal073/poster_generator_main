const { sendWhatsAppText } = require("../whatsappService");
const {
  sendShopOrderCustomerConfirmationEmail,
  isSmtpConfigured,
} = require("../emailService");
const { formatOrderNumber } = require("../../utils/shopHelpers");

function isTwilioConfigured() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
}

function isValidCustomerEmail(email) {
  const value = String(email || "").trim();
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function buildCustomerWhatsAppMessage({ order, shopName }) {
  const orderNumber = formatOrderNumber(order.orderNumber);
  const amount = order.unitPrice * (order.quantity || 1);

  return [
    `Hi ${order.shipping?.name || "there"},`,
    "",
    "Your order is confirmed. Thank you for shopping with GCR Graphix.",
    "",
    `Order: ${orderNumber}`,
    `Product: ${order.productName}`,
    order.size ? `Size: ${order.size}` : null,
    order.color ? `Color: ${order.color}` : null,
    `Amount: Rs ${amount}`,
    order.shipping?.city ? `Deliver to: ${order.shipping.city}` : null,
    "",
    "We will share shipping updates on WhatsApp.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function notifyShopOrderCustomer({ order, shopName }) {
  if (!order || order.orderCustomerNotificationSentAt) {
    return { sent: false, reason: "already-sent-or-missing-order" };
  }

  const customerEmail = order.shipping?.email?.trim();

  if (isValidCustomerEmail(customerEmail)) {
    if (!isSmtpConfigured()) {
      console.warn(
        `Customer order email skipped for ${order.orderNumber}: SMTP is not configured.`,
      );
      return { sent: false, reason: "smtp-not-configured", channel: "email" };
    }

    const result = await sendShopOrderCustomerConfirmationEmail({
      order,
      shopName,
      toEmail: customerEmail,
    });

    if (result.sent) {
      order.orderCustomerNotificationSentAt = new Date();
      order.orderCustomerNotificationChannel = "email";
      await order.save();
    }

    return { ...result, channel: "email" };
  }

  const mobile = order.shipping?.mobile;
  if (!/^\d{10}$/.test(String(mobile || ""))) {
    return { sent: false, reason: "missing-mobile", channel: "whatsapp" };
  }

  if (!isTwilioConfigured()) {
    console.warn(
      `Customer WhatsApp skipped for ${order.orderNumber}: Twilio is not configured.`,
    );
    return { sent: false, reason: "twilio-not-configured", channel: "whatsapp" };
  }

  try {
    const result = await sendWhatsAppText({
      toMobile: mobile,
      body: buildCustomerWhatsAppMessage({ order, shopName }),
    });

    order.orderCustomerNotificationSentAt = new Date();
    order.orderCustomerNotificationChannel = "whatsapp";
    await order.save();

    console.log(
      `Customer order WhatsApp sent for ${formatOrderNumber(order.orderNumber)} to ${mobile}.`,
    );

    return { sent: true, channel: "whatsapp", toMobile: mobile, sid: result.sid };
  } catch (error) {
    console.error("Failed to send customer order WhatsApp:", error);
    return {
      sent: false,
      reason: error instanceof Error ? error.message : String(error),
      channel: "whatsapp",
    };
  }
}

module.exports = {
  notifyShopOrderCustomer,
};
