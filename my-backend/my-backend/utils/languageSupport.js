const fs = require("fs");
const path = require("path");
const { transliterateToHindi } = require("./googleTransliterate");

const HINDI_FONT_FAMILY = "Noto Sans Devanagari";
const ENGLISH_FONT_FAMILY = "Helvetica Neue";
const DEVANAGARI_REGEX = /[\u0900-\u097F]/;

// Optional manual overrides — only for special cases you want to force.
const CUSTOM_MAP = {
  "district president": "जिला अध्यक्ष",
};

let fontsRegistered = false;

function normalizeLanguage(language) {
  const value = String(language || "en").trim().toLowerCase();
  if (["hi", "hindi", "hin"].includes(value)) {
    return "hi";
  }
  return "en";
}

function isDevanagariText(value) {
  return DEVANAGARI_REGEX.test(value);
}

async function applyLanguageToText(text, language) {
  if (normalizeLanguage(language) !== "hi") {
    return String(text || "");
  }

  const content = String(text || "");
  if (!content.trim() || isDevanagariText(content)) {
    return content;
  }

  const customKey = content.trim().replace(/\s+/g, " ").toLowerCase();
  if (CUSTOM_MAP[customKey]) {
    return CUSTOM_MAP[customKey];
  }

  try {
    return await transliterateToHindi(content);
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
  const resolvedFontFamily =
    normalizedLanguage === "hi" && (!fontFamily || fontFamily === ENGLISH_FONT_FAMILY)
      ? HINDI_FONT_FAMILY
      : fontFamily || ENGLISH_FONT_FAMILY;

  let resolvedTextLineStyles = textLineStyles;
  if (normalizedLanguage === "hi" && Array.isArray(textLineStyles)) {
    resolvedTextLineStyles = textLineStyles.map((style) => {
      if (!style || typeof style !== "object") {
        return style;
      }

      const nextStyle = { ...style };
      if (
        !nextStyle.fontFamily ||
        nextStyle.fontFamily === ENGLISH_FONT_FAMILY ||
        nextStyle.fontFamily === "Avenir Next"
      ) {
        nextStyle.fontFamily = HINDI_FONT_FAMILY;
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

function registerPosterFonts() {
  if (fontsRegistered) {
    return;
  }

  let canvasApi;
  try {
    canvasApi = require("canvas");
  } catch (error) {
    return;
  }

  const fontPath = path.resolve(
    __dirname,
    "../assets/fonts/NotoSansDevanagari-Regular.ttf"
  );

  if (!fs.existsSync(fontPath)) {
    console.warn("Hindi font not found at:", fontPath);
    return;
  }

  canvasApi.registerFont(fontPath, {
    family: HINDI_FONT_FAMILY,
    weight: "normal",
    style: "normal",
  });

  fontsRegistered = true;
}

module.exports = {
  HINDI_FONT_FAMILY,
  ENGLISH_FONT_FAMILY,
  CUSTOM_MAP,
  normalizeLanguage,
  applyLanguageToPosterContent,
  applyLanguageToText,
  registerPosterFonts,
};
