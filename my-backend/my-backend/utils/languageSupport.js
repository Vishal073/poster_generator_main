const fs = require("fs");
const path = require("path");
const Sanscript = require("@indic-transliteration/sanscript");

const HINDI_FONT_FAMILY = "Noto Sans Devanagari";
const ENGLISH_FONT_FAMILY = "Helvetica Neue";
const DEVANAGARI_REGEX = /[\u0900-\u097F]/;

const PHRASE_MAP = {
  "district president": "जिला अध्यक्ष",
  "state president": "प्रदेश अध्यक्ष",
  "ward president": "वार्ड अध्यक्ष",
  "block president": "ब्लॉक अध्यक्ष",
  "district vice president": "जिला उपाध्यक्ष",
  "state vice president": "प्रदेश उपाध्यक्ष",
  "general secretary": "महासचिव",
  "district secretary": "जिला सचिव",
  "president": "अध्यक्ष",
  "vice president": "उपाध्यक्ष",
  "secretary": "सचिव",
  "shopkeeper": "दुकानदार",
  "politician": "राजनेता",
};

let fontsRegistered = false;

function normalizeLanguage(language) {
  const value = String(language || "en").trim().toLowerCase();
  if (["hi", "hindi", "hin"].includes(value)) {
    return "hi";
  }
  return "en";
}

function normalizePhraseKey(text) {
  return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isDigitsOnly(value) {
  return /^\d+$/.test(value);
}

function isAcronym(value) {
  return /^[A-Z0-9]{2,}$/.test(value);
}

function isDevanagariText(value) {
  return DEVANAGARI_REGEX.test(value);
}

function shouldPreserveToken(token) {
  if (!token) {
    return true;
  }
  if (isUrl(token) || isDigitsOnly(token) || isAcronym(token) || isDevanagariText(token)) {
    return true;
  }
  return false;
}

function translatePhrase(text) {
  const key = normalizePhraseKey(text);
  if (!key) {
    return null;
  }
  return PHRASE_MAP[key] || null;
}

function toItransWord(word) {
  let value = String(word || "").toLowerCase();
  if (!value) {
    return value;
  }

  value = value
    .replace(/al$/, "Ala")
    .replace(/ar$/, "Ara")
    .replace(/an$/, "Ana")
    .replace(/esh$/, "esha")
    .replace(/ee$/, "I")
    .replace(/oo$/, "U");

  if (/[bcdfghjklmnpqrstvwxyz]$/i.test(value)) {
    value += "a";
  }

  return value;
}

function transliterateWord(word) {
  if (shouldPreserveToken(word)) {
    return word;
  }

  const match = String(word).match(/^([^A-Za-z0-9]*)([A-Za-z0-9]+)([^A-Za-z0-9]*)$/);
  if (!match) {
    return word;
  }

  const [, prefix, core, suffix] = match;
  if (shouldPreserveToken(core)) {
    return word;
  }

  try {
    const hindi = Sanscript.t(toItransWord(core), "itrans", "devanagari").replace(/\u094D$/u, "");
    return `${prefix}${hindi}${suffix}`;
  } catch (error) {
    return word;
  }
}

function transliterateText(text) {
  const content = String(text || "");
  if (!content.trim() || isDevanagariText(content)) {
    return content;
  }

  return content
    .split(/(\s+)/)
    .map((part) => (/\s+/.test(part) ? part : transliterateWord(part)))
    .join("");
}

function applyLanguageToText(text, language) {
  if (normalizeLanguage(language) !== "hi") {
    return String(text || "");
  }

  const content = String(text || "");
  if (!content.trim() || isDevanagariText(content)) {
    return content;
  }

  const translatedPhrase = translatePhrase(content);
  if (translatedPhrase) {
    return translatedPhrase;
  }

  return transliterateText(content);
}

function applyLanguageToTextLines(textLines, language) {
  if (!Array.isArray(textLines)) {
    return textLines;
  }

  return textLines.map((line) => applyLanguageToText(line, language));
}

function applyLanguageToPosterContent({ name, textLines, language, fontFamily, textLineStyles }) {
  const normalizedLanguage = normalizeLanguage(language);
  const resolvedName = applyLanguageToText(name, normalizedLanguage);
  const resolvedTextLines = applyLanguageToTextLines(textLines, normalizedLanguage);
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
  PHRASE_MAP,
  normalizeLanguage,
  applyLanguageToPosterContent,
  applyLanguageToText,
  registerPosterFonts,
  transliterateText,
  translatePhrase,
};
