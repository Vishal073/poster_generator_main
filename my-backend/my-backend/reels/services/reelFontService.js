const fs = require("fs");
const path = require("path");
const { registerPosterFonts, POPPINS_FONT_FAMILY } = require("../../utils/languageSupport");

const NOTO_SANS_BOLD_FAMILY = "Noto Sans Bold";
const DEFAULT_REEL_FONT_FAMILY = POPPINS_FONT_FAMILY;

const FONT_FAMILY_ALIASES = {
  "Helvetica Neue": POPPINS_FONT_FAMILY,
  "Avenir Next": "Plus Jakarta Sans",
};

let fontsReady = false;

function registerReelFonts() {
  if (fontsReady) {
    return;
  }

  registerPosterFonts();

  let registerFont;
  try {
    ({ registerFont } = require("canvas"));
  } catch {
    fontsReady = true;
    return;
  }

  const notoPath = path.join(__dirname, "../assets/fonts/NotoSans-Bold.ttf");
  if (fs.existsSync(notoPath)) {
    registerFont(notoPath, { family: NOTO_SANS_BOLD_FAMILY, weight: "bold" });
  }

  fontsReady = true;
}

function resolveReelFontFamily(fontFamily) {
  const trimmed = String(fontFamily || "").trim();
  if (!trimmed) {
    return DEFAULT_REEL_FONT_FAMILY;
  }

  return FONT_FAMILY_ALIASES[trimmed] || trimmed;
}

function buildCanvasFont(fontFamily, fontSize, fontWeight = "bold") {
  const family = resolveReelFontFamily(fontFamily);
  return `${fontWeight} ${Math.round(fontSize)}px "${family}"`;
}

module.exports = {
  registerReelFonts,
  buildCanvasFont,
  resolveReelFontFamily,
  DEFAULT_REEL_FONT_FAMILY,
};
