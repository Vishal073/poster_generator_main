const STICKER_PRESETS = {
  sale_badge: {
    defaultText: "SALE",
    accent: "#ff2d55",
    accentAlt: "#ffd60a",
    textColor: "#ffffff",
  },
  price_tag: {
    defaultText: "₹999",
    accent: "#ffd60a",
    accentAlt: "#111827",
    textColor: "#111827",
  },
  new_arrival: {
    defaultText: "NEW",
    accent: "#22c55e",
    accentAlt: "#ffffff",
    textColor: "#ffffff",
  },
  limited_stock: {
    defaultText: "LIMITED",
    accent: "#f97316",
    accentAlt: "#ffffff",
    textColor: "#ffffff",
  },
  call_now: {
    defaultText: "CALL NOW",
    accent: "#2563eb",
    accentAlt: "#ffffff",
    textColor: "#ffffff",
  },
  whatsapp_order: {
    defaultText: "WHATSAPP",
    accent: "#16a34a",
    accentAlt: "#ffffff",
    textColor: "#ffffff",
  },
  poll_look: {
    defaultText: "Which one?",
    accent: "#7c3aed",
    accentAlt: "#4c1d95",
    textColor: "#ffffff",
  },
  festive_sparkle: {
    defaultText: "FESTIVE",
    accent: "#eab308",
    accentAlt: "#7c2d12",
    textColor: "#ffffff",
  },
};

function clampPercent(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, parsed));
}

function clampScale(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(1.8, Math.max(0.6, Math.round(parsed * 100) / 100));
}

function normalizeSticker(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = String(raw.id || "").trim();
  const preset = STICKER_PRESETS[id];
  if (!preset) {
    return null;
  }

  const text =
    typeof raw.text === "string" && raw.text.trim()
      ? raw.text.trim().slice(0, 28)
      : preset.defaultText;

  return {
    id,
    text,
    x: clampPercent(raw.x, 78),
    y: clampPercent(raw.y, 28),
    scale: clampScale(raw.scale, 1),
    accent: preset.accent,
    accentAlt: preset.accentAlt,
    textColor: preset.textColor,
  };
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawStickerOnFrame(ctx, width, height, sticker, frameIndex, fps) {
  if (!sticker) {
    return;
  }

  const time = frameIndex / fps;
  const pulse = 0.5 + 0.5 * Math.sin((time * Math.PI * 2) / 1.25);
  const centerX = width * (sticker.x / 100);
  const centerY = height * (sticker.y / 100);
  const baseScale = sticker.scale;
  let scale = baseScale * (1 + pulse * 0.08);
  let rotation = 0;

  switch (sticker.id) {
    case "sale_badge":
      rotation = ((pulse - 0.5) * 10 * Math.PI) / 180;
      break;
    case "limited_stock":
      rotation = ((-8 + (pulse - 0.5) * 6) * Math.PI) / 180;
      break;
    case "price_tag":
    case "new_arrival":
      scale = baseScale * (1 + pulse * 0.06);
      break;
    case "festive_sparkle":
      scale = baseScale * (1 + pulse * 0.07);
      break;
    default:
      break;
  }

  const fontSize = Math.round(42 * scale);
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);

  ctx.font = `bold ${42}px Helvetica Neue, Arial, sans-serif`;
  const metrics = ctx.measureText(sticker.text);
  const textWidth = Math.max(metrics.width, 80);
  const padX = sticker.id === "poll_look" ? 36 : 28;
  const padY = sticker.id === "poll_look" ? 28 : 18;
  const boxWidth = textWidth + padX * 2;
  const boxHeight =
    fontSize + padY * 2 + (sticker.id === "poll_look" ? 44 : 0);
  const boxX = -boxWidth / 2;
  const boxY = -boxHeight / 2;

  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;

  if (sticker.id === "price_tag") {
    roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, 18);
    ctx.fillStyle = sticker.accent;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(boxX + 16, boxY + boxHeight / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fill();
  } else if (sticker.id === "festive_sparkle") {
    const gradient = ctx.createLinearGradient(boxX, boxY, boxX + boxWidth, boxY + boxHeight);
    gradient.addColorStop(0, sticker.accent);
    gradient.addColorStop(0.55, "#f97316");
    gradient.addColorStop(1, sticker.accentAlt);
    roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, 24);
    ctx.fillStyle = gradient;
    ctx.fill();
  } else if (sticker.id === "sale_badge") {
    const gradient = ctx.createLinearGradient(boxX, boxY, boxX + boxWidth, boxY + boxHeight);
    gradient.addColorStop(0, sticker.accent);
    gradient.addColorStop(1, sticker.accentAlt);
    roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, boxHeight / 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  } else if (sticker.id === "poll_look") {
    const gradient = ctx.createLinearGradient(boxX, boxY, boxX, boxY + boxHeight);
    gradient.addColorStop(0, sticker.accent);
    gradient.addColorStop(1, sticker.accentAlt);
    roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, 24);
    ctx.fillStyle = gradient;
    ctx.fill();
  } else {
    roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, boxHeight / 2);
    ctx.fillStyle = sticker.accent;
    ctx.fill();
  }

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = sticker.textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${42}px Helvetica Neue, Arial, sans-serif`;
  const textY = sticker.id === "poll_look" ? boxY + padY + fontSize / 2 : 0;
  ctx.fillText(sticker.text, 0, textY);

  if (sticker.id === "poll_look") {
    const optionY = boxY + boxHeight - 28;
    const optionW = 54;
    const optionH = 28;
    ["A", "B"].forEach((label, index) => {
      const optionX = index === 0 ? -optionW - 8 : 8;
      roundRectPath(ctx, optionX, optionY - optionH / 2, optionW, optionH, optionH / 2);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 16px Helvetica Neue, Arial, sans-serif";
      ctx.fillText(label, optionX + optionW / 2, optionY);
    });
  }

  ctx.restore();
}

module.exports = {
  normalizeSticker,
  drawStickerOnFrame,
  STICKER_PRESETS,
};
