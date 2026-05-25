const GOOGLE_INPUT_TOOLS_URL = "https://inputtools.google.com/request";
const DEFAULT_APP = "poster-generator";

const LANGUAGE_ITC = {
  hi: "hi-t-i0-und",
  pa: "pa-t-i0-und",
};

const cache = new Map();

function isEnabled() {
  const value = String(process.env.GOOGLE_TRANSLITERATE_ENABLED ?? "true").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(value);
}

function getItcForLanguage(language) {
  const normalized = String(language || "hi").trim().toLowerCase();
  if (process.env.GOOGLE_TRANSLITERATE_ITC && normalized === "hi") {
    return process.env.GOOGLE_TRANSLITERATE_ITC;
  }
  if (process.env.GOOGLE_TRANSLITERATE_ITC_PA && normalized === "pa") {
    return process.env.GOOGLE_TRANSLITERATE_ITC_PA;
  }
  return LANGUAGE_ITC[normalized] || LANGUAGE_ITC.hi;
}

function getCacheKey(text, language) {
  return `${getItcForLanguage(language)}::${text}`;
}

function parseGoogleResponse(payload, fallbackText) {
  if (!Array.isArray(payload) || payload[0] !== "SUCCESS" || !Array.isArray(payload[1])) {
    throw new Error("Google transliteration returned an unexpected response.");
  }

  const chunks = payload[1];
  if (!chunks.length) {
    return fallbackText;
  }

  if (chunks.length === 1) {
    return chunks[0]?.[1]?.[0] || fallbackText;
  }

  return chunks
    .map((chunk) => String(chunk?.[1]?.[0] || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function requestGoogleTransliteration(text, language) {
  const params = new URLSearchParams({
    text,
    itc: getItcForLanguage(language),
    num: "1",
    cp: "0",
    cs: "1",
    ie: "utf-8",
    oe: "utf-8",
    app: process.env.GOOGLE_TRANSLITERATE_APP || DEFAULT_APP,
  });

  const response = await fetch(`${GOOGLE_INPUT_TOOLS_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Google transliteration failed with status ${response.status}.`);
  }

  const payload = await response.json();
  return parseGoogleResponse(payload, text);
}

function isDigitsOnly(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function isAcronym(value) {
  return /^[A-Z0-9]{2,}$/.test(String(value || "").trim());
}

async function transliterateText(text, language = "hi") {
  const content = String(text || "");
  if (!content.trim()) {
    return content;
  }

  if (isDigitsOnly(content) || isAcronym(content)) {
    return content;
  }

  if (!isEnabled()) {
    return content;
  }

  const cacheKey = getCacheKey(content, language);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const result = await requestGoogleTransliteration(content, language);
  cache.set(cacheKey, result);
  return result;
}

async function transliterateToHindi(text) {
  return transliterateText(text, "hi");
}

module.exports = {
  transliterateText,
  transliterateToHindi,
};
