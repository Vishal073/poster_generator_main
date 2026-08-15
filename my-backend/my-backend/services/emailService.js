const nodemailer = require("nodemailer");
const { formatOrderNumber } = require("../utils/shopHelpers");

function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP configuration is missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS."
    );
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

const DEFAULT_SHOP_ORDER_NOTIFY_EMAIL = "gcrgraphix@gmail.com";

function isSmtpConfigured() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

function formatInr(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

function buildShopOrderEmailContent({ order, shopName }) {
  const shipping = order.shipping || {};
  const amount = order.unitPrice * (order.quantity || 1);
  const orderNumber = formatOrderNumber(order.orderNumber);
  const addressLines = [
    shipping.addressLine1,
    shipping.addressLine2,
    [shipping.city, shipping.state, shipping.pincode].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    "New shop order received",
    "",
    `Order number: ${orderNumber}`,
    `Order id: ${String(order._id)}`,
    `Shop: ${shopName || order.shopSlug}`,
    "",
    "Product",
    `- ${order.productName}`,
    order.size ? `- Size: ${order.size}` : null,
    order.color ? `- Color: ${order.color}` : null,
    `- Price: ${formatInr(order.unitPrice)}`,
    `- Total: ${formatInr(amount)}`,
    "",
    "Shipping",
    `- Name: ${shipping.name || ""}`,
    `- Mobile: ${shipping.mobile || ""}`,
    shipping.email ? `- Email: ${shipping.email}` : null,
    `- Address:\n${addressLines}`,
    "",
    "Payment",
    `- Status: ${order.paymentStatus}`,
    order.paymentGateway ? `- Gateway: ${order.paymentGateway}` : null,
    order.paytmTxnId ? `- Paytm transaction id: ${order.paytmTxnId}` : null,
    order.paytmOrderId ? `- Paytm order id: ${order.paytmOrderId}` : null,
    order.razorpayPaymentId ? `- Razorpay payment id: ${order.razorpayPaymentId}` : null,
    order.razorpayOrderId ? `- Razorpay order id: ${order.razorpayOrderId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <h2>New shop order received</h2>
    <p><strong>Order number:</strong> ${orderNumber}<br/>
    <strong>Order id:</strong> ${String(order._id)}<br/>
    <strong>Shop:</strong> ${shopName || order.shopSlug}</p>
    <h3>Product</h3>
    <ul>
      <li>${order.productName}</li>
      ${order.size ? `<li>Size: ${order.size}</li>` : ""}
      ${order.color ? `<li>Color: ${order.color}</li>` : ""}
      <li>Price: ${formatInr(order.unitPrice)}</li>
      <li>Total: ${formatInr(amount)}</li>
    </ul>
    <h3>Shipping</h3>
    <ul>
      <li>Name: ${shipping.name || ""}</li>
      <li>Mobile: ${shipping.mobile || ""}</li>
      ${shipping.email ? `<li>Email: ${shipping.email}</li>` : ""}
      <li>Address:<br/>${addressLines.replace(/\n/g, "<br/>")}</li>
    </ul>
    <h3>Payment</h3>
    <ul>
      <li>Status: ${order.paymentStatus}</li>
      ${order.paymentGateway ? `<li>Gateway: ${order.paymentGateway}</li>` : ""}
      ${order.paytmTxnId ? `<li>Paytm transaction id: ${order.paytmTxnId}</li>` : ""}
      ${order.paytmOrderId ? `<li>Paytm order id: ${order.paytmOrderId}</li>` : ""}
      ${order.razorpayPaymentId ? `<li>Razorpay payment id: ${order.razorpayPaymentId}</li>` : ""}
      ${order.razorpayOrderId ? `<li>Razorpay order id: ${order.razorpayOrderId}</li>` : ""}
    </ul>
  `;

  return { text, html, subject: `New order ${orderNumber} — ${order.productName}` };
}

async function sendShopOrderNotificationEmail({ order, shopName }) {
  if (!order) {
    return { sent: false, reason: "missing-order" };
  }

  if (!isSmtpConfigured()) {
    console.warn(
      "Shop order email skipped: SMTP is not configured (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).",
    );
    return { sent: false, reason: "smtp-not-configured" };
  }

  const toEmail =
    process.env.SHOP_ORDER_NOTIFY_EMAIL?.trim() || DEFAULT_SHOP_ORDER_NOTIFY_EMAIL;

  try {
    const transporter = createTransporter();
    const sender = process.env.SMTP_FROM || process.env.SMTP_USER;
    const { subject, text, html } = buildShopOrderEmailContent({ order, shopName });

    await transporter.sendMail({
      from: sender,
      to: toEmail,
      subject,
      text,
      html,
    });

    return { sent: true, toEmail };
  } catch (error) {
    console.error("Failed to send shop order notification email:", error);
    return {
      sent: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendShopPaymentPendingEmail({ order, shopName }) {
  if (!order) {
    return { sent: false, reason: "missing-order" };
  }

  if (!isSmtpConfigured()) {
    console.warn(
      "Shop payment pending email skipped: SMTP is not configured.",
    );
    return { sent: false, reason: "smtp-not-configured" };
  }

  const toEmail =
    process.env.SHOP_ORDER_NOTIFY_EMAIL?.trim() || DEFAULT_SHOP_ORDER_NOTIFY_EMAIL;
  const amount = order.unitPrice * (order.quantity || 1);
  const shipping = order.shipping || {};
  const orderNumber = formatOrderNumber(order.orderNumber);

  const text = [
    "Customer says they paid via UPI — please confirm in shop admin.",
    "",
    `Order number: ${orderNumber}`,
    `Shop: ${shopName || order.shopSlug}`,
    `Product: ${order.productName}`,
    order.size ? `Size: ${order.size}` : null,
    order.color ? `Color: ${order.color}` : null,
    `Amount: ${formatInr(amount)}`,
    "",
    `Customer: ${shipping.name || ""}`,
    `Mobile: ${shipping.mobile || ""}`,
    "",
    "Check your UPI/bank app for the payment, then confirm the order in admin.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const transporter = createTransporter();
    const sender = process.env.SMTP_FROM || process.env.SMTP_USER;

    await transporter.sendMail({
      from: sender,
      to: toEmail,
      subject: `UPI payment pending — ${orderNumber}`,
      text,
      html: text.replace(/\n/g, "<br/>"),
    });

    return { sent: true, toEmail };
  } catch (error) {
    console.error("Failed to send shop payment pending email:", error);
    return {
      sent: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendPosterEmail({ toEmail, posterBuffer, fileName, fromEmail }) {
  if (!toEmail || typeof toEmail !== "string") {
    throw new Error("Recipient email is required.");
  }
  if (!posterBuffer) {
    throw new Error("Poster buffer is required.");
  }

  const transporter = createTransporter();
  const sender = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;

  return transporter.sendMail({
    from: sender,
    to: toEmail,
    subject: "Your Personalized Poster",
    text: "Please find your personalized poster attached.",
    attachments: [
      {
        filename: fileName || "personalized-poster.png",
        content: posterBuffer,
        contentType: "image/png",
      },
    ],
  });
}

module.exports = {
  sendPosterEmail,
  sendShopOrderNotificationEmail,
  sendShopPaymentPendingEmail,
};
