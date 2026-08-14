const {
  fetchPaytmOrderStatus,
  isPaytmOrderPaid,
  isPaytmConfigured,
} = require("./paytmService");
const { finalizeShopOrderPayment } = require("./shopOrderPayment");
const { formatOrderForClient } = require("../../utils/shopHelpers");

async function verifyOnlineShopOrder(order) {
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

  if (order.paymentGateway === "paytm") {
    if (!isPaytmConfigured()) {
      return {
        ok: false,
        status: 503,
        message: "Paytm payment is not configured yet.",
      };
    }

    if (!order.paytmOrderId) {
      return {
        ok: false,
        status: 400,
        message: "No Paytm payment found for this order.",
      };
    }

    const paytmStatus = await fetchPaytmOrderStatus(order.paytmOrderId);
    if (!isPaytmOrderPaid(paytmStatus)) {
      return {
        ok: false,
        status: 402,
        message: "Payment is not completed yet. Please try again.",
        gatewayStatus: paytmStatus?.body?.resultInfo?.resultStatus || "UNKNOWN",
      };
    }

    if (paytmStatus?.body?.txnId) {
      order.paytmTxnId = String(paytmStatus.body.txnId);
    }

    return finalizeShopOrderPayment(order, {
      paymentGateway: "paytm",
      paytmTxnId: order.paytmTxnId,
    });
  }

  return {
    ok: false,
    status: 400,
    message: "This order does not use an online payment gateway.",
  };
}

module.exports = {
  verifyOnlineShopOrder,
};
