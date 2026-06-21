const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const {
  applyLanguageToPosterContent,
  registerPosterFonts,
} = require("./languageSupport");

const DEFAULT_POSTER_WATERMARK_PATH = path.join(
  __dirname,
  "../assets/gcr-graphix-watermark.png"
);

const watermarkRasterCache = new Map();

function getDefaultPosterWatermarkSource() {
  if ((process.env.POSTER_WATERMARK_MODE || "").trim().toLowerCase() !== "image") {
    return "";
  }
  const envUrl = (process.env.POSTER_WATERMARK_URL || "").trim();
  if (envUrl) {
    return envUrl;
  }
  if (fsSync.existsSync(DEFAULT_POSTER_WATERMARK_PATH)) {
    return DEFAULT_POSTER_WATERMARK_PATH;
  }
  return "";
}

function getDefaultPosterWatermarkText() {
  const custom = (process.env.POSTER_WATERMARK_TEXT || "").trim();
  return custom || "GCR Graphix";
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

/**
 * node-canvas `loadImage(url)` uses a request some CDNs block (403). Fetch with
 * normal browser-like headers, then decode from buffer.
 */
async function loadImageFromUrl(url, loadImage) {
  if (typeof fetch !== "function") {
    return loadImage(url);
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.IMAGE_FETCH_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      ...(process.env.IMAGE_FETCH_REFERER
        ? { Referer: process.env.IMAGE_FETCH_REFERER }
        : {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      `Could not load image from URL: HTTP ${res.status} ${res.statusText} — check link or try a local file path.`
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return loadImage(Buffer.from(arrayBuffer));
}

async function loadPosterImage(source, loadImage) {
  if (!source || typeof source !== "string") {
    throw new Error("A valid poster source (file path or URL) is required.");
  }

  if (isUrl(source)) {
    return loadImageFromUrl(source, loadImage);
  }

  const absolutePath = path.isAbsolute(source)
    ? source
    : path.resolve(process.cwd(), source);
  await fs.access(absolutePath);
  return loadImage(absolutePath);
}

async function loadRasterBuffer(source) {
  if (isUrl(source)) {
    if (typeof fetch !== "function") {
      throw new Error("fetch is not available to load watermark URL.");
    }
    const res = await fetch(source, {
      headers: {
        "User-Agent":
          process.env.IMAGE_FETCH_USER_AGENT ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(process.env.IMAGE_FETCH_REFERER
          ? { Referer: process.env.IMAGE_FETCH_REFERER }
          : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Could not load watermark: HTTP ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const absolutePath = path.isAbsolute(source)
    ? source
    : path.resolve(process.cwd(), source);
  return fs.readFile(absolutePath);
}

async function prepareWatermarkImage(watermark, loadImage) {
  const targetWidth = watermark.watermarkWidth;
  const targetHeight = watermark.watermarkHeight;
  const cacheKey = `${watermark.watermarkSource}|${targetWidth}x${targetHeight}|r${watermark.watermarkCornerRadius || 12}`;

  if (watermarkRasterCache.has(cacheKey)) {
    return watermarkRasterCache.get(cacheKey);
  }

  const inputBuffer = await loadRasterBuffer(watermark.watermarkSource);
  const sharp = require("sharp");
  const metadata = await sharp(inputBuffer).metadata();
  let outputBuffer;

  if (metadata.width === targetWidth && metadata.height === targetHeight) {
    outputBuffer = await sharp(inputBuffer).png().toBuffer();
  } else {
    outputBuffer = await sharp(inputBuffer)
      .resize(targetWidth, targetHeight, {
        fit: "cover",
        position: "centre",
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
  }

  const image = await loadImage(outputBuffer);
  watermarkRasterCache.set(cacheKey, image);
  return image;
}

function drawImageScaleToFill(ctx, image, targetX, targetY, targetWidth, targetHeight) {
  const imageAspect = image.width / image.height;
  const targetAspect = targetWidth / targetHeight;

  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.width;
  let sourceHeight = image.height;

  // Center-crop source image to preserve aspect ratio while fully filling target area.
  if (imageAspect > targetAspect) {
    sourceWidth = image.height * targetAspect;
    sourceX = (image.width - sourceWidth) / 2;
  } else if (imageAspect < targetAspect) {
    sourceHeight = image.width / targetAspect;
    sourceY = (image.height - sourceHeight) / 2;
  }

  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    targetX,
    targetY,
    targetWidth,
    targetHeight
  );
}

function shouldAddPosterWatermark(value) {
  if (value === false || value === 0) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }
  return true;
}

function resolvePosterWatermarkOptions(options = {}) {
  const addWatermark = shouldAddPosterWatermark(options.addWatermark);
  if (!addWatermark) {
    return { addWatermark: false };
  }

  const pickPositiveNumber = (value, fallback) =>
    typeof value === "number" && value > 0 ? value : fallback;

  const allowedPositions = ["top-right", "bottom-right"];
  const requestedPosition =
    typeof options.watermarkPosition === "string"
      ? options.watermarkPosition.trim().toLowerCase()
      : "";
  const watermarkPosition = allowedPositions.includes(requestedPosition)
    ? requestedPosition
    : "top-right";

  const watermarkSource =
    (typeof options.watermarkSource === "string" && options.watermarkSource.trim()) ||
    getDefaultPosterWatermarkSource();
  const requestedMode =
    typeof options.watermarkMode === "string" ? options.watermarkMode.trim().toLowerCase() : "";
  const envMode = (process.env.POSTER_WATERMARK_MODE || "").trim().toLowerCase();
  const watermarkMode =
    requestedMode === "image" || envMode === "image"
      ? watermarkSource
        ? "image"
        : "text"
      : "text";

  const watermarkText =
    (typeof options.watermarkText === "string" && options.watermarkText.trim()) ||
    getDefaultPosterWatermarkText();

  return {
    addWatermark: true,
    watermarkMode,
    watermarkSource: watermarkMode === "image" ? watermarkSource : undefined,
    watermarkText,
    watermarkWidth: pickPositiveNumber(
      options.watermarkWidth,
      watermarkMode === "image" ? 100 : 240
    ),
    watermarkHeight: pickPositiveNumber(
      options.watermarkHeight,
      watermarkMode === "image" ? 100 : 44
    ),
    watermarkCornerRadius: pickPositiveNumber(options.watermarkCornerRadius, 12),
    watermarkPadding: pickPositiveNumber(options.watermarkPadding, 16),
    watermarkPosition,
  };
}

function resolveWatermarkCoordinates(canvasWidth, canvasHeight, watermark) {
  const x = canvasWidth - watermark.watermarkPadding - watermark.watermarkWidth;
  const y =
    watermark.watermarkPosition === "bottom-right"
      ? canvasHeight - watermark.watermarkPadding - watermark.watermarkHeight
      : watermark.watermarkPadding;

  return { x, y };
}

function drawRoundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawRoundedRectImageExact(ctx, image, x, y, width, height, cornerRadius) {
  ctx.save();
  drawRoundedRectPath(ctx, x, y, width, height, cornerRadius);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, image.width, image.height, x, y, width, height);
  ctx.restore();
}

function drawRoundedRectImage(ctx, image, x, y, width, height, cornerRadius) {
  ctx.save();
  drawRoundedRectPath(ctx, x, y, width, height, cornerRadius);
  ctx.clip();
  drawImageScaleToFill(ctx, image, x, y, width, height);
  ctx.restore();
}

function drawGcrGraphixTextWatermark(ctx, x, y, width, height, text) {
  const content = String(text || "GCR Graphix").trim() || "GCR Graphix";
  const spaceIndex = content.indexOf(" ");
  const prefix = spaceIndex >= 0 ? `${content.slice(0, spaceIndex)} ` : "";
  const suffix = spaceIndex >= 0 ? content.slice(spaceIndex + 1) : content;
  const fontFamily = "Helvetica Neue";
  let fontSize = Math.min(height, 36);

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  while (fontSize > 10) {
    ctx.font = `700 ${fontSize}px "${fontFamily}"`;
    const totalWidth = ctx.measureText(`${prefix}${suffix}`).width;
    if (totalWidth <= width && fontSize <= height) {
      break;
    }
    fontSize -= 1;
  }

  const prefixWidth = ctx.measureText(prefix).width;
  const textY = y + height / 2;

  ctx.fillStyle = "#242424";
  ctx.fillText(prefix, x, textY);

  const gradientStartX = x + prefixWidth;
  const gradient = ctx.createLinearGradient(gradientStartX, y, x + width, y);
  gradient.addColorStop(0, "#2563eb");
  gradient.addColorStop(0.5, "#7c3aed");
  gradient.addColorStop(1, "#f97316");
  ctx.fillStyle = gradient;
  ctx.fillText(suffix, gradientStartX, textY);
  ctx.restore();
}

async function drawPosterWatermark(ctx, canvasWidth, canvasHeight, watermark, loadImage) {
  try {
    const { x, y } = resolveWatermarkCoordinates(canvasWidth, canvasHeight, watermark);

    if (watermark.watermarkMode === "image" && watermark.watermarkSource) {
      const watermarkImage = await prepareWatermarkImage(watermark, loadImage);
      drawRoundedRectImageExact(
        ctx,
        watermarkImage,
        x,
        y,
        watermark.watermarkWidth,
        watermark.watermarkHeight,
        watermark.watermarkCornerRadius
      );
      return;
    }

    drawGcrGraphixTextWatermark(
      ctx,
      x,
      y,
      watermark.watermarkWidth,
      watermark.watermarkHeight,
      watermark.watermarkText
    );
  } catch (error) {
    console.warn("Poster watermark skipped:", error.message);
  }
}

function drawUserPhoto(ctx, userImage, imageX, imageY, imageWidth, imageHeight, imageShape, options = {}) {
  const shape = imageShape === "circle" ? "circle" : "rectangle";
  const { circleBorderColor, circleBorderWidth } = options;

  if (shape === "circle") {
    const radius = Math.min(imageWidth, imageHeight) / 2;
    const centerX = imageX + imageWidth / 2;
    const centerY = imageY + imageHeight / 2;
    const borderWidth = circleBorderWidth || 0;

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    drawImageScaleToFill(ctx, userImage, imageX, imageY, imageWidth, imageHeight);
    ctx.restore();

    if (borderWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.strokeStyle = circleBorderColor || "#ffffff";
      ctx.lineWidth = borderWidth;
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  drawImageScaleToFill(ctx, userImage, imageX, imageY, imageWidth, imageHeight);
}

/** Word-wrap a single paragraph at a fixed font size (no auto-shrink). */
function fitSingleLineText(
  ctx,
  text,
  maxWidth,
  preferredSize,
  minSize,
  fontFamily,
  fontWeight = "normal"
) {
  const family = fontFamily || "Helvetica Neue";
  const content = String(text || "");
  let size = preferredSize;
  while (size > minSize) {
    ctx.font = `${fontWeight} ${size}px "${family}"`;
    if (ctx.measureText(content).width <= maxWidth) {
      break;
    }
    size -= 1;
  }
  ctx.font = `${fontWeight} ${size}px "${family}"`;
  return {
    text: content,
    fontSize: size,
    fontFamily: family,
    fontWeight,
  };
}

function normalizeTextLineStyles(paragraphs, textLineStyles, defaults) {
  if (!Array.isArray(textLineStyles) || !textLineStyles.length) {
    return [];
  }

  return paragraphs.map((_, index) => {
    const style = textLineStyles[index] || {};
    return {
      fontSize:
        typeof style.fontSize === "number" && style.fontSize > 0
          ? style.fontSize
          : defaults.fontSize,
      fontFamily:
        typeof style.fontFamily === "string" && style.fontFamily.trim()
          ? style.fontFamily.trim()
          : defaults.fontFamily,
      fontColor:
        typeof style.fontColor === "string" && style.fontColor.trim()
          ? style.fontColor.trim()
          : defaults.fontColor,
      fontWeight:
        typeof style.fontWeight === "string" && style.fontWeight.trim()
          ? style.fontWeight.trim()
          : "normal",
    };
  });
}

function getStyledMultilineLayout(ctx, paragraphs, lineStyles, maxWidth, lineGap, paragraphGap) {
  const blocks = [];
  let totalHeight = 0;
  const minFontSize = 12;

  paragraphs.forEach((paragraph, index) => {
    const style = lineStyles[index];
    const fitted = fitSingleLineText(
      ctx,
      paragraph,
      maxWidth,
      style.fontSize,
      minFontSize,
      style.fontFamily,
      style.fontWeight
    );
    const lineHeight = fitted.fontSize * 1.2;
    blocks.push({
      lines: [fitted.text],
      lineHeight,
      fontSize: fitted.fontSize,
      fontFamily: fitted.fontFamily,
      fontColor: style.fontColor,
      fontWeight: fitted.fontWeight,
    });
    totalHeight += lineHeight;
    if (index < paragraphs.length - 1) {
      totalHeight += paragraphGap;
    }
  });

  return { blocks, totalHeight, paragraphGap, lineGap };
}

function buildResolvedTextLayout(ctx, name, textLines, textLineStyles, maxWidth, options) {
  const { fontSize, fontColor, fontFamily } = options;
  const lineGap = options.lineGap == null ? 0 : options.lineGap;
  const paragraphGap = options.paragraphGap == null ? 8 : options.paragraphGap;
  const paragraphs = splitTextParagraphs(name, textLines);
  const resolvedFontFamily = fontFamily || "Helvetica Neue";
  const resolvedStyles = normalizeTextLineStyles(paragraphs, textLineStyles, {
    fontSize,
    fontFamily: resolvedFontFamily,
    fontColor,
  });

  if (resolvedStyles.length) {
    return getStyledMultilineLayout(ctx, paragraphs, resolvedStyles, maxWidth, lineGap, paragraphGap);
  }

  const minFontSize = 16;
  const plain = getMultilineBlockLayout(
    ctx,
    paragraphs,
    maxWidth,
    fontSize,
    minFontSize,
    resolvedFontFamily,
    { lineGap, paragraphGap }
  );

  return {
    blocks: plain.blocks.map((block) => ({
      lines: block.lines,
      lineHeight: plain.lineHeight,
      fontSize: plain.fontSize,
      fontFamily: plain.fontFamily,
      fontColor,
      fontWeight: "normal",
    })),
    totalHeight: plain.totalHeight,
    paragraphGap: plain.paragraphGap,
  };
}

function drawResolvedTextBlocks(ctx, resolvedLayout, xStart, yTop, textAlign, textOpacity, blendMode) {
  ctx.save();
  ctx.textAlign = textAlign;
  ctx.textBaseline = "top";

  let y = yTop;
  resolvedLayout.blocks.forEach((block, index) => {
    applyTextStyle(ctx, block.fontColor, textOpacity, blendMode);
    ctx.font = `${block.fontWeight} ${block.fontSize}px "${block.fontFamily}"`;
    block.lines.forEach((line) => {
      ctx.fillText(line, xStart, y);
      y += block.lineHeight;
    });
    if (index < resolvedLayout.blocks.length - 1) {
      y += resolvedLayout.paragraphGap;
    }
  });
  ctx.restore();
}

/**
 * @param {string} name
 * @param {string[]|undefined} textLines
 */
function splitTextParagraphs(name, textLines) {
  if (Array.isArray(textLines) && textLines.length) {
    return textLines.map((s) => String(s).trim()).filter((s) => s.length);
  }
  if (name != null && String(name).includes("\n")) {
    return String(name)
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length);
  }
  if (name != null) {
    const t = String(name).trim();
    return t ? [t] : [""];
  }
  return [""];
}

/**
 * User logical lines (e.g. name / title / phone); each can wrap. Shrink font until all lines fit width.
 * @param {{ lineGap?: number, paragraphGap?: number }} extra
 */
function getMultilineBlockLayout(
  ctx,
  paragraphs,
  maxWidth,
  fontSize,
  minFontSize,
  fontFamily,
  extra = {}
) {
  const family = fontFamily || "Helvetica Neue";
  const lineGap = extra.lineGap == null ? 0 : extra.lineGap;
  const paragraphGap = extra.paragraphGap == null ? 8 : extra.paragraphGap;
  if (!paragraphs.length) {
    return {
      blocks: [],
      fontSize,
      lineHeight: fontSize * 1.2,
      lineGap,
      paragraphGap,
      totalHeight: 0,
      fontFamily: family,
    };
  }

  function buildBlocksAndHeight(size) {
    const blocks = [];
    for (const p of paragraphs) {
      blocks.push({ lines: [String(p || "")] });
    }
    const lineHeight = size * 1.2;
    let totalHeight = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      const { lines } = blocks[i];
      for (const line of lines) {
        if (ctx.measureText(line).width > maxWidth) {
          return { ok: false, blocks, lineHeight, totalHeight: 0 };
        }
      }
      totalHeight += lineHeight;
      if (i < blocks.length - 1) {
        totalHeight += paragraphGap;
      }
    }
    return { ok: true, blocks, lineHeight, totalHeight };
  }

  function heightForBlocks(blocks, lineHeight) {
    let t = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      t += lineHeight;
      if (i < blocks.length - 1) {
        t += paragraphGap;
      }
    }
    return t;
  }

  let size = fontSize;
  while (size >= minFontSize) {
    ctx.font = `${size}px "${family}"`;
    const { ok, blocks, lineHeight, totalHeight } = buildBlocksAndHeight(size);
    if (ok) {
      return {
        blocks,
        fontSize: size,
        lineHeight,
        lineGap,
        paragraphGap,
        totalHeight,
        fontFamily: family,
      };
    }
    size -= 2;
  }
  ctx.font = `${minFontSize}px "${family}"`;
  const last = buildBlocksAndHeight(minFontSize);
  const th =
    last.ok && last.totalHeight > 0
      ? last.totalHeight
      : heightForBlocks(last.blocks, minFontSize * 1.2);
  return {
    blocks: last.blocks,
    fontSize: minFontSize,
    lineHeight: minFontSize * 1.2,
    lineGap,
    paragraphGap,
    totalHeight: th,
    fontFamily: family,
  };
}

function applyTextStyle(ctx, fontColor, textOpacity, blendMode) {
  ctx.fillStyle = fontColor;
  ctx.globalAlpha = textOpacity;
  ctx.globalCompositeOperation = blendMode;
  ctx.shadowBlur = 1;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
}

/** Center anchor (legacy absolute layout). `y` = vertical center of the whole text block. */
function drawNameText(ctx, name, x, y, textLines, textLineStyles, options) {
  const {
    fontSize,
    fontColor,
    maxWidth,
    fontFamily,
    textOpacity,
    blendMode,
  } = options;
  const resolvedLayout = buildResolvedTextLayout(
    ctx,
    name,
    textLines,
    textLineStyles,
    maxWidth,
    options
  );
  const yTop = y - resolvedLayout.totalHeight / 2;
  drawResolvedTextBlocks(ctx, resolvedLayout, x, yTop, "center", textOpacity, blendMode);
}

/** Inset box: text left-aligned, bottom-aligned; supports newlines and multiple logical lines. */
function drawNameTextBlockBottomLeft(
  ctx,
  name,
  textLines,
  textLineStyles,
  xLeft,
  yBottom,
  maxWidth,
  options
) {
  const { textOpacity, blendMode } = options;
  const resolvedLayout = buildResolvedTextLayout(
    ctx,
    name,
    textLines,
    textLineStyles,
    maxWidth,
    options
  );
  const yTop = yBottom - resolvedLayout.totalHeight;
  drawResolvedTextBlocks(ctx, resolvedLayout, xLeft, yTop, "left", textOpacity, blendMode);
}

function isInsetLayout(insetFromBottom, insetLeft, insetRight) {
  return (
    typeof insetFromBottom === "number" &&
    typeof insetLeft === "number" &&
    typeof insetRight === "number"
  );
}

function computeInsetFooterLayout(
  W,
  H,
  {
    insetFromBottom,
    insetLeft,
    insetRight,
    hasUserImage,
    imageGap,
    imageMaxSize,
    imageWidth,
    imageHeight,
    imagePosition,
  }
) {
  const contentLeft = insetLeft;
  const contentWidth = W - insetLeft - insetRight;
  if (contentWidth < 40) {
    throw new Error("insetLeft + insetRight is too large for this poster width.");
  }
  const contentBottomY = H - insetFromBottom;
  if (contentBottomY < 0 || contentBottomY > H) {
    throw new Error("insetFromBottom is invalid for this poster height.");
  }

  const gap = imageGap == null ? 16 : imageGap;
  const maxImg = imageMaxSize == null ? 120 : imageMaxSize;
  let finalImageWidth = 0;
  let finalImageHeight = 0;
  let imageX = 0;
  let imageY = 0;
  let textLeft = contentLeft;
  let textMaxWidth = contentWidth;
  const position = imagePosition || "left";

  if (hasUserImage) {
    let width =
      typeof imageWidth === "number" && imageWidth > 0
        ? imageWidth
        : Math.min(maxImg, Math.max(64, Math.floor(contentWidth * 0.32)));
    let height =
      typeof imageHeight === "number" && imageHeight > 0
        ? imageHeight
        : width;
    let tw = contentWidth - width - gap;
    while (tw < 80 && width > 48) {
      width -= 8;
      height = Math.min(height, width);
      tw = contentWidth - width - gap;
    }
    if (width < 48) {
      width = 48;
      height = Math.min(height, width);
    }
    finalImageWidth = width;
    finalImageHeight = height;

    if (position === "left") {
      imageX = contentLeft;
      textLeft = contentLeft + finalImageWidth + gap;
      textMaxWidth = contentWidth - finalImageWidth - gap;
    } else if (position === "right") {
      imageX = contentLeft + contentWidth - finalImageWidth;
      textLeft = contentLeft;
      textMaxWidth = contentWidth - finalImageWidth - gap;
    } else if (position === "top") {
      textLeft = contentLeft;
      textMaxWidth = contentWidth;
    }

    if (textMaxWidth < 40) {
      textMaxWidth = contentWidth;
      finalImageWidth = 0;
      finalImageHeight = 0;
      textLeft = contentLeft;
    }
  }

  return {
    contentBottomY,
    textLeft,
    textMaxWidth,
    contentLeft,
    contentWidth,
    imageX,
    imageY,
    imageWidth: finalImageWidth,
    imageHeight: finalImageHeight,
    imagePosition: position,
    imageGap: gap,
  };
}

async function generatePosterImage({
  name = "",
  textLines,
  textLineStyles,
  x,
  y,
  posterSource,
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
  language = "en",
  addWatermark = true,
  watermarkSource,
  watermarkWidth = 240,
  watermarkHeight = 44,
  watermarkCornerRadius = 12,
  watermarkPadding = 16,
  watermarkPosition = "top-right",
}) {
  let canvasApi;
  try {
    canvasApi = require("canvas");
  } catch (error) {
    throw new Error(
      "The 'canvas' package is not available. Install native dependencies and run: npm install canvas"
    );
  }

  registerPosterFonts();

  const localizedContent = await applyLanguageToPosterContent({
    name,
    textLines,
    language,
    fontFamily,
    textLineStyles,
  });
  name = localizedContent.name;
  textLines = localizedContent.textLines;
  textLineStyles = localizedContent.textLineStyles;
  fontFamily = localizedContent.fontFamily;

  const { createCanvas, loadImage } = canvasApi;
  const watermark = resolvePosterWatermarkOptions({
    addWatermark,
    watermarkSource,
    watermarkWidth,
    watermarkHeight,
    watermarkCornerRadius,
    watermarkPadding,
    watermarkPosition,
  });
  const useInsets = isInsetLayout(insetFromBottom, insetLeft, insetRight);

  const hasName = name != null && String(name).trim().length > 0;
  const hasTextLines =
    Array.isArray(textLines) && textLines.some((s) => s != null && String(s).trim().length > 0);
  if (!hasName && !hasTextLines) {
    throw new Error('Provide "name" (string, can include \\n lines), and/or "textLines" (array of strings).');
  }
  if (name != null && typeof name !== "string") {
    throw new Error("name must be a string if provided.");
  }
  if (!useInsets && (typeof x !== "number" || typeof y !== "number")) {
    throw new Error("x and y are required and must be numbers, unless using insetFromBottom, insetLeft, and insetRight.");
  }
  if (useInsets) {
    if (insetFromBottom < 0 || insetLeft < 0 || insetRight < 0) {
      throw new Error("insetFromBottom, insetLeft, and insetRight must be non-negative numbers.");
    }
  }
  if (typeof textOpacity !== "number" || textOpacity < 0.85 || textOpacity > 0.95) {
    throw new Error("textOpacity must be a number between 0.85 and 0.95.");
  }
  if (!["multiply", "overlay"].includes(textBlendMode)) {
    throw new Error('textBlendMode must be either "multiply" or "overlay".');
  }
  const canUseManualImage =
    !useInsets &&
    Boolean(userImageSource) &&
    typeof imageX === "number" &&
    typeof imageY === "number";

  if (canUseManualImage) {
    if (typeof imageWidth !== "number" || imageWidth <= 0) {
      throw new Error("imageWidth must be a positive number.");
    }
    if (typeof imageHeight !== "number" || imageHeight <= 0) {
      throw new Error("imageHeight must be a positive number.");
    }
    if (!["circle", "rectangle"].includes(imageShape)) {
      throw new Error('imageShape must be either "circle" or "rectangle".');
    }
  }
  if (useInsets && userImageSource) {
    if (!["circle", "rectangle"].includes(imageShape)) {
      throw new Error('imageShape must be either "circle" or "rectangle".');
    }
    if (!["left", "right", "top"].includes(imagePosition)) {
      throw new Error('imagePosition must be either "left", "right", or "top".');
    }
  }

  const posterImage = await loadPosterImage(posterSource, loadImage);
  const W = posterImage.width;
  const H = posterImage.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.antialias = "subpixel";

  ctx.drawImage(posterImage, 0, 0, W, H);

  const textBody = name == null ? "" : String(name).trim();
  let userImage = null;
  if (userImageSource) {
    try {
      userImage = await loadPosterImage(userImageSource, loadImage);
    } catch (error) {
      // User image is optional; continue without image and use full text space.
      userImage = null;
    }
  }

  if (useInsets) {
    const layout = computeInsetFooterLayout(W, H, {
      insetFromBottom,
      insetLeft,
      insetRight,
      hasUserImage: Boolean(userImage),
      imageGap,
      imageMaxSize,
      imageWidth,
      imageHeight,
      imagePosition,
    });
    const resolvedTextLayout = buildResolvedTextLayout(
      ctx,
      textBody,
      textLines,
      textLineStyles,
      layout.textMaxWidth,
      { fontSize, fontColor, fontFamily, lineGap, paragraphGap }
    );
    const textTop = layout.contentBottomY - resolvedTextLayout.totalHeight;

    if (userImage && layout.imageWidth > 0) {
      let finalImageX = layout.imageX;
      let finalImageY = layout.imageY;

      if (layout.imagePosition === "left" || layout.imagePosition === "right") {
        finalImageY = textTop + (resolvedTextLayout.totalHeight - layout.imageHeight) / 2;
      } else if (layout.imagePosition === "top") {
        finalImageX = layout.textLeft + (layout.textMaxWidth - layout.imageWidth) / 2;
        finalImageY = textTop - layout.imageGap - layout.imageHeight;
      }

      drawUserPhoto(
        ctx,
        userImage,
        finalImageX,
        finalImageY,
        layout.imageWidth,
        layout.imageHeight,
        imageShape
      );
    }
    drawResolvedTextBlocks(
      ctx,
      resolvedTextLayout,
      layout.textLeft,
      textTop,
      "left",
      textOpacity,
      textBlendMode
    );
  } else {
    if (userImage && canUseManualImage) {
      drawUserPhoto(ctx, userImage, imageX, imageY, imageWidth, imageHeight, imageShape);
    }
    drawNameText(ctx, textBody, x, y, textLines, textLineStyles, {
      fontSize,
      fontColor,
      maxWidth: W * 0.8,
      fontFamily,
      textOpacity,
      blendMode: textBlendMode,
      lineGap,
      paragraphGap,
    });
  }

  if (watermark.addWatermark) {
    await drawPosterWatermark(ctx, W, H, watermark, loadImage);
  }

  const outputBuffer = canvas.toBuffer("image/png");

  return {
    buffer: outputBuffer,
    fileName: `poster-${Date.now()}.png`,
    mimeType: "image/png",
  };
}

module.exports = {
  generatePosterImage,
  resolvePosterWatermarkOptions,
  shouldAddPosterWatermark,
};
