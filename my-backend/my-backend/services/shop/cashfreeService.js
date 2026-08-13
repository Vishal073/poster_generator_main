const axios = require("axios");

const CASHFREE_API_VERSION = "2025-01-01";

function getCashfreeConfig() {
  const clientId = String(process.env.CASHFREE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.CASHFREE_CLIENT_SECRET || "").trim();
  const env = String(process.env.CASHFREE_ENV || "sandbox")
    .trim()
    .toLowerCase();

  if (!clientId || !clientSecret) {
    return null;
  }

  const isProduction = env === "production" || env === "prod";
  const baseUrl = isProduction
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

  return {
    clientId,
    clientSecret,
    mode: isProduction ? "production" : "sandbox",
    baseUrl,
  };
}

function isCashfreeConfigured() {
  return Boolean(getCashfreeConfig());
}

function getCashfreeHeaders(config) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-version": CASHFREE_API_VERSION,
    "x-client-id": config.clientId,
    "x-client-secret": config.clientSecret,
  };
}

function normalizeCustomerPhone(mobile) {
  const digits = String(mobile || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return digits;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  return digits.slice(-10);
}

async function createCashfreeOrder({
  orderId,
  orderAmount,
  customerDetails,
  returnUrl,
  orderNote,
}) {
  const config = getCashfreeConfig();
  if (!config) {
    throw new Error("Cashfree is not configured.");
  }

  const amount = Number(orderAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid payment amount.");
  }

  const phone = normalizeCustomerPhone(customerDetails?.mobile);
  if (!/^\d{10}$/.test(phone)) {
    throw new Error("Valid customer phone is required for payment.");
  }

  const payload = {
    order_id: String(orderId).slice(0, 50),
    order_amount: amount,
    order_currency: "INR",
    customer_details: {
      customer_id: String(customerDetails?.customerId || phone).slice(0, 50),
      customer_name: String(customerDetails?.name || "Customer").slice(0, 120),
      customer_email: String(customerDetails?.email || "customer@example.com").slice(
        0,
        120,
      ),
      customer_phone: phone,
    },
    order_meta: {
      return_url: returnUrl,
    },
    order_note: String(orderNote || "").slice(0, 200),
  };

  const response = await axios.post(`${config.baseUrl}/orders`, payload, {
    headers: getCashfreeHeaders(config),
    timeout: 20000,
  });

  const data = response.data || {};

  return {
    mode: config.mode,
    cashfreeOrderId: data.order_id,
    paymentSessionId: data.payment_session_id,
    orderStatus: data.order_status,
  };
}

async function fetchCashfreeOrder(cashfreeOrderId) {
  const config = getCashfreeConfig();
  if (!config) {
    throw new Error("Cashfree is not configured.");
  }

  const orderId = String(cashfreeOrderId || "").trim();
  if (!orderId) {
    throw new Error("Cashfree order id is required.");
  }

  const response = await axios.get(
    `${config.baseUrl}/orders/${encodeURIComponent(orderId)}`,
    {
      headers: getCashfreeHeaders(config),
      timeout: 20000,
    },
  );

  return response.data || {};
}

function isCashfreeOrderPaid(orderEntity) {
  const status = String(orderEntity?.order_status || "").toUpperCase();
  return status === "PAID";
}

module.exports = {
  getCashfreeConfig,
  isCashfreeConfigured,
  createCashfreeOrder,
  fetchCashfreeOrder,
  isCashfreeOrderPaid,
};
