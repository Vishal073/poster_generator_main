const { isCashfreeConfigured } = require("./cashfreeService");
const { isPaytmConfigured } = require("./paytmService");

function resolveShopPaymentGateway() {
  const preferred = String(process.env.SHOP_PAYMENT_GATEWAY || "paytm")
    .trim()
    .toLowerCase();

  if (preferred === "paytm") {
    if (isPaytmConfigured()) {
      return "paytm";
    }
    if (isCashfreeConfigured()) {
      return "cashfree";
    }
    return null;
  }

  if (preferred === "cashfree") {
    if (isCashfreeConfigured()) {
      return "cashfree";
    }
    if (isPaytmConfigured()) {
      return "paytm";
    }
    return null;
  }

  if (isPaytmConfigured()) {
    return "paytm";
  }
  if (isCashfreeConfigured()) {
    return "cashfree";
  }
  return null;
}

function getShopPaymentConfig() {
  const provider = resolveShopPaymentGateway();
  return {
    provider,
    paytmConfigured: isPaytmConfigured(),
    cashfreeConfigured: isCashfreeConfigured(),
  };
}

module.exports = {
  resolveShopPaymentGateway,
  getShopPaymentConfig,
};
