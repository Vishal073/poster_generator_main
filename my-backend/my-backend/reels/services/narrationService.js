function buildSimpleNarration({ shopName, offer }) {
  const shop = String(shopName || "").trim();
  const offerText = String(offer || "").trim();

  if (!shop && !offerText) {
    return "";
  }

  if (shop && offerText) {
    return `${shop} me ${offerText}. Aaj hi visit karein!`;
  }

  if (shop) {
    return `${shop} par special offer chal raha hai. Aaj hi visit karein!`;
  }

  return `${offerText}. Aaj hi visit karein!`;
}

function resolveNarrationText({
  voiceScript,
  shopName,
  offer,
}) {
  const directScript = String(voiceScript || "").trim();
  if (directScript) {
    return directScript;
  }

  return buildSimpleNarration({ shopName, offer });
}

function shouldGenerateVoice({
  enableVoice,
  voiceScript,
  shopName,
  offer,
}) {
  if (enableVoice === false) {
    return false;
  }

  if (enableVoice === true) {
    return true;
  }

  return Boolean(
    String(voiceScript || "").trim() ||
      String(shopName || "").trim() ||
      String(offer || "").trim(),
  );
}

function shouldUseElevenLabs({
  enableVoice,
  voiceScript,
  shopName,
  offer,
}) {
  if (enableVoice === false) {
    return false;
  }

  return Boolean(
    String(voiceScript || "").trim() ||
      String(shopName || "").trim() ||
      String(offer || "").trim(),
  );
}

module.exports = {
  buildSimpleNarration,
  resolveNarrationText,
  shouldGenerateVoice,
  shouldUseElevenLabs,
};
