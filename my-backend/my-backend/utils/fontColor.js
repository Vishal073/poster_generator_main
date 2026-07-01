function normalizeFontColor(value, fallback = "#000000") {
  if (typeof value !== "string") {
    return fallback;
  }

  let trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  if (!trimmed.startsWith("#")) {
    trimmed = `#${trimmed}`;
  }

  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  const longMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (longMatch) {
    return `#${longMatch[1].toLowerCase()}`;
  }

  const alphaMatch = /^#([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/.exec(trimmed);
  if (alphaMatch) {
    return `#${alphaMatch[1].toLowerCase()}`;
  }

  return fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeFontColor(hex, "");
  if (!normalized) {
    return null;
  }

  const value = Number.parseInt(normalized.slice(1), 16);
  if (!Number.isFinite(value)) {
    return null;
  }

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function readStyleStringField(style, field) {
  if (!style || typeof style !== "object") {
    return "";
  }

  const direct = style[field];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const nested = style._doc;
  if (nested && typeof nested[field] === "string" && nested[field].trim()) {
    return nested[field].trim();
  }

  return "";
}

function readStyleNumberField(style, field) {
  if (!style || typeof style !== "object") {
    return null;
  }

  if (typeof style[field] === "number" && Number.isFinite(style[field])) {
    return style[field];
  }

  const nested = style._doc;
  if (nested && typeof nested[field] === "number" && Number.isFinite(nested[field])) {
    return nested[field];
  }

  return null;
}

module.exports = {
  normalizeFontColor,
  hexToRgb,
  readStyleStringField,
  readStyleNumberField,
};
