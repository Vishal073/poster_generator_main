const sharp = require("sharp");
const { isAiProviderConfigured, modifyPosterWithAi } = require("./posterAiModifyService");

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);

const PRIORITY_PROVIDER = {
  medium: "openai",
  high: "google",
};

function normalizeEnhancePriority(value, defaultPriority = "medium") {
  const fallback = VALID_PRIORITIES.has(defaultPriority) ? defaultPriority : "medium";
  const normalized = String(value ?? fallback).trim().toLowerCase();

  if (["low", "none", "off", "0", "false"].includes(normalized)) {
    return "low";
  }
  if (["high", "premium", "ai"].includes(normalized)) {
    return "high";
  }
  if (["medium", "med", "normal", "standard"].includes(normalized)) {
    return "medium";
  }

  return fallback;
}

function isAiEnhanceEnabled() {
  const value = String(process.env.POSTER_AI_ENHANCE_ENABLED ?? "true").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(value);
}

function getProviderForPriority(enhancePriority) {
  return PRIORITY_PROVIDER[enhancePriority] || null;
}

function getProviderConfigError(provider) {
  if (provider === "openai") {
    return "OPENAI_API_KEY is not configured on the server.";
  }
  if (provider === "google") {
    return "GEMINI_API_KEY is not configured on the server.";
  }
  return "AI provider is not configured.";
}

async function applyLocalPolish(buffer, profile = "low") {
  if (profile === "fallback") {
    return sharp(buffer)
      .normalize()
      .modulate({ brightness: 1.03, saturation: 1.08 })
      .linear(1.06, -6)
      .sharpen({ sigma: 1.0, m1: 0.5, m2: 2.2, x1: 2, y2: 10, y3: 20 })
      .png({ quality: 93, compressionLevel: 8 })
      .toBuffer();
  }

  return sharp(buffer)
    .normalize()
    .modulate({ brightness: 1.04, saturation: 1.06 })
    .linear(1.05, -5)
    .png({ quality: 92, compressionLevel: 8 })
    .toBuffer();
}

async function fallbackToLocalPolish(buffer, enhancePriority, provider, errorMessage) {
  const polishedBuffer = await applyLocalPolish(buffer, "fallback");
  return {
    buffer: polishedBuffer,
    enhancePriority,
    enhanceApplied: "local-premium",
    enhanceFallback: true,
    enhanceError: errorMessage,
    aiProvider: provider,
    aiModel: null,
  };
}

async function enhancePosterBuffer(buffer, options = {}) {
  const defaultPriority = options.defaultPriority || "medium";
  const enhancePriority = normalizeEnhancePriority(options.enhancePriority, defaultPriority);

  if (enhancePriority === "low") {
    const polishedBuffer = await applyLocalPolish(buffer, "low");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local",
      enhanceFallback: false,
      enhanceError: null,
      aiProvider: null,
      aiModel: null,
    };
  }

  const provider = getProviderForPriority(enhancePriority);
  if (!provider) {
    const polishedBuffer = await applyLocalPolish(buffer, "low");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local",
      enhanceFallback: true,
      enhanceError: "Unknown enhancement priority.",
      aiProvider: null,
      aiModel: null,
    };
  }

  if (!isAiEnhanceEnabled()) {
    return fallbackToLocalPolish(
      buffer,
      enhancePriority,
      provider,
      "POSTER_AI_ENHANCE_ENABLED is false."
    );
  }

  if (!isAiProviderConfigured(provider)) {
    return fallbackToLocalPolish(
      buffer,
      enhancePriority,
      provider,
      getProviderConfigError(provider)
    );
  }

  try {
    const aiResult = await modifyPosterWithAi(buffer, { provider });
    return {
      buffer: aiResult.buffer,
      enhancePriority,
      enhanceApplied: "ai-modify",
      enhanceFallback: false,
      enhanceError: null,
      aiProvider: aiResult.provider,
      aiModel: aiResult.model,
    };
  } catch (error) {
    console.error(`AI poster modification failed (${provider}):`, error.message);
    return fallbackToLocalPolish(buffer, enhancePriority, provider, error.message);
  }
}

module.exports = {
  normalizeEnhancePriority,
  enhancePosterBuffer,
  getProviderForPriority,
};
