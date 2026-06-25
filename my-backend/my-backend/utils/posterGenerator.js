const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const {
  applyLanguageToPosterContent,
  registerPosterFonts,
  WATERMARK_FONT_FAMILY,
} = require("./languageSupport");

const DEFAULT_POSTER_WATERMARK_PATH = path.join(
  __dirname,
  "../assets/gcr-graphix-watermark.png"
);

const watermarkRasterCache = new Map();

const WATERMARK_BRAND = {
  textColor: "#252a35",
  gradientStops: [
    { offset: 0, color: "#2a80e8" },
    { offset: 0.5, color: "#6a32d0" },
    { offset: 1, color: "#dc6020" },
  ],
  opacity: 0.86,
  fontSize: 45,
  prefixFontWeight: "bold",
  suffixFontWeight: "bold",
  logoSize: 52,
  logoRadius: 12,
  logoGap: 10,
};

function getDefaultPosterWatermarkSource() {
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

  const allowedPositions = ["top-left", "top-right", "bottom-left", "bottom-right"];
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
  let watermarkMode = requestedMode || envMode || "text";
  if (watermarkMode === "both" && !watermarkSource) {
    watermarkMode = "text";
  }
  if (watermarkMode === "image" && !watermarkSource) {
    watermarkMode = "text";
  }

  const watermarkText =
    (typeof options.watermarkText === "string" && options.watermarkText.trim()) ||
    getDefaultPosterWatermarkText();

  return {
    addWatermark: true,
    watermarkMode,
    watermarkSource: watermarkSource || undefined,
    watermarkText,
    watermarkLogoSize: pickPositiveNumber(options.watermarkLogoSize, WATERMARK_BRAND.logoSize),
    watermarkLogoGap: pickPositiveNumber(options.watermarkLogoGap, WATERMARK_BRAND.logoGap),
    watermarkWidth: pickPositiveNumber(options.watermarkWidth, 220),
    watermarkHeight: pickPositiveNumber(options.watermarkHeight, 52),
    watermarkCornerRadius: pickPositiveNumber(
      options.watermarkCornerRadius,
      WATERMARK_BRAND.logoRadius
    ),
    watermarkPadding: pickPositiveNumber(options.watermarkPadding, 16),
    watermarkPosition,
  };
}

function resolveWatermarkCoordinates(canvasWidth, canvasHeight, watermark, blockWidth, blockHeight) {
  const padding = watermark.watermarkPadding;
  const position = watermark.watermarkPosition || "top-right";
  const isRight = position.endsWith("right");
  const isBottom = position.startsWith("bottom");
  const width = blockWidth || watermark.watermarkWidth;
  const height = blockHeight || watermark.watermarkHeight;

  return {
    x: isRight ? canvasWidth - padding - width : padding,
    y: isBottom ? canvasHeight - padding - height : padding,
  };
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

function measureGcrGraphixTextWatermark(ctx, maxWidth, maxHeight, text) {
  const content = String(text || "GCR Graphix").trim() || "GCR Graphix";
  const spaceIndex = content.indexOf(" ");
  const prefix = spaceIndex >= 0 ? `${content.slice(0, spaceIndex)} ` : "";
  const suffix = spaceIndex >= 0 ? content.slice(spaceIndex + 1) : content;
  const fontFamily = WATERMARK_FONT_FAMILY;
  const prefixWeight = WATERMARK_BRAND.prefixFontWeight || "600";
  const suffixWeight = WATERMARK_BRAND.suffixFontWeight || "bold";
  const fontSize = WATERMARK_BRAND.fontSize || 45;

  ctx.font = `${prefixWeight} ${fontSize}px "${fontFamily}"`;
  const prefixWidth = ctx.measureText(prefix).width;
  ctx.font = `${suffixWeight} ${fontSize}px "${fontFamily}"`;
  const suffixWidth = ctx.measureText(suffix).width;

  return {
    prefix,
    suffix,
    fontSize,
    fontFamily,
    prefixWeight,
    suffixWeight,
    prefixWidth,
    suffixWidth,
    totalWidth: prefixWidth + suffixWidth,
    totalHeight: fontSize * 1.15,
  };
}

function drawGcrGraphixTextWatermark(ctx, x, y, width, height, text) {
  const layout = measureGcrGraphixTextWatermark(ctx, width, height, text);

  ctx.save();
  ctx.globalAlpha = WATERMARK_BRAND.opacity;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const textY = y + height / 2;
  ctx.font = `${layout.prefixWeight} ${layout.fontSize}px "${layout.fontFamily}"`;
  ctx.fillStyle = WATERMARK_BRAND.textColor;
  ctx.fillText(layout.prefix, x, textY);

  const gradientStartX = x + layout.prefixWidth;
  const gradientEndX = gradientStartX + layout.suffixWidth;
  const gradient = ctx.createLinearGradient(
    gradientStartX,
    y,
    gradientEndX,
    y + height
  );
  for (const stop of WATERMARK_BRAND.gradientStops) {
    gradient.addColorStop(stop.offset, stop.color);
  }
  ctx.font = `${layout.suffixWeight} ${layout.fontSize}px "${layout.fontFamily}"`;
  ctx.fillStyle = gradient;
  ctx.fillText(layout.suffix, gradientStartX, textY);
  ctx.restore();

  return layout;
}

async function drawPosterWatermark(ctx, canvasWidth, canvasHeight, watermark, loadImage) {
  try {
    const mode = watermark.watermarkMode || "text";
    const logoSize = watermark.watermarkLogoSize || WATERMARK_BRAND.logoSize;
    const logoGap = watermark.watermarkLogoGap || WATERMARK_BRAND.logoGap;
    const blockHeight = watermark.watermarkHeight || 52;

    if (mode === "image" && watermark.watermarkSource) {
      const { x, y } = resolveWatermarkCoordinates(
        canvasWidth,
        canvasHeight,
        watermark,
        logoSize,
        logoSize
      );
      const watermarkImage = await prepareWatermarkImage(
        {
          ...watermark,
          watermarkWidth: logoSize,
          watermarkHeight: logoSize,
        },
        loadImage
      );
      drawRoundedRectImageExact(
        ctx,
        watermarkImage,
        x,
        y,
        logoSize,
        logoSize,
        watermark.watermarkCornerRadius
      );
      return;
    }

    if (mode === "text") {
      const textLayout = measureGcrGraphixTextWatermark(
        ctx,
        watermark.watermarkWidth,
        blockHeight,
        watermark.watermarkText
      );
      const { x, y } = resolveWatermarkCoordinates(
        canvasWidth,
        canvasHeight,
        watermark,
        textLayout.totalWidth,
        blockHeight
      );
      drawGcrGraphixTextWatermark(
        ctx,
        x,
        y,
        textLayout.totalWidth,
        blockHeight,
        watermark.watermarkText
      );
      return;
    }

    const textLayout = measureGcrGraphixTextWatermark(
      ctx,
      watermark.watermarkWidth,
      blockHeight,
      watermark.watermarkText
    );
    const combinedBlockHeight = Math.max(blockHeight, logoSize);
    const blockWidth = watermark.watermarkSource
      ? logoSize + logoGap + textLayout.totalWidth
      : textLayout.totalWidth;
    const { x, y } = resolveWatermarkCoordinates(
      canvasWidth,
      canvasHeight,
      watermark,
      blockWidth,
      combinedBlockHeight
    );

    if (watermark.watermarkSource) {
      try {
        const watermarkImage = await prepareWatermarkImage(
          {
            ...watermark,
            watermarkWidth: logoSize,
            watermarkHeight: logoSize,
          },
          loadImage
        );
        const logoY = y + (combinedBlockHeight - logoSize) / 2;
        drawRoundedRectImageExact(
          ctx,
          watermarkImage,
          x,
          logoY,
          logoSize,
          logoSize,
          watermark.watermarkCornerRadius
        );
      } catch (logoError) {
        console.warn("Poster watermark logo skipped:", logoError.message);
      }
    }

    const textX = watermark.watermarkSource ? x + logoSize + logoGap : x;
    const textY = y + (combinedBlockHeight - blockHeight) / 2;
    drawGcrGraphixTextWatermark(
      ctx,
      textX,
      textY,
      textLayout.totalWidth,
      blockHeight,
      watermark.watermarkText
    );
  } catch (error) {
    console.warn("Poster watermark skipped:", error.message);
  }
}

function drawUserPhoto(ctx, userImage, imageX, imageY, imageWidth, imageHeight, imageShape, options = {}) {
  const shape = imageShape === "circle" ? "circle" : "rectangle";
  const { circleBorderColor, circleBorderWidth, imageCornerRadius = 0 } = options;

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

  const cornerRadius =
    typeof imageCornerRadius === "number" && imageCornerRadius > 0 ? imageCornerRadius : 0;
  if (cornerRadius > 0) {
    drawRoundedRectImage(
      ctx,
      userImage,
      imageX,
      imageY,
      imageWidth,
      imageHeight,
      cornerRadius
    );
    return;
  }

  drawImageScaleToFill(ctx, userImage, imageX, imageY, imageWidth, imageHeight);
}

const PHONE_ICON_LINE_INDEX = 2;

function shouldShowPhoneIcon(lineIndex) {
  return lineIndex === PHONE_ICON_LINE_INDEX;
}

function getPhoneIconMetrics(fontSize) {
  const diameter = Math.round(fontSize);
  const gap = Math.max(6, Math.round(fontSize * 0.2));
  return {
    diameter,
    gap,
    prefixWidth: diameter + gap,
  };
}

const FIXED_LINE_GAP_PX = 16;

function getBlockRowHeight(block) {
  if (block.showPhoneIcon) {
    return Math.max(block.fontSize, block.iconDiameter || 0);
  }
  return block.fontSize;
}

function applyFixedLineSpacing(blocks) {
  let totalHeight = 0;

  blocks.forEach((block, index) => {
    const rowHeight = getBlockRowHeight(block);
    block.rowHeight = rowHeight;
    totalHeight += rowHeight;
    if (index < blocks.length - 1) {
      totalHeight += FIXED_LINE_GAP_PX;
    }
  });

  return totalHeight;
}

function drawPhoneHandsetIcon(ctx, cx, cy, diameter) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.translate(cx, cy);

  const scale = diameter / 24;
  ctx.scale(scale, scale);
  ctx.translate(-12, -12);

  ctx.beginPath();
  ctx.moveTo(6.62, 10.79);
  ctx.bezierCurveTo(8.06, 13.62, 10.38, 15.93, 13.21, 17.38);
  ctx.lineTo(15.41, 15.18);
  ctx.bezierCurveTo(15.68, 14.91, 16.08, 14.82, 16.43, 14.94);
  ctx.bezierCurveTo(17.55, 15.31, 18.76, 15.51, 20, 15.51);
  ctx.bezierCurveTo(20.55, 15.51, 21, 15.96, 21, 16.51);
  ctx.lineTo(21, 20);
  ctx.bezierCurveTo(21, 20.55, 20.55, 21, 20, 21);
  ctx.bezierCurveTo(10.61, 21, 3, 13.39, 3, 4);
  ctx.bezierCurveTo(3, 3.45, 3.45, 3, 4, 3);
  ctx.lineTo(7.5, 3);
  ctx.bezierCurveTo(8.05, 3, 8.5, 3.45, 8.5, 4);
  ctx.bezierCurveTo(8.5, 5.25, 8.7, 6.45, 9.07, 7.57);
  ctx.bezierCurveTo(9.18, 7.92, 9.09, 8.32, 8.82, 8.59);
  ctx.lineTo(6.62, 10.79);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPhoneIconBadge(ctx, x, y, diameter, bgColor, opacity = 1) {
  const radius = diameter / 2;
  const cx = x + radius;
  const cy = y + radius;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = opacity;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = bgColor;
  ctx.fill();

  drawPhoneHandsetIcon(ctx, cx, cy, diameter * 0.72);
  ctx.restore();
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

function normalizeTextLineStyles(entries, textLineStyles, defaults) {
  if (!Array.isArray(textLineStyles) || !textLineStyles.length) {
    return [];
  }

  return entries.map(({ lineIndex }) => {
    const style = textLineStyles[lineIndex] || textLineStyles[textLineStyles.length - 1] || {};
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

function getStyledMultilineLayout(ctx, entries, lineStyles, maxWidth, lineGap, paragraphGap) {
  const blocks = [];
  const minFontSize = 12;

  entries.forEach((entry, index) => {
    const style = lineStyles[index];
    const showPhoneIcon = shouldShowPhoneIcon(entry.lineIndex);
    const iconMetrics = showPhoneIcon ? getPhoneIconMetrics(style.fontSize) : null;
    const fitWidth = showPhoneIcon ? Math.max(40, maxWidth - iconMetrics.prefixWidth) : maxWidth;
    const fitted = fitSingleLineText(
      ctx,
      entry.text,
      fitWidth,
      style.fontSize,
      minFontSize,
      style.fontFamily,
      style.fontWeight
    );
    const lineHeight = fitted.fontSize * 1.2;
    const resolvedIconMetrics = showPhoneIcon ? getPhoneIconMetrics(fitted.fontSize) : null;
    blocks.push({
      lines: [fitted.text],
      lineHeight,
      fontSize: fitted.fontSize,
      fontFamily: fitted.fontFamily,
      fontColor: style.fontColor,
      fontWeight: fitted.fontWeight,
      showPhoneIcon,
      iconDiameter: resolvedIconMetrics ? resolvedIconMetrics.diameter : 0,
      iconGap: resolvedIconMetrics ? resolvedIconMetrics.gap : 0,
    });
  });

  const totalHeight = applyFixedLineSpacing(blocks);

  return { blocks, totalHeight, paragraphGap: FIXED_LINE_GAP_PX, lineGap };
}

function buildResolvedTextLayout(ctx, name, textLines, textLineStyles, maxWidth, options) {
  const { fontSize, fontColor, fontFamily } = options;
  const lineGap = options.lineGap == null ? 0 : options.lineGap;
  const paragraphGap = options.paragraphGap == null ? 8 : options.paragraphGap;
  const entries = splitTextLineEntries(name, textLines);
  const paragraphs = entries.map((entry) => entry.text);
  const resolvedFontFamily = fontFamily || "Helvetica Neue";
  const resolvedStyles = normalizeTextLineStyles(entries, textLineStyles, {
    fontSize,
    fontFamily: resolvedFontFamily,
    fontColor,
  });

  if (resolvedStyles.length) {
    return getStyledMultilineLayout(ctx, entries, resolvedStyles, maxWidth, lineGap, paragraphGap);
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
      rowHeight: plain.lineHeight,
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
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  let y = yTop;
  resolvedLayout.blocks.forEach((block, index) => {
    applyTextStyle(ctx, block.fontColor, textOpacity, blendMode);
    ctx.font = `${block.fontWeight} ${block.fontSize}px "${block.fontFamily}"`;
    block.lines.forEach((line) => {
      const rowHeight = block.rowHeight || block.fontSize;

      if (block.showPhoneIcon) {
        const centerY = y + rowHeight / 2;
        const iconY = centerY - block.iconDiameter / 2;
        const textWidth = ctx.measureText(line).width;
        const rowWidth = block.iconDiameter + block.iconGap + textWidth;
        const startX = textAlign === "center" ? xStart - rowWidth / 2 : xStart;
        const textX = startX + block.iconDiameter + block.iconGap;

        drawPhoneIconBadge(ctx, startX, iconY, block.iconDiameter, block.fontColor, textOpacity);

        ctx.save();
        applyTextStyle(ctx, block.fontColor, textOpacity, blendMode);
        ctx.font = `${block.fontWeight} ${block.fontSize}px "${block.fontFamily}"`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(line, textX, centerY);
        ctx.restore();

        y += rowHeight;
        return;
      }

      const textX = textAlign === "center" ? xStart - ctx.measureText(line).width / 2 : xStart;
      ctx.textBaseline = "top";
      ctx.fillText(line, textX, y);
      y += rowHeight;
    });
    if (index < resolvedLayout.blocks.length - 1) {
      y += FIXED_LINE_GAP_PX;
    }
  });
  ctx.restore();
}

/**
 * @param {string} name
 * @param {string[]|undefined} textLines
 */
function splitTextLineEntries(name, textLines) {
  if (Array.isArray(textLines) && textLines.length) {
    return textLines
      .map((line, lineIndex) => ({
        text: String(line || "").trim(),
        lineIndex,
      }))
      .filter((entry) => entry.text.length > 0);
  }
  if (name != null && String(name).includes("\n")) {
    return String(name)
      .split("\n")
      .map((line, lineIndex) => ({
        text: line.trim(),
        lineIndex,
      }))
      .filter((entry) => entry.text.length > 0);
  }
  if (name != null) {
    const text = String(name).trim();
    return text ? [{ text, lineIndex: 0 }] : [{ text: "", lineIndex: 0 }];
  }
  return [{ text: "", lineIndex: 0 }];
}

/**
 * @param {string} name
 * @param {string[]|undefined} textLines
 */
function splitTextParagraphs(name, textLines) {
  return splitTextLineEntries(name, textLines).map((entry) => entry.text);
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
  imageCornerRadius = 16,
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
  watermarkWidth = 220,
  watermarkHeight = 52,
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
    const textHeight = resolvedTextLayout.totalHeight;
    const textTop = layout.contentBottomY - textHeight;

    if (userImage && layout.imageWidth > 0) {
      let finalImageX = layout.imageX;
      let finalImageY = layout.imageY;

      if (layout.imagePosition === "left" || layout.imagePosition === "right") {
        finalImageY = textTop + (textHeight - layout.imageHeight) / 2;
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
        imageShape,
        { imageCornerRadius }
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
      drawUserPhoto(ctx, userImage, imageX, imageY, imageWidth, imageHeight, imageShape, {
        imageCornerRadius,
      });
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
