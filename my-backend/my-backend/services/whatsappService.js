const twilio = require("twilio");

function isPlaceholderValue(value) {
  return typeof value === "string" && /^(ACx+|your_)/i.test(value.trim());
}

function getTwilioConfig() {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM,
    TWILIO_WHATSAPP_NUMBER,
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio configuration is missing. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
  }
  if ([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN].some(isPlaceholderValue)) {
    throw new Error("Twilio configuration still contains placeholder values in .env.");
  }

  return {
    accountSid: TWILIO_ACCOUNT_SID,
    authToken: TWILIO_AUTH_TOKEN,
    from: formatWhatsAppNumber(TWILIO_WHATSAPP_FROM || TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886"),
  };
}

function getTwilioClient() {
  const config = getTwilioConfig();

  return {
    client: twilio(config.accountSid, config.authToken),
    from: config.from,
  };
}

function formatWhatsAppNumber(value) {
  if (value == null || String(value).trim().length === 0) {
    throw new Error("WhatsApp phone number is required.");
  }

  const rawValue = String(value).trim();
  const numberValue = rawValue.replace(/^whatsapp:/i, "").trim();
  if (rawValue.toLowerCase().startsWith("whatsapp:") && numberValue.startsWith("+")) {
    return `whatsapp:${numberValue.replace(/[^\d+]/g, "")}`;
  }

  const compactNumber = numberValue.replace(/[^\d+]/g, "");
  if (compactNumber.startsWith("+")) {
    return `whatsapp:${compactNumber}`;
  }

  const countryCode = String(process.env.TWILIO_DEFAULT_COUNTRY_CODE || "").replace(/\D/g, "");
  if (!countryCode) {
    throw new Error(
      "WhatsApp phone number must include a country code, or set TWILIO_DEFAULT_COUNTRY_CODE."
    );
  }

  return `whatsapp:+${countryCode}${compactNumber.replace(/\D/g, "")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll Twilio until a WhatsApp media message is sent/delivered before sending a follow-up template.
 */
async function waitForTwilioMessageReady(messageSid, options = {}) {
  if (!messageSid) {
    return null;
  }

  const timeoutMs = Number(options.timeoutMs) || 25000;
  const pollMs = Number(options.pollMs) || 800;
  const afterSentDelayMs = Number(options.afterSentDelayMs) || 2000;
  const { client } = getTwilioClient();
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const message = await client.messages(String(messageSid)).fetch();
    const status = String(message.status || "").toLowerCase();

    if (status === "delivered" || status === "read") {
      return message;
    }

    if (status === "sent") {
      if (afterSentDelayMs > 0) {
        await delay(afterSentDelayMs);
      }
      return message;
    }

    if (status === "failed" || status === "undelivered") {
      throw new Error(`WhatsApp image message ${status}.`);
    }

    await delay(pollMs);
  }

  return null;
}

async function sendReelWhatsApp({ toMobile, videoUrl, body }) {
  if (!videoUrl || typeof videoUrl !== "string") {
    throw new Error("A public video URL is required for WhatsApp delivery.");
  }

  const { client, from } = getTwilioClient();
  const payload = {
    from,
    to: formatWhatsAppNumber(toMobile),
    mediaUrl: [videoUrl],
  };

  if (body && typeof body === "string") {
    payload.body = body;
  }

  const message = await client.messages.create(payload);

  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from,
  };
}

async function sendPosterWhatsApp({ toMobile, imageUrl, body }) {
  if (!imageUrl || typeof imageUrl !== "string") {
    throw new Error("A public image URL is required for WhatsApp delivery.");
  }

  const { client, from } = getTwilioClient();
  const payload = {
    from,
    to: formatWhatsAppNumber(toMobile),
    mediaUrl: [imageUrl],
  };

  if (body && typeof body === "string") {
    payload.body = body;
  }

  const message = await client.messages.create(payload);

  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from,
  };
}

async function sendWhatsAppText({ toMobile, body }) {
  if (!body || typeof body !== "string") {
    throw new Error("WhatsApp message body is required.");
  }

  const { client, from } = getTwilioClient();
  const message = await client.messages.create({
    from,
    to: formatWhatsAppNumber(toMobile),
    body,
  });

  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from,
  };
}

async function sendWhatsAppContentTemplate({ toMobile, contentSid, contentVariables }) {
  if (!contentSid || typeof contentSid !== "string") {
    throw new Error("Twilio Content Template SID is required.");
  }

  const { client, from } = getTwilioClient();
  const payload = {
    from,
    to: formatWhatsAppNumber(toMobile),
    contentSid,
  };

  if (contentVariables && Object.keys(contentVariables).length > 0) {
    payload.contentVariables = JSON.stringify(contentVariables);
  }

  try {
    const message = await client.messages.create(payload);

    return {
      sid: message.sid,
      status: message.status,
      to: message.to,
      from: message.from,
    };
  } catch (error) {
    console.error("Twilio content template send failed:", {
      code: error.code,
      status: error.status,
      message: error.message,
      moreInfo: error.moreInfo,
      details: error.details,
      payload,
    });
    throw error;
  }
}

module.exports = {
  formatWhatsAppNumber,
  sendWhatsAppContentTemplate,
  sendPosterWhatsApp,
  sendReelWhatsApp,
  sendWhatsAppText,
  waitForTwilioMessageReady,
};
