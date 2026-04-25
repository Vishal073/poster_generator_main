const express = require("express");
const { generatePosterImage } = require("./utils/posterGenerator");
const { sendPosterEmail } = require("./services/emailService");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "API is running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/generate-poster", async (req, res) => {
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

    if (!email || typeof email !== "string") {
      return res.status(400).json({
        success: false,
        message: "email is required and must be a valid string.",
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

    const emailResult = await sendPosterEmail({
      toEmail: email,
      posterBuffer: posterResult.buffer,
      fileName: posterResult.fileName,
    });

    return res.status(200).json({
      success: true,
      message: "Poster generated and email sent successfully.",
      messageId: emailResult.messageId,
      fileName: posterResult.fileName,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({
      success: false,
      message: "Failed to generate poster or send email.",
      error: errorMessage,
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});