const fs = require("fs/promises");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");
const { uploadBufferToCloudinary } = require("../../services/cloudnaryService");
const {
  CAROUSEL_WIDTH,
  CAROUSEL_HEIGHT,
  CLOUDINARY_REELS_FOLDER,
} = require("../config/constants");
const { resolveImagePaths } = require("./imageInputService");
const {
  buildTextOverlayPlan,
} = require("./reelTextOverlayService");
const { drawStickerOnFrame } = require("./reelStickerService");
const {
  registerReelFonts,
  buildCanvasFont,
} = require("./reelFontService");
const {
  cleanupJobWorkspace,
  createJobId,
  createJobWorkspace,
  ensureReelDirectories,
} = require("./reelStorageService");

function drawCoverImage(ctx, image, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;
  ctx.drawImage(image, x, y, drawWidth, drawHeight);
}

function drawSimpleTextOverlays(ctx, width, height, overlayPlan) {
  if (!overlayPlan) {
    return;
  }

  const style = overlayPlan.style || {};
  registerReelFonts();

  if (overlayPlan.clientName) {
    const fontSize = style.clientFontSize || 56;
    ctx.font = buildCanvasFont(style.clientFontFamily, fontSize, "bold");
    ctx.fillStyle = style.clientColor || "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 10;
    ctx.fillText(
      overlayPlan.clientName,
      width * ((style.clientX || 50) / 100),
      height * ((style.clientY || 12) / 100),
    );
  }

  if (overlayPlan.offerText) {
    const fontSize = style.offerFontSize || 72;
    ctx.font = buildCanvasFont(style.offerFontFamily, fontSize, "bold");
    ctx.fillStyle = style.offerColor || "#ffd60a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 12;
    ctx.fillText(
      overlayPlan.offerText,
      width * ((style.offerX || 50) / 100),
      height * ((style.offerY || 46) / 100),
    );
  }

  if (overlayPlan.phoneNumber) {
    const fontSize = style.phoneFontSize || 42;
    const x = width * ((style.phoneX || 50) / 100);
    const y = height * ((style.phoneY || 86) / 100);
    ctx.font = buildCanvasFont(style.phoneFontFamily, fontSize, "bold");
    const textWidth = ctx.measureText(overlayPlan.phoneNumber).width;
    if (style.phoneBackground !== false) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const padX = 28;
      const padY = 12;
      ctx.beginPath();
      ctx.roundRect(
        x - textWidth / 2 - padX,
        y - fontSize / 2 - padY,
        textWidth + padX * 2,
        fontSize + padY * 2,
        (fontSize + padY * 2) / 2,
      );
      ctx.fill();
    }
    ctx.fillStyle = style.phoneColor || "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "transparent";
    ctx.fillText(overlayPlan.phoneNumber, x, y);
  }

  if (overlayPlan.sticker) {
    drawStickerOnFrame(ctx, width, height, overlayPlan.sticker, 0, 30);
  }
}

async function composeCarouselSlide({
  imagePath,
  overlayPlan,
  width,
  height,
  outputPath,
}) {
  const image = await loadImage(imagePath);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, width, height);
  drawCoverImage(ctx, image, width, height);

  // Soft bottom gradient so text/CTA stays readable.
  const gradient = ctx.createLinearGradient(0, height * 0.55, 0, height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, height * 0.55, width, height * 0.45);

  drawSimpleTextOverlays(ctx, width, height, overlayPlan);
  const buffer = canvas.toBuffer("image/jpeg", { quality: 0.92 });
  await fs.writeFile(outputPath, buffer);
  return buffer;
}

async function generateCarousel({
  imageUrls = [],
  uploadedFiles = [],
  clientName,
  phoneNumber,
  offerText,
  shopName,
  offer,
  textStyle,
  sticker,
}) {
  await ensureReelDirectories();

  const jobId = createJobId();
  const jobDir = await createJobWorkspace(jobId);

  try {
    const imagePaths = await resolveImagePaths({
      jobDir,
      imageUrls,
      uploadedFiles,
    });

    if (imagePaths.length < 2) {
      const error = new Error("Photo carousel needs at least 2 images.");
      error.statusCode = 400;
      throw error;
    }

    const overlayPlan = buildTextOverlayPlan({
      clientName,
      phoneNumber,
      offerText,
      shopName,
      offer,
      textStyle,
      sticker,
    });

    const width = CAROUSEL_WIDTH;
    const height = CAROUSEL_HEIGHT;
    const slides = [];

    for (let index = 0; index < imagePaths.length; index += 1) {
      const outputPath = path.join(jobDir, `carousel_${index + 1}.jpg`);
      const buffer = await composeCarouselSlide({
        imagePath: imagePaths[index],
        overlayPlan,
        width,
        height,
        outputPath,
      });
      const uploaded = await uploadBufferToCloudinary(
        buffer,
        `carousel-${jobId}-${index + 1}.jpg`,
        {
          folder: `${CLOUDINARY_REELS_FOLDER}/carousel`,
        },
      );
      slides.push({
        index,
        imageUrl: uploaded.imageUrl || uploaded.secure_url || uploaded.url,
        publicId: uploaded.publicId,
      });
    }

    const decisions = {
      outputMode: "carousel",
      categoryId: "carousel",
      categoryName: "Photo Carousel",
      pace: "static",
      animations: [],
      transitions: [],
      music: null,
      voice: null,
      textOverlay: overlayPlan.enabled
        ? {
            clientName: overlayPlan.clientName,
            offerText: overlayPlan.offerText,
            phoneNumber: overlayPlan.phoneNumber,
            style: overlayPlan.style,
          }
        : null,
      sticker: overlayPlan.sticker
        ? {
            id: overlayPlan.sticker.id,
            text: overlayPlan.sticker.text,
            x: overlayPlan.sticker.x,
            y: overlayPlan.sticker.y,
            scale: overlayPlan.sticker.scale,
          }
        : null,
      scenes: slides.map((slide) => ({
        index: slide.index,
        duration: 0,
        animation: "static",
        transitionOut: null,
      })),
    };

    return {
      success: true,
      message: "Photo carousel slides generated successfully.",
      outputMode: "carousel",
      images: slides.map((slide) => slide.imageUrl).filter(Boolean),
      slides,
      templateId: "carousel",
      categoryId: "carousel",
      duration: 0,
      decisions,
    };
  } finally {
    await cleanupJobWorkspace(jobDir);
  }
}

module.exports = {
  generateCarousel,
};
