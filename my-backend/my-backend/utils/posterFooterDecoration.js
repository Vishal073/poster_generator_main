const sharp = require("sharp");
const cloudinary = require("../services/cloudnaryService");
const { uploadBufferToCloudinary } = require("../services/cloudnaryService");

function getReplicateToken() {
  return String(process.env.REPLICATE_API_TOKEN || "").trim();
}

function isAiFooterEnabled() {
  const value = String(process.env.POSTER_AI_FOOTER_ENABLED ?? "true").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(value);
}

function getFooterDecorationMode(enhancePriority) {
  const normalized = String(enhancePriority || "medium").trim().toLowerCase();
  if (["low", "none", "off"].includes(normalized)) {
    return "none";
  }
  if (["high", "premium", "ai"].includes(normalized)) {
    return "premium";
  }
  return "standard";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rgbToHex(r, g, b) {
  const toHex = (channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixRgb(a, b, amount) {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

function buildPaletteFromRgb(base) {
  const dark = mixRgb(base, { r: 0, g: 0, b: 0 }, 0.55);
  const mid = mixRgb(base, { r: 255, g: 255, b: 255 }, 0.12);
  const front = mixRgb(base, { r: 255, g: 255, b: 255 }, 0.28);
  const accent = mixRgb(base, { r: 255, g: 230, b: 170 }, 0.35);

  return {
    back: rgbToHex(dark.r, dark.g, dark.b),
    mid: rgbToHex(mid.r, mid.g, mid.b),
    front: rgbToHex(front.r, front.g, front.b),
    accent: rgbToHex(accent.r, accent.g, accent.b),
    base: rgbToHex(base.r, base.g, base.b),
  };
}

function sampleBottomPalette(ctx, width, height, footerHeight) {
  const bandHeight = clamp(
    Math.max(footerHeight, Math.floor(height * 0.08)),
    24,
    Math.floor(height * 0.35)
  );
  const startY = height - bandHeight;
  const { data } = ctx.getImageData(0, startY, width, bandHeight);

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 16) {
    const alpha = data[i + 3];
    if (alpha < 40) {
      continue;
    }
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;
  }

  if (!count) {
    return buildPaletteFromRgb({ r: 92, g: 64, b: 42 });
  }

  return buildPaletteFromRgb({
    r: r / count,
    g: g / count,
    b: b / count,
  });
}

function createFooterSeed(width, height, footerHeight) {
  return width * 17 + height * 31 + footerHeight * 13 + (Date.now() % 100000);
}

function waveY(x, width, baseY, amplitude, cycles, phase) {
  const progress = x / width;
  return (
    baseY +
    Math.sin(progress * Math.PI * 2 * cycles + phase) * amplitude +
    Math.sin(progress * Math.PI * 2 * (cycles * 0.55) + phase * 1.6) * (amplitude * 0.35)
  );
}

function traceFooterWavePath(ctx, width, height, baseY, amplitude, cycles, phase) {
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, waveY(0, width, baseY, amplitude, cycles, phase));

  const step = Math.max(4, Math.floor(width / 120));
  for (let x = step; x <= width; x += step) {
    ctx.lineTo(x, waveY(x, width, baseY, amplitude, cycles, phase));
  }

  ctx.lineTo(width, height);
  ctx.closePath();
}

function drawFooterLayer(ctx, width, height, baseY, amplitude, cycles, phase, fillStyle, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  traceFooterWavePath(ctx, width, height, baseY, amplitude, cycles, phase);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function drawAdaptiveFooterDecoration(ctx, { width, height, footerHeight, palette, mode }) {
  const footerBand = clamp(
    Math.max(footerHeight, Math.floor(height * 0.1)),
    80,
    Math.floor(height * 0.32)
  );
  const seed = createFooterSeed(width, height, footerBand);
  const baseTop = height - footerBand;
  const premium = mode === "premium";

  ctx.save();
  ctx.globalCompositeOperation = "source-over";

  drawFooterLayer(
    ctx,
    width,
    height,
    baseTop + footerBand * 0.2,
    footerBand * (premium ? 0.22 : 0.15),
    premium ? 2.1 + (seed % 3) * 0.15 : 1.5 + (seed % 2) * 0.2,
    (seed % 360) * (Math.PI / 180),
    palette.back,
    premium ? 0.92 : 0.82
  );

  drawFooterLayer(
    ctx,
    width,
    height,
    baseTop + footerBand * 0.08,
    footerBand * (premium ? 0.18 : 0.12),
    premium ? 2.3 + (seed % 2) * 0.2 : 1.7,
    (seed % 180) * (Math.PI / 180),
    palette.mid,
    premium ? 0.88 : 0.78
  );

  drawFooterLayer(
    ctx,
    width,
    height,
    baseTop - footerBand * 0.03,
    footerBand * (premium ? 0.14 : 0.08),
    premium ? 1.7 : 1.3,
    (seed % 90) * (Math.PI / 180),
    palette.front,
    premium ? 0.84 : 0.72
  );

  if (premium) {
    drawFooterLayer(
      ctx,
      width,
      height,
      baseTop - footerBand * 0.1,
      footerBand * 0.07,
      2.6,
      (seed % 45) * (Math.PI / 180),
      palette.accent,
      0.55
    );
  }

  ctx.restore();

  return {
    applied: true,
    mode: premium ? "adaptive-premium" : "adaptive",
    palette: palette.base,
  };
}

async function deleteTempImage(publicId) {
  if (!publicId) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (error) {
    console.warn("Failed to delete temp footer image:", error.message);
  }
}

async function waitForReplicatePrediction(prediction, token) {
  const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
  let current = prediction;
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (terminalStatuses.has(current.status)) {
      return current;
    }

    if (!current.urls?.get) {
      throw new Error("Replicate prediction did not return a polling URL.");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const pollResponse = await fetch(current.urls.get, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(`Replicate polling error (${pollResponse.status}): ${errorText}`);
    }

    current = await pollResponse.json();
  }

  throw new Error("Replicate footer prediction timed out.");
}

async function callReplicateFooterModel(imageUrl) {
  const token = getReplicateToken();
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is not configured.");
  }

  const modelPath =
    process.env.POSTER_AI_FOOTER_MODEL || "black-forest-labs/flux-kontext-pro";

  const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=60",
    },
    body: JSON.stringify({
      input: {
        prompt:
          process.env.POSTER_AI_FOOTER_PROMPT ||
          "Add a professional political poster footer at the bottom with elegant curved wave shapes. Match the existing poster colors, lighting, and style exactly. Premium print-ready design. Do not add any text, names, phone numbers, or faces.",
        input_image: imageUrl,
        aspect_ratio: "match_input_image",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate footer API error (${response.status}): ${errorText}`);
  }

  const prediction = await waitForReplicatePrediction(await response.json(), token);
  if (prediction.status === "failed") {
    throw new Error(prediction.error || "Replicate footer prediction failed.");
  }

  const output = prediction.output;
  const outputUrl = Array.isArray(output) ? output[0] : output;
  if (!outputUrl || typeof outputUrl !== "string") {
    throw new Error("Replicate footer returned an unexpected output format.");
  }

  const downloadResponse = await fetch(outputUrl);
  if (!downloadResponse.ok) {
    throw new Error(`Failed to download AI footer image: HTTP ${downloadResponse.status}`);
  }

  return Buffer.from(await downloadResponse.arrayBuffer());
}

async function applyAiFooterDecoration(canvas, width, height, footerHeight) {
  const fullBuffer = canvas.toBuffer("image/png");
  const metadata = await sharp(fullBuffer).metadata();
  const cropHeight = clamp(
    Math.max(footerHeight, Math.floor(metadata.height * 0.22)),
    120,
    Math.floor(metadata.height * 0.35)
  );
  const cropTop = metadata.height - cropHeight;

  const cropBuffer = await sharp(fullBuffer)
    .extract({ left: 0, top: cropTop, width: metadata.width, height: cropHeight })
    .png()
    .toBuffer();

  let tempUpload = null;
  try {
    tempUpload = await uploadBufferToCloudinary(cropBuffer, `footer-temp-${Date.now()}.png`, {
      folder: process.env.CLOUDINARY_AI_TEMP_FOLDER || "poster-ai-temp",
    });

    const enhancedCrop = await callReplicateFooterModel(tempUpload.imageUrl);
    const resizedCrop = await sharp(enhancedCrop)
      .resize(metadata.width, cropHeight, { fit: "cover" })
      .png()
      .toBuffer();

    return sharp(fullBuffer)
      .composite([{ input: resizedCrop, top: cropTop, left: 0 }])
      .png()
      .toBuffer();
  } finally {
    if (tempUpload?.publicId) {
      await deleteTempImage(tempUpload.publicId);
    }
  }
}

async function applyFooterDecoration(ctx, canvas, { width, height, footerHeight, enhancePriority, loadImage }) {
  const mode = getFooterDecorationMode(enhancePriority);
  if (mode === "none") {
    return { applied: false, mode: "none" };
  }

  if (mode === "premium" && isAiFooterEnabled() && getReplicateToken()) {
    try {
      const composedBuffer = await applyAiFooterDecoration(canvas, width, height, footerHeight);
      const composedImage = await loadImage(composedBuffer);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(composedImage, 0, 0, width, height);
      return {
        applied: true,
        mode: "ai-footer",
        palette: "auto",
      };
    } catch (error) {
      console.error("AI footer decoration failed, using adaptive footer:", error.message);
    }
  }

  const palette = sampleBottomPalette(ctx, width, height, footerHeight);
  const result = drawAdaptiveFooterDecoration(ctx, {
    width,
    height,
    footerHeight,
    palette,
    mode,
  });

  return {
    ...result,
    footerError:
      mode === "premium" && !getReplicateToken()
        ? "REPLICATE_API_TOKEN is not configured for AI footer."
        : undefined,
  };
}

module.exports = {
  applyFooterDecoration,
  getFooterDecorationMode,
  sampleBottomPalette,
};
