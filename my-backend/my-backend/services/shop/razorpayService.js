const crypto = require("crypto");
const axios = require("axios");

function getRazorpayConfig() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();

  if (!keyId || !keySecret) {
    return null;
  }

  return { keyId, keySecret };
}

function isRazorpayConfigured() {
  return Boolean(getRazorpayConfig());
}

function toPaise(amountInRupees) {
  return Math.round(Number(amountInRupees) * 100);
}

async function createRazorpayOrder({ amountInRupees, receipt, notes = {} }) {
  const config = getRazorpayConfig();
  if (!config) {
    throw new Error("Razorpay is not configured.");
  }

  const amount = toPaise(amountInRupees);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid payment amount.");
  }

  const response = await axios.post(
    "https://api.razorpay.com/v1/orders",
    {
      amount,
      currency: "INR",
      receipt: String(receipt || "").slice(0, 40),
      notes,
      payment_capture: 1,
    },
    {
      auth: {
        username: config.keyId,
        password: config.keySecret,
      },
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 15000,
    },
  );

  return {
    keyId: config.keyId,
    razorpayOrderId: response.data.id,
    amount: response.data.amount,
    currency: response.data.currency,
  };
}

function verifyRazorpayPaymentSignature({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) {
  const config = getRazorpayConfig();
  if (!config) {
    return false;
  }

  const orderId = String(razorpayOrderId || "").trim();
  const paymentId = String(razorpayPaymentId || "").trim();
  const signature = String(razorpaySignature || "").trim();

  if (!orderId || !paymentId || !signature) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", config.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

module.exports = {
  getRazorpayConfig,
  isRazorpayConfigured,
  toPaise,
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
};
