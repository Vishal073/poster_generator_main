const express = require("express");
const { generatePosterImage } = require("../utils/posterGenerator");
const { uploadPosterToCloudinary } = require("./cloudnaryService");
const { sendPosterWhatsApp } = require("./whatsappService");
// const { sendPosterEmail } = require("./emailService"); // Gmail sending is disabled.

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

function getPosterFileName({ mobileValue, email, fallbackName }) {
  const normalizedIdentifier = mobileValue
    ? String(mobileValue).replace(/\D/g, "")
    : typeof email === "string" && email.trim()
      ? email.trim()
      : String(fallbackName || `poster-${Date.now()}`)
          .trim()
          .replace(/\.png$/i, "");

  return `${normalizedIdentifier || `poster-${Date.now()}`}.png`;
}

async function generatePoster(req, res) {
  try {
    const body = req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const {
      name = "",
      textLines,
      textLineStyles,
      x,
      y,
      email,
      username,
      MobileNo,
      userImageSource,
      imageX,
      imageY,
      imageWidth = 120,
      imageHeight = 120,
      imageShape = "rectangle",
      imagePosition = "left",
      insetFromBottom,
      insetLeft,
      insetRight,
      imageGap = 16,
      imageMaxSize = 120,
      lineGap = 0,
      paragraphGap = 8,
      fontSize = 40,
      fontColor = "#2a2a2a",
      fontFamily = "Helvetica Neue",
      textOpacity = 0.9,
      textBlendMode = "multiply",
      posterSource = process.env.DEFAULT_POSTER_SOURCE,
    } = body;

    const mobileValue = MobileNo;
    const hasMobile = mobileValue != null && String(mobileValue).trim().length > 0;

    if (!hasMobile) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required to send poster on WhatsApp.",
      });
    }

    let posterResult;
    try {
      posterResult = await generatePosterImage({
        name,
        textLines,
        textLineStyles,
        x,
        y,
        userImageSource,
        imageX,
        imageY,
        imageWidth,
        imageHeight,
        imageShape,
        imagePosition,
        insetFromBottom,
        insetLeft,
        insetRight,
        imageGap,
        imageMaxSize,
        lineGap,
        paragraphGap,
        fontSize,
        fontColor,
        fontFamily,
        textOpacity,
        textBlendMode,
        posterSource,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate poster image.",
        error: getErrorMessage(error),
      });
    }

    const imageName = getPosterFileName({
      mobileValue,
      email,
      fallbackName: posterResult.fileName,
    });
    let uploadResult;
    try {
      uploadResult = await uploadPosterToCloudinary(posterResult.buffer, imageName);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Poster generated, but Cloudinary upload failed.",
        imageName,
        error: getErrorMessage(error),
      });
    }

    let whatsappResult;
    try {
      whatsappResult = await sendPosterWhatsApp({
        toMobile: mobileValue,
        imageUrl: uploadResult.imageUrl,
        body: "Here is your image",
      });
    } catch (error) {
      return res.status(502).json({
        success: false,
        message: "Poster generated and uploaded, but WhatsApp delivery failed.",
        imageName,
        imageUrl: uploadResult.imageUrl,
        cloudinaryPublicId: uploadResult.publicId,
        error: getErrorMessage(error),
      });
    }

    // Gmail send disabled. To re-enable, call sendPosterEmail(...) here.
    // const emailResult = await sendPosterEmail({ toEmail: email, posterBuffer: posterResult.buffer, fileName: imageName });

    return res.status(200).json({
      success: true,
      message: "Poster generated, uploaded, and sent to WhatsApp.",
      username: typeof username === "string" && username.trim() ? username.trim() : name,
      email,
      mobile: hasMobile ? String(mobileValue).trim() : undefined,
      imageName,
      fileName: imageName,
      imageUrl: uploadResult.imageUrl,
      cloudinaryPublicId: uploadResult.publicId,
      whatsapp: whatsappResult,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to generate poster.",
      error: getErrorMessage(error),
    });
  }
}

router.post("/generate-poster", generatePoster);

module.exports = {
  router,
  generatePoster,
};
