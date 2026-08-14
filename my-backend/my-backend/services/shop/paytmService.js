const PaytmChecksum = require("paytmchecksum");
const axios = require("axios");

function getPaytmConfig() {
  const mid = String(process.env.PAYTM_MID || "").trim();
  const merchantKey = String(process.env.PAYTM_MERCHANT_KEY || "").trim();
  const env = String(process.env.PAYTM_ENV || "staging")
    .trim()
    .toLowerCase();

  if (!mid || !merchantKey) {
    return null;
  }

  const isProduction = env === "production" || env === "prod";
  const host = isProduction
    ? "secure.paytmpayments.com"
    : "securestage.paytmpayments.com";
  const websiteName =
    String(process.env.PAYTM_WEBSITE_NAME || "").trim() ||
    (isProduction ? "DEFAULT" : "WEBSTAGING");

  return {
    mid,
    merchantKey,
    websiteName,
    host,
    mode: isProduction ? "production" : "staging",
  };
}

function isPaytmConfigured() {
  return Boolean(getPaytmConfig());
}

function formatPaytmAmount(amountInRupees) {
  return Number(amountInRupees).toFixed(2);
}

async function signPaytmBody(body, merchantKey) {
  const signature = await PaytmChecksum.generateSignature(
    JSON.stringify(body),
    merchantKey,
  );
  return signature;
}

async function postPaytmJson(config, path, body) {
  const signature = await signPaytmBody(body, config.merchantKey);
  const payload = {
    body,
    head: { signature },
  };

  const response = await axios.post(`https://${config.host}${path}`, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
  });

  return response.data || {};
}

async function createPaytmTransaction({
  orderId,
  orderAmount,
  customerDetails,
  callbackUrl,
}) {
  const config = getPaytmConfig();
  if (!config) {
    throw new Error("Paytm is not configured.");
  }

  const amount = Number(orderAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid payment amount.");
  }

  const paytmOrderId = String(orderId).slice(0, 50);
  const phone = String(customerDetails?.mobile || "")
    .replace(/\D/g, "")
    .slice(-10);

  const body = {
    requestType: "Payment",
    mid: config.mid,
    websiteName: config.websiteName,
    orderId: paytmOrderId,
    callbackUrl,
    txnAmount: {
      value: formatPaytmAmount(amount),
      currency: "INR",
    },
    userInfo: {
      custId: String(customerDetails?.customerId || phone || paytmOrderId).slice(
        0,
        50,
      ),
      mobile: phone || undefined,
      email: customerDetails?.email || undefined,
      firstName: customerDetails?.name || undefined,
    },
  };

  const data = await postPaytmJson(
    config,
    `/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(config.mid)}&orderId=${encodeURIComponent(paytmOrderId)}`,
    body,
  );

  const resultStatus = data?.body?.resultInfo?.resultStatus;
  if (resultStatus !== "S") {
    const message =
      data?.body?.resultInfo?.resultMsg || "Paytm could not start payment.";
    throw new Error(message);
  }

  const txnToken = data?.body?.txnToken;
  if (!txnToken) {
    throw new Error("Paytm did not return a transaction token.");
  }

  return {
    mode: config.mode,
    host: config.host,
    mid: config.mid,
    paytmOrderId,
    txnToken,
    amount: formatPaytmAmount(amount),
  };
}

async function fetchPaytmOrderStatus(paytmOrderId) {
  const config = getPaytmConfig();
  if (!config) {
    throw new Error("Paytm is not configured.");
  }

  const orderId = String(paytmOrderId || "").trim();
  if (!orderId) {
    throw new Error("Paytm order id is required.");
  }

  const body = {
    mid: config.mid,
    orderId,
  };

  return postPaytmJson(config, "/v3/order/status", body);
}

function isPaytmOrderPaid(statusResponse) {
  const resultStatus = String(
    statusResponse?.body?.resultInfo?.resultStatus || "",
  ).toUpperCase();
  return resultStatus === "TXN_SUCCESS";
}

module.exports = {
  getPaytmConfig,
  isPaytmConfigured,
  createPaytmTransaction,
  fetchPaytmOrderStatus,
  isPaytmOrderPaid,
};
