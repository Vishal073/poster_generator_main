const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { generatePosterImage } = require("./utils/posterGenerator");
const { sendPosterEmail } = require("./services/emailService");

const app = express();
const generatedPostersDir = path.join(__dirname, "public", "generated-posters");

app.set("trust proxy", true);
app.use(express.json());
app.use("/generated-posters", express.static(generatedPostersDir));

function getPublicBaseUrl(req) {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL;
  if (configuredBaseUrl && configuredBaseUrl.trim()) {
    return configuredBaseUrl.trim().replace(/\/$/, "");
  }

  return `${req.protocol}://${req.get("host")}`;
}

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
      username,
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
    const imageName = posterResult.fileName;
    const imagePath = path.join(generatedPostersDir, imageName);
    await fs.mkdir(generatedPostersDir, { recursive: true });
    await fs.writeFile(imagePath, posterResult.buffer);
    const imageUrl = `${getPublicBaseUrl(req)}/generated-posters/${encodeURIComponent(imageName)}`;

    const emailResult = await sendPosterEmail({
      toEmail: email,
      posterBuffer: posterResult.buffer,
      fileName: imageName,
    });

    return res.status(200).json({
      success: true,
      message: "Poster generated and email sent successfully.",
      messageId: emailResult.messageId,
      username: typeof username === "string" && username.trim() ? username.trim() : name,
      email,
      imageName,
      imageUrl,
      fileName: imageName,
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