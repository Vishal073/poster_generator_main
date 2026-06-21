const fs = require("fs");
const path = require("path");
const { transliterateText } = require("./googleTransliterate");

const HINDI_FONT_FAMILY = "Noto Sans Devanagari";
const PUNJABI_FONT_FAMILY = "Noto Sans Gurmukhi";
const ENGLISH_FONT_FAMILY = "Helvetica Neue";
const WATERMARK_FONT_FAMILY = "Plus Jakarta Sans";

const DEVANAGARI_REGEX = /[\u0900-\u097F]/;
const GURMUKHI_REGEX = /[\u0A00-\u0A7F]/;

const LANGUAGE_CONFIG = {
  hi: {
    fontFamily: HINDI_FONT_FAMILY,
    fontFile: "NotoSansDevanagari-Regular.ttf",
    scriptRegex: DEVANAGARI_REGEX,
  },
  pa: {
    fontFamily: PUNJABI_FONT_FAMILY,
    fontFile: "NotoSansGurmukhi-Regular.ttf",
    scriptRegex: GURMUKHI_REGEX,
  },
};

// Optional manual overrides — only for special cases you want to force.
const CUSTOM_MAP = {
  hi: {
    "district president": "जिला अध्यक्ष",
  },
  pa: {
    "district president": "ਜ਼ਿਲ੍ਹਾ ਪ੍ਰਧਾਨ",
  },
};

const registeredFonts = new Set();

function normalizeLanguage(language) {
  const value = String(language || "en").trim().toLowerCase();
  if (["hi", "hindi", "hin"].includes(value)) {
    return "hi";
  }
  if (["pa", "punjabi", "pan", "pun"].includes(value)) {
    return "pa";
  }
  return "en";
}

function isNativeScriptText(value, language) {
  const config = LANGUAGE_CONFIG[language];
  return Boolean(config?.scriptRegex?.test(value));
}

function getCustomOverride(text, language) {
  const customKey = String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
  return CUSTOM_MAP[language]?.[customKey];
}

async function applyLanguageToText(text, language) {
  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage === "en") {
    return String(text || "");
  }

  const content = String(text || "");
  if (!content.trim() || isNativeScriptText(content, normalizedLanguage)) {
    return content;
  }

  const customOverride = getCustomOverride(content, normalizedLanguage);
  if (customOverride) {
    return customOverride;
  }

  try {
    return await transliterateText(content, normalizedLanguage);
  } catch (error) {
    console.error("Google transliteration failed, using original text:", error.message);
    return content;
  }
}

async function applyLanguageToTextLines(textLines, language) {
  if (!Array.isArray(textLines)) {
    return textLines;
  }

  return Promise.all(textLines.map((line) => applyLanguageToText(line, language)));
}

function resolveFontFamily(normalizedLanguage, fontFamily) {
  const config = LANGUAGE_CONFIG[normalizedLanguage];
  if (!config) {
    return fontFamily || ENGLISH_FONT_FAMILY;
  }

  if (!fontFamily || fontFamily === ENGLISH_FONT_FAMILY) {
    return config.fontFamily;
  }

  return fontFamily;
}

async function applyLanguageToPosterContent({
  name,
  textLines,
  language,
  fontFamily,
  textLineStyles,
}) {
  const normalizedLanguage = normalizeLanguage(language);
  const resolvedName = await applyLanguageToText(name, normalizedLanguage);
  const resolvedTextLines = await applyLanguageToTextLines(textLines, normalizedLanguage);
  const resolvedFontFamily = resolveFontFamily(normalizedLanguage, fontFamily);

  let resolvedTextLineStyles = textLineStyles;
  if (normalizedLanguage !== "en" && Array.isArray(textLineStyles)) {
    const targetFontFamily = LANGUAGE_CONFIG[normalizedLanguage]?.fontFamily;
    resolvedTextLineStyles = textLineStyles.map((style) => {
      if (!style || typeof style !== "object") {
        return style;
      }

      const nextStyle = { ...style };
      if (
        targetFontFamily &&
        (!nextStyle.fontFamily ||
          nextStyle.fontFamily === ENGLISH_FONT_FAMILY ||
          nextStyle.fontFamily === "Avenir Next")
      ) {
        nextStyle.fontFamily = targetFontFamily;
      }
      return nextStyle;
    });
  }

  return {
    language: normalizedLanguage,
    name: resolvedName,
    textLines: resolvedTextLines,
    fontFamily: resolvedFontFamily,
    textLineStyles: resolvedTextLineStyles,
  };
}

function registerLanguageFont(language) {
  const config = LANGUAGE_CONFIG[language];
  if (!config || registeredFonts.has(language)) {
    return;
  }

  let canvasApi;
  try {
    canvasApi = require("canvas");
  } catch (error) {
    return;
  }

  const fontPath = path.resolve(__dirname, "../assets/fonts", config.fontFile);
  if (!fs.existsSync(fontPath)) {
    console.warn(`${config.fontFamily} font not found at:`, fontPath);
    return;
  }

  canvasApi.registerFont(fontPath, {
    family: config.fontFamily,
    weight: "normal",
    style: "normal",
  });

  registeredFonts.add(language);
}

function registerWatermarkFont() {
  if (registeredFonts.has("watermark")) {
    return;
  }

  let canvasApi;
  try {
    canvasApi = require("canvas");
  } catch (error) {
    return;
  }

  const fontPath = path.resolve(__dirname, "../assets/fonts/PlusJakartaSans-Bold.ttf");
  if (!fs.existsSync(fontPath)) {
    console.warn(`${WATERMARK_FONT_FAMILY} font not found at:`, fontPath);
    return;
  }

  canvasApi.registerFont(fontPath, {
    family: WATERMARK_FONT_FAMILY,
    weight: "bold",
    style: "normal",
  });

  const semiBoldPath = path.resolve(__dirname, "../assets/fonts/PlusJakartaSans-SemiBold.ttf");
  if (fs.existsSync(semiBoldPath)) {
    canvasApi.registerFont(semiBoldPath, {
      family: WATERMARK_FONT_FAMILY,
      weight: "600",
      style: "normal",
    });
  }

  const mediumPath = path.resolve(__dirname, "../assets/fonts/PlusJakartaSans-Medium.ttf");
  if (fs.existsSync(mediumPath)) {
    canvasApi.registerFont(mediumPath, {
      family: WATERMARK_FONT_FAMILY,
      weight: "500",
      style: "normal",
    });
  }

  registeredFonts.add("watermark");
}

function registerPosterFonts() {
  registerLanguageFont("hi");
  registerLanguageFont("pa");
  registerWatermarkFont();
}

module.exports = {
  HINDI_FONT_FAMILY,
  PUNJABI_FONT_FAMILY,
  ENGLISH_FONT_FAMILY,
  WATERMARK_FONT_FAMILY,
  CUSTOM_MAP,
  normalizeLanguage,
  applyLanguageToPosterContent,
  applyLanguageToText,
  registerPosterFonts,
};
