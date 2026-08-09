const fs = require("fs/promises");
const path = require("path");
const { createCanvas } = require("canvas");
const {
  registerReelFonts,
  buildCanvasFont,
  DEFAULT_REEL_FONT_FAMILY,
} = require("./reelFontService");
const { normalizeSticker, drawStickerOnFrame } = require("./reelStickerService");

function sanitizeText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .trim();
}

async function ensureFontRegistered() {
  registerReelFonts();
}

function clampPercent(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, parsed));
}

function normalizeHexColor(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed) ? trimmed : fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex, "#ffffff").replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

const DEFAULT_TEXT_STYLE = {
  clientColor: "#ffffff",
  offerColor: "#ffd60a",
  offerAltColor: "#ff2d55",
  phoneColor: "#ffffff",
  clientFontFamily: DEFAULT_REEL_FONT_FAMILY,
  offerFontFamily: DEFAULT_REEL_FONT_FAMILY,
  phoneFontFamily: DEFAULT_REEL_FONT_FAMILY,
  clientFontSize: 64,
  offerFontSize: 88,
  phoneFontSize: 48,
  clientX: 50,
  clientY: 12,
  offerX: 50,
  offerY: 46,
  phoneX: 50,
  phoneY: 86,
  clientBackground: false,
  offerBackground: false,
  phoneBackground: true,
  animateOffer: true,
};

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function normalizeFontFamily(value, fallback) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function clampFontSize(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeTextStyle(raw) {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_TEXT_STYLE };
  }

  return {
    clientColor: normalizeHexColor(raw.clientColor, DEFAULT_TEXT_STYLE.clientColor),
    offerColor: normalizeHexColor(raw.offerColor, DEFAULT_TEXT_STYLE.offerColor),
    offerAltColor: normalizeHexColor(raw.offerAltColor, DEFAULT_TEXT_STYLE.offerAltColor),
    phoneColor: normalizeHexColor(raw.phoneColor, DEFAULT_TEXT_STYLE.phoneColor),
    clientFontFamily: normalizeFontFamily(
      raw.clientFontFamily,
      DEFAULT_TEXT_STYLE.clientFontFamily,
    ),
    offerFontFamily: normalizeFontFamily(
      raw.offerFontFamily,
      DEFAULT_TEXT_STYLE.offerFontFamily,
    ),
    phoneFontFamily: normalizeFontFamily(
      raw.phoneFontFamily,
      DEFAULT_TEXT_STYLE.phoneFontFamily,
    ),
    clientFontSize: clampFontSize(
      raw.clientFontSize,
      DEFAULT_TEXT_STYLE.clientFontSize,
      24,
      120,
    ),
    offerFontSize: clampFontSize(
      raw.offerFontSize,
      DEFAULT_TEXT_STYLE.offerFontSize,
      32,
      160,
    ),
    phoneFontSize: clampFontSize(
      raw.phoneFontSize,
      DEFAULT_TEXT_STYLE.phoneFontSize,
      20,
      96,
    ),
    clientX: clampPercent(raw.clientX, DEFAULT_TEXT_STYLE.clientX),
    clientY: clampPercent(raw.clientY, DEFAULT_TEXT_STYLE.clientY),
    offerX: clampPercent(raw.offerX, DEFAULT_TEXT_STYLE.offerX),
    offerY: clampPercent(raw.offerY, DEFAULT_TEXT_STYLE.offerY),
    phoneX: clampPercent(raw.phoneX, DEFAULT_TEXT_STYLE.phoneX),
    phoneY: clampPercent(raw.phoneY, DEFAULT_TEXT_STYLE.phoneY),
    clientBackground: normalizeBoolean(
      raw.clientBackground,
      DEFAULT_TEXT_STYLE.clientBackground,
    ),
    offerBackground: normalizeBoolean(
      raw.offerBackground,
      DEFAULT_TEXT_STYLE.offerBackground,
    ),
    phoneBackground: normalizeBoolean(
      raw.phoneBackground,
      DEFAULT_TEXT_STYLE.phoneBackground,
    ),
    animateOffer: normalizeBoolean(raw.animateOffer, DEFAULT_TEXT_STYLE.animateOffer),
  };
}

function buildTextOverlayPlan({
  clientName,
  phoneNumber,
  offerText,
  shopName,
  offer,
  textStyle,
  sticker,
}) {
  const resolvedClientName = sanitizeText(clientName || shopName);
  const resolvedOffer = sanitizeText(offerText || offer);
  const resolvedPhone = sanitizeText(phoneNumber);
  const normalizedSticker = normalizeSticker(sticker);

  const lines = [];
  if (resolvedClientName) {
    lines.push({ role: "clientName", text: resolvedClientName });
  }
  if (resolvedOffer) {
    lines.push({ role: "offer", text: resolvedOffer });
  }
  if (resolvedPhone) {
    lines.push({ role: "phone", text: resolvedPhone });
  }

  return {
    clientName: resolvedClientName,
    offerText: resolvedOffer,
    phoneNumber: resolvedPhone,
    lines,
    sticker: normalizedSticker,
    enabled: lines.length > 0 || Boolean(normalizedSticker),
    style: normalizeTextStyle(textStyle),
  };
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const lines = [];
  let current = words[0];

  for (let index = 1; index < words.length; index += 1) {
    const next = `${current} ${words[index]}`;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
    } else {
      lines.push(current);
      current = words[index];
    }
  }

  lines.push(current);
  return lines;
}

function drawOutlinedText(ctx, text, x, y, options) {
  const {
    font,
    fillStyle,
    strokeStyle = "rgba(0,0,0,0.75)",
    lineWidth = 6,
    textAlign = "center",
    shadowColor = "rgba(0,0,0,0.45)",
    shadowBlur = 10,
  } = options;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = textAlign;
  ctx.textBaseline = "middle";
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = shadowBlur;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fillStyle;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function lerpColor(start, end, amount) {
  const clamped = Math.min(Math.max(amount, 0), 1);
  const mix = (from, to) => Math.round(from + (to - from) * clamped);
  return `rgb(${mix(start[0], end[0])}, ${mix(start[1], end[1])}, ${mix(start[2], end[2])})`;
}

function drawTextBackgroundPill(ctx, centerX, centerY, textWidth, textHeight) {
  const paddingX = 36;
  const paddingY = 16;
  const pillWidth = textWidth + paddingX * 2;
  const pillHeight = textHeight + paddingY * 2;
  const pillX = centerX - pillWidth / 2;
  const pillY = centerY - pillHeight / 2;

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.58)";
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
  ctx.fill();
  ctx.restore();
}

function renderOverlayFrame(ctx, width, height, overlayPlan, frameIndex, fps) {
  ctx.clearRect(0, 0, width, height);
  const style = overlayPlan.style || DEFAULT_TEXT_STYLE;
  const time = frameIndex / fps;
  const pulse = 0.5 + 0.5 * Math.sin((time * Math.PI * 2) / 1.4);
  const offerScale = style.animateOffer ? 1 + pulse * 0.08 : 1;
  const offerColor = style.animateOffer
    ? lerpColor(hexToRgb(style.offerColor), hexToRgb(style.offerAltColor), pulse)
    : style.offerColor;

  if (overlayPlan.clientName) {
    const clientX = width * (style.clientX / 100);
    const clientFontSize = style.clientFontSize;
    const clientFont = buildCanvasFont(style.clientFontFamily, clientFontSize, "bold");
    ctx.font = clientFont;
    const clientLines = wrapText(ctx, overlayPlan.clientName, width * 0.86);
    const clientLineHeight = clientFontSize * 1.05;
    const clientCenterY = height * (style.clientY / 100);
    const clientStartY =
      clientCenterY - ((clientLines.length - 1) * clientLineHeight) / 2;
    const clientMaxWidth = Math.max(
      ...clientLines.map((line) => ctx.measureText(line).width),
      0,
    );
    const clientBlockHeight =
      clientLines.length > 1
        ? (clientLines.length - 1) * clientLineHeight + clientFontSize
        : clientFontSize;

    if (style.clientBackground) {
      drawTextBackgroundPill(
        ctx,
        clientX,
        clientCenterY,
        clientMaxWidth,
        clientBlockHeight,
      );
    }

    clientLines.forEach((line, index) => {
      drawOutlinedText(ctx, line, clientX, clientStartY + index * clientLineHeight, {
        font: clientFont,
        fillStyle: style.clientColor,
        lineWidth: 5,
      });
    });
  }

  if (overlayPlan.offerText) {
    const offerX = width * (style.offerX / 100);
    const baseFontSize = style.offerFontSize;
    const fontSize = Math.round(baseFontSize * offerScale);
    ctx.font = buildCanvasFont(style.offerFontFamily, fontSize, "bold");
    const lines = wrapText(ctx, overlayPlan.offerText, width * 0.86);
    const lineHeight = fontSize * 1.05;
    const startY =
      height * (style.offerY / 100) - ((lines.length - 1) * lineHeight) / 2;
    const maxLineWidth = Math.max(
      ...lines.map((line) => ctx.measureText(line).width),
      0,
    );
    const offerBlockHeight =
      lines.length > 1 ? (lines.length - 1) * lineHeight + fontSize : fontSize;

    if (style.offerBackground) {
      drawTextBackgroundPill(
        ctx,
        offerX,
        height * (style.offerY / 100),
        maxLineWidth,
        offerBlockHeight,
      );
    }

    lines.forEach((line, index) => {
      drawOutlinedText(ctx, line, offerX, startY + index * lineHeight, {
        font: buildCanvasFont(style.offerFontFamily, fontSize, "bold"),
        fillStyle: offerColor,
        strokeStyle: "rgba(58, 23, 255, 0.85)",
        lineWidth: 7,
        shadowBlur: 16,
      });
    });
  }

  if (overlayPlan.phoneNumber) {
    const phoneText = overlayPlan.phoneNumber;
    const phoneX = width * (style.phoneX / 100);
    const phoneCenterY = height * (style.phoneY / 100);
    const phoneFontSize = style.phoneFontSize;
    ctx.font = buildCanvasFont(style.phoneFontFamily, phoneFontSize, "bold");
    const textWidth = ctx.measureText(phoneText).width;

    if (style.phoneBackground) {
      drawTextBackgroundPill(ctx, phoneX, phoneCenterY, textWidth, phoneFontSize);
    }

    drawOutlinedText(ctx, phoneText, phoneX, phoneCenterY, {
      font: buildCanvasFont(style.phoneFontFamily, phoneFontSize, "bold"),
      fillStyle: style.phoneColor,
      lineWidth: 3,
      shadowBlur: style.phoneBackground ? 0 : 10,
    });
  }

  if (overlayPlan.sticker) {
    drawStickerOnFrame(ctx, width, height, overlayPlan.sticker, frameIndex, fps);
  }
}

async function writeTextOverlayAssets({ jobDir, template, overlayPlan }) {
  if (!overlayPlan.enabled) {
    return null;
  }

  await ensureFontRegistered();

  const width = template.width;
  const height = template.height;
  const fps = template.fps || 30;
  const frameCount = Math.max(1, Math.round(template.duration * fps));
  const framesDir = path.join(jobDir, "overlay-frames");
  await fs.mkdir(framesDir, { recursive: true });

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    renderOverlayFrame(ctx, width, height, overlayPlan, frameIndex, fps);
    const framePath = path.join(
      framesDir,
      `overlay_${String(frameIndex + 1).padStart(4, "0")}.png`,
    );
    await fs.writeFile(framePath, canvas.toBuffer("image/png"));
  }

  return {
    framesDir,
    framePattern: path.join(framesDir, "overlay_%04d.png"),
    fps,
    overlayPlan,
  };
}

module.exports = {
  buildTextOverlayPlan,
  writeTextOverlayAssets,
  normalizeTextStyle,
  DEFAULT_TEXT_STYLE,
  normalizeSticker,
};
