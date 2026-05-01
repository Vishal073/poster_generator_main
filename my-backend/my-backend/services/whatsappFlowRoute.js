const express = require("express");
const { generatePosterImage } = require("../utils/posterGenerator");
const { uploadPosterToCloudinary } = require("./cloudnaryService");
const {
  formatWhatsAppNumber,
  sendPosterWhatsApp,
  sendWhatsAppContentTemplate,
  sendWhatsAppText,
} = require("./whatsappService");

const router = express.Router();
const pendingPosterRequests = new Map();

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function getErrorDetails(error) {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  return {
    code: error.code,
    status: error.status,
    moreInfo: error.moreInfo,
    details: error.details,
  };
}

function getPosterFileName(mobileValue) {
  const normalizedMobile = String(mobileValue || "").replace(/\D/g, "");
  return `${normalizedMobile || `poster-${Date.now()}`}.png`;
}

function getMobileFromWhatsAppNumber(value) {
  return String(value || "").replace(/^whatsapp:/i, "").replace(/^\+91/, "").replace(/\D/g, "");
}

function getDefaultPosterPayload({ name, mobile }) {
  const displayName = typeof name === "string" && name.trim() ? name.trim() : "Rajesh Kunwar";
  const displayMobile = String(mobile || "").trim();

  return {
    name: "",
    textLines: [displayName, "District President", displayMobile],
    textLineStyles: [
      {
        fontSize: 70,
        fontFamily: "Helvetica Neue",
        fontColor: "#1f1f1f",
        fontWeight: "600",
      },
      {
        fontSize: 45,
        fontFamily: "Helvetica Neue",
        fontColor: "#2f2f2f",
        fontWeight: "500",
      },
      {
        fontSize: 30,
        fontFamily: "Avenir Next",
        fontColor: "#3a3a3a",
        fontWeight: "normal",
      },
    ],
    posterSource:
      "https://res.cloudinary.com/di5yny8zy/image/upload/v1776929207/Bjp-poster_roz8od.jpg",
    userImageSource:
      "https://res.cloudinary.com/di5yny8zy/image/upload/v1776967188/rajesh-removebg-preview_fysmoa.png",
    insetFromBottom: 500,
    insetLeft: 40,
    insetRight: 40,
    imagePosition: "left",
    imageWidth: 350,
    imageHeight: 400,
    imageShape: "circle",
    imageGap: 16,
    imageMaxSize: 350,
    lineGap: 0,
    paragraphGap: 8,
    fontSize: 40,
    fontColor: "#2a2a2a",
    fontFamily: "Helvetica Neue",
    textOpacity: 0.9,
    textBlendMode: "multiply",
  };
}

function pickPosterOverrides(body) {
  const allowedFields = [
    "name",
    "textLines",
    "textLineStyles",
    "x",
    "y",
    "posterSource",
    "userImageSource",
    "imageX",
    "imageY",
    "imageWidth",
    "imageHeight",
    "imageShape",
    "imagePosition",
    "insetFromBottom",
    "insetLeft",
    "insetRight",
    "imageGap",
    "imageMaxSize",
    "lineGap",
    "paragraphGap",
    "fontSize",
    "fontColor",
    "fontFamily",
    "textOpacity",
    "textBlendMode",
  ];

  return allowedFields.reduce((overrides, field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      overrides[field] = body[field];
    }
    return overrides;
  }, {});
}

function buildPosterRequest(body, { name, mobile }) {
  return {
    ...getDefaultPosterPayload({ name, mobile }),
    ...pickPosterOverrides(body),
  };
}

function updatePendingRequest(to, updates) {
  const existingRequest = pendingPosterRequests.get(to);
  if (!existingRequest) {
    return;
  }

  pendingPosterRequests.set(to, {
    ...existingRequest,
    ...updates,
  });
}

function getContentVariables({ name }) {
  return {
    "1": String(name || "Customer"),
  };
}

async function generateAndUploadPoster({ mobile, posterPayload }) {
  console.log("Poster generation started:", { mobile });
  const posterResult = await generatePosterImage(posterPayload);
  const imageName = getPosterFileName(mobile);
  const uploadResult = await uploadPosterToCloudinary(posterResult.buffer, imageName);
  console.log("Poster uploaded to Cloudinary:", {
    mobile,
    imageName,
    imageUrl: uploadResult.imageUrl,
  });

  return {
    imageName,
    imageUrl: uploadResult.imageUrl,
    cloudinaryPublicId: uploadResult.publicId,
  };
}

function preparePosterInBackground({ to, mobile, posterPayload }) {
  const posterPromise = generateAndUploadPoster({ mobile, posterPayload })
    .then((posterResult) => {
      if (!posterResult) {
        return null;
      }

      updatePendingRequest(to, {
        posterResult,
        posterStatus: "ready",
      });
      return posterResult;
    })
    .catch((error) => {
      updatePendingRequest(to, {
        posterError: getErrorMessage(error),
        posterStatus: "failed",
      });
      console.error("Poster pre-generation failed:", getErrorMessage(error));
      return null;
    });

  updatePendingRequest(to, {
    posterPromise,
    posterStatus: "generating",
  });
}

async function getOrCreatePosterResult({ to, name, mobile, posterPayload }) {
  const pendingRequest = pendingPosterRequests.get(to) || {
    name,
    mobile,
    posterPayload,
  };
  const resolvedPosterPayload =
    pendingRequest.posterPayload ||
    posterPayload ||
    getDefaultPosterPayload({
      name: pendingRequest.name,
      mobile: pendingRequest.mobile,
    });
  let posterResult = pendingRequest.posterResult ||
    (pendingRequest.posterPromise ? await pendingRequest.posterPromise : null);

  if (!posterResult) {
    posterResult = await generateAndUploadPoster({
      mobile: pendingRequest.mobile,
      posterPayload: resolvedPosterPayload,
    });
  }

  return {
    pendingRequest,
    posterResult,
  };
}

async function sendReadyPoster({ to, name, mobile, posterPayload }) {
  const { pendingRequest, posterResult } = await getOrCreatePosterResult({
    to,
    name,
    mobile,
    posterPayload,
  });
  const whatsappResult = await sendPosterWhatsApp({
    toMobile: to,
    imageUrl: posterResult.imageUrl,
    body: "Here is your downloaded image",
  });

  console.log("Poster sent to WhatsApp:", {
    to,
    imageUrl: posterResult.imageUrl,
    sid: whatsappResult.sid,
    status: whatsappResult.status,
  });
  pendingPosterRequests.delete(to);

  return {
    mobile: pendingRequest.mobile,
    imageName: posterResult.imageName,
    imageUrl: posterResult.imageUrl,
    cloudinaryPublicId: posterResult.cloudinaryPublicId,
    whatsapp: whatsappResult,
  };
}

router.post("/send-whatsapp-template", async (req, res) => {
  try {
    const body = req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const mobile = body.MobileNo || body.mobile || body.number;
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Rajesh Kunwar";

    if (!mobile || String(mobile).trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required.",
      });
    }

    const to = formatWhatsAppNumber(mobile);
    const posterPayload = buildPosterRequest(body, {
      name,
      mobile: String(mobile).trim(),
    });
    console.log("WhatsApp template requested:", {
      to,
      name,
      mobile: String(mobile).trim(),
    });
    pendingPosterRequests.set(to, {
      name,
      mobile: String(mobile).trim(),
      posterPayload,
      posterStatus: "queued",
      createdAt: new Date().toISOString(),
    });

    const contentSid = process.env.TWILIO_DOWNLOAD_TEMPLATE_CONTENT_SID;
    if (!contentSid || !contentSid.trim()) {
      return res.status(500).json({
        success: false,
        message: "Twilio button template is not configured.",
        error: "Set TWILIO_DOWNLOAD_TEMPLATE_CONTENT_SID in .env.",
      });
    }

    const templateResult = await sendWhatsAppContentTemplate({
      toMobile: to,
      contentSid,
      contentVariables: getContentVariables({ name }),
    });
    preparePosterInBackground({
      to,
      mobile: String(mobile).trim(),
      posterPayload,
    });

    return res.status(200).json({
      success: true,
      message: "WhatsApp template sent. Poster generation started in background.",
      name,
      mobile: String(mobile).trim(),
      posterStatus: "generating",
      posterPayload,
      whatsapp: templateResult,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to send WhatsApp template.",
      error: getErrorMessage(error),
      details: getErrorDetails(error),
    });
  }
});

router.get("/poster-request/:mobile", (req, res) => {
  try {
    const to = formatWhatsAppNumber(req.params.mobile);
    const pendingRequest = pendingPosterRequests.get(to);

    if (!pendingRequest) {
      return res.status(404).json({
        success: false,
        message: "No pending poster request found.",
      });
    }

    return res.status(200).json({
      success: true,
      mobile: pendingRequest.mobile,
      name: pendingRequest.name,
      posterStatus: pendingRequest.posterStatus,
      posterError: pendingRequest.posterError,
      posterResult: pendingRequest.posterResult,
      createdAt: pendingRequest.createdAt,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to read poster request.",
      error: getErrorMessage(error),
    });
  }
});

router.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const normalizedFrom = from ? formatWhatsAppNumber(from) : "";
  const reply = String(req.body.ButtonPayload || req.body.ButtonText || req.body.Body || "")
    .trim()
    .toLowerCase();
  const skipPayload = String(process.env.TWILIO_SKIP_BUTTON_PAYLOAD || "skip")
    .trim()
    .toLowerCase();

  try {
    if (!from) {
      return res.status(204).end();
    }

    console.log("Incoming WhatsApp reply:", {
      from: normalizedFrom,
      reply,
      body: req.body.Body,
      buttonText: req.body.ButtonText,
      buttonPayload: req.body.ButtonPayload,
    });

    if (reply === "download") {
      const pendingRequest = pendingPosterRequests.get(normalizedFrom) || {
        name: "Rajesh Kunwar",
        mobile: getMobileFromWhatsAppNumber(normalizedFrom),
      };
      sendReadyPoster({
        to: normalizedFrom,
        name: pendingRequest.name,
        mobile: pendingRequest.mobile,
        posterPayload: pendingRequest.posterPayload,
      }).catch((error) => {
        console.error("Background poster WhatsApp send failed:", getErrorMessage(error));
      });
      return res.status(204).end();
    }

    if (["skip", skipPayload].includes(reply)) {
      pendingPosterRequests.delete(normalizedFrom);
      return res.status(204).end();
    }

    return res.status(204).end();
  } catch (error) {
    console.error("WhatsApp webhook failed:", getErrorMessage(error));
    return res.sendStatus(500);
  }
});

module.exports = {
  router,
};
