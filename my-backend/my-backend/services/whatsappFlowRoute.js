const express = require("express");
const {
  formatWhatsAppNumber,
  sendWhatsAppText,
} = require("./whatsappService");
const { recordWhatsAppInbound, sendWhatsAppDownloadTemplate, isWhatsAppSessionOpen } = require("./whatsappTemplateService");
const {
  handleGcrGraphixGreeting,
  isGcrGraphixGreeting,
  findUserByMobile,
} = require("../utils/portalAuth");
const {
  pendingPosterRequests,
  preparePosterInBackground,
  sendReadyPoster,
  approveReadyPoster,
  sendApproveConfirmation,
} = require("./whatsappPosterDelivery");
const { getUserSocialApproveEligibility } = require("./facebookPostService");

const router = express.Router();

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

function maskValue(value) {
  const rawValue = String(value || "");
  if (rawValue.length <= 8) {
    return rawValue;
  }

  return `${rawValue.slice(0, 4)}...${rawValue.slice(-4)}`;
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
    "language",
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

function getContentVariables({ name }) {
  return {
    "1": String(name || "Customer"),
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

    let canApproveSocial = false;
    let resolvedUserId = null;
    let sessionOpen = false;
    const matchedUser = await findUserByMobile(String(mobile).trim());
    if (matchedUser?._id) {
      resolvedUserId = String(matchedUser._id);
      const eligibility = await getUserSocialApproveEligibility(resolvedUserId);
      canApproveSocial = eligibility.canApprove;
    }
    sessionOpen = isWhatsAppSessionOpen(matchedUser?.whatsappLastInboundAt);

    pendingPosterRequests.set(to, {
      name,
      mobile: String(mobile).trim(),
      posterPayload,
      posterStatus: sessionOpen ? "generating" : "queued",
      userId: resolvedUserId,
      canApproveSocial,
      sessionOpen,
      caption: "",
      createdAt: new Date().toISOString(),
    });

    if (sessionOpen) {
      preparePosterInBackground({
        to,
        mobile: String(mobile).trim(),
        posterPayload,
        autoDeliverOnReady: true,
      });

      return res.status(200).json({
        success: true,
        message: "WhatsApp session is active. Poster will be sent directly when ready.",
        name,
        mobile: String(mobile).trim(),
        posterStatus: "generating",
        sessionOpen: true,
        posterPayload,
      });
    }

    const templateResult = await sendWhatsAppDownloadTemplate({
      toMobile: to,
      name,
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
      sessionOpen: false,
      posterPayload,
      whatsapp: templateResult,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to send WhatsApp template.",
      error: getErrorMessage(error),
      details: getErrorDetails(error),
      twilioTemplate: {
        contentSid: maskValue(process.env.TWILIO_DOWNLOAD_TEMPLATE_CONTENT_SID),
        contentVariables: getContentVariables({ name }),
      },
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
  const approvePayload = String(process.env.TWILIO_APPROVE_BUTTON_PAYLOAD || "approve")
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

    await recordWhatsAppInbound(normalizedFrom);

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

    if (reply === "approve" || reply === approvePayload) {
      const pendingRequest = pendingPosterRequests.get(normalizedFrom);
      if (!pendingRequest?.canApproveSocial || !pendingRequest?.downloadedAt) {
        return res.status(204).end();
      }

      approveReadyPoster({
        to: normalizedFrom,
        mobile: pendingRequest?.mobile || getMobileFromWhatsAppNumber(normalizedFrom),
      })
        .then((result) =>
          sendApproveConfirmation({
            toMobile: normalizedFrom,
            result,
          }),
        )
        .catch((error) => {
          console.error("WhatsApp approve poster failed:", getErrorMessage(error));
          return sendWhatsAppText({
            toMobile: normalizedFrom,
            body: `Could not post your poster: ${getErrorMessage(error)}`,
          }).catch((sendError) => {
            console.error("WhatsApp approve error reply failed:", getErrorMessage(sendError));
          });
        });
      return res.status(204).end();
    }

    if (["skip", skipPayload].includes(reply)) {
      pendingPosterRequests.delete(normalizedFrom);
      return res.status(204).end();
    }

    const bodyText = String(req.body.Body || "").trim();
    if (isGcrGraphixGreeting(bodyText)) {
      handleGcrGraphixGreeting(normalizedFrom).catch((error) => {
        console.error("GCR Graphix greeting reply failed:", getErrorMessage(error));
      });
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
