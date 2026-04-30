const express = require("express");
const { generatePosterImage } = require("../utils/posterGenerator");
const { uploadPosterToCloudinary } = require("./cloudnaryService");
// const { sendPosterEmail } = require("./emailService"); // Gmail sending is disabled.

const router = express.Router();

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
    const hasEmail = typeof email === "string" && email.trim().length > 0;

    if (!hasMobile && !hasEmail) {
      return res.status(400).json({
        success: false,
        message: "Either mobile number or email is required.",
      });
    }

    const posterResult = await generatePosterImage({
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

    const imageName = getPosterFileName({
      mobileValue,
      email,
      fallbackName: posterResult.fileName,
    });
    await uploadPosterToCloudinary(posterResult.buffer, imageName);

    // Gmail send disabled. To re-enable, call sendPosterEmail(...) here.
    // const emailResult = await sendPosterEmail({ toEmail: email, posterBuffer: posterResult.buffer, fileName: imageName });

    return res.status(200).json({
      success: true,
      message: "Poster generated successfully.",
      username: typeof username === "string" && username.trim() ? username.trim() : name,
      email,
      mobile: hasMobile ? String(mobileValue).trim() : undefined,
      imageName,
      fileName: imageName,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({
      success: false,
      message: "Failed to generate poster.",
      error: errorMessage,
    });
  }
}

router.post("/generate-poster", generatePoster);

module.exports = {
  router,
  generatePoster,
};
