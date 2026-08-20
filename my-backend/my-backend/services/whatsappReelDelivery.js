const {
  formatWhatsAppNumber,
  sendReelWhatsApp,
  waitForTwilioMessageReady,
} = require("./whatsappService");
const {
  sendWhatsAppPosterCardTemplate,
  isWhatsAppSessionOpen,
} = require("./whatsappTemplateService");

const pendingReelRequests = new Map();

async function sendReadyReel({ to, name, mobile, reelResult }) {
  if (!reelResult?.videoUrl) {
    throw new Error("Reel is not ready yet. Please try again in a moment.");
  }

  const whatsappResult = await sendReelWhatsApp({
    toMobile: to,
    videoUrl: reelResult.videoUrl,
    body: reelResult.message || "Here is your reel",
  });

  if (whatsappResult.sid) {
    await waitForTwilioMessageReady(whatsappResult.sid);
  }

  return {
    mobile: mobile || to,
    videoUrl: reelResult.videoUrl,
    whatsapp: whatsappResult,
  };
}

/**
 * Active 24h WhatsApp session → send video directly. Otherwise download template first.
 */
async function queueReadyReelForDownload({
  toMobile,
  name,
  mobile,
  reelResult,
  lastInboundAt = null,
  message = "Here is your reel",
}) {
  const to = formatWhatsAppNumber(toMobile);
  const sessionOpen = isWhatsAppSessionOpen(lastInboundAt);
  const displayName = String(name || "Customer").trim() || "Customer";
  const displayMobile = String(mobile || toMobile).trim();
  const resolvedReelResult = {
    ...reelResult,
    message: typeof message === "string" && message.trim() ? message.trim() : "Here is your reel",
  };

  pendingReelRequests.set(to, {
    name: displayName,
    mobile: displayMobile,
    reelResult: resolvedReelResult,
    reelStatus: "ready",
    sessionOpen,
    createdAt: new Date().toISOString(),
  });

  if (sessionOpen) {
    const directResult = await sendReadyReel({
      to,
      name: displayName,
      mobile: displayMobile,
      reelResult: resolvedReelResult,
    });

    return {
      mode: "direct",
      sessionOpen: true,
      reelStatus: "ready",
      ...directResult,
    };
  }

  const templateResult = await sendWhatsAppPosterCardTemplate({
    toMobile: displayMobile,
    name: displayName,
    eventName: "Reel",
  });

  return {
    mode: "card_template",
    sessionOpen: false,
    template: templateResult,
    reelStatus: "ready",
  };
}

function getPendingReelRequest(toMobile) {
  const to = formatWhatsAppNumber(toMobile);
  return pendingReelRequests.get(to) || null;
}

module.exports = {
  pendingReelRequests,
  queueReadyReelForDownload,
  sendReadyReel,
  getPendingReelRequest,
};
