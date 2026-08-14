const { isPaytmConfigured } = require("./paytmService");

function resolveShopPaymentGateway() {
  if (isPaytmConfigured()) {
    return "paytm";
  }
  return null;
}

function getShopPaymentConfig() {
  return {
    provider: resolveShopPaymentGateway(),
    paytmConfigured: isPaytmConfigured(),
  };
}

module.exports = {
  resolveShopPaymentGateway,
  getShopPaymentConfig,
};
