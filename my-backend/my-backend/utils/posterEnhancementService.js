const { isAiProviderConfigured, modifyPosterWithAi } = require("./posterAiModifyService");

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);

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
  const value = String(process.env.POSTER_AI_ENHANCE_ENABLED ?? "false").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(value);
}

function passthroughResult(buffer, enhancePriority, extra = {}) {
  return {
    buffer,
    enhancePriority,
    enhanceApplied: "none",
    enhanceFallback: false,
    enhanceError: null,
    aiProvider: null,
    aiModel: null,
    ...extra,
  };
}

async function enhancePosterBuffer(buffer, options = {}) {
  const defaultPriority = options.defaultPriority || "medium";
  const enhancePriority = normalizeEnhancePriority(options.enhancePriority, defaultPriority);

  const shouldRunAi =
    enhancePriority === "high" && isAiEnhanceEnabled() && isAiProviderConfigured();

  if (!shouldRunAi) {
    return passthroughResult(buffer, enhancePriority);
  }

  try {
    const aiResult = await modifyPosterWithAi(buffer, { enhancePriority });
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
    console.error(`AI poster modification failed (${enhancePriority}):`, error.message);
    return passthroughResult(buffer, enhancePriority, {
      enhanceFallback: true,
      enhanceError: error.message,
    });
  }
}

module.exports = {
  normalizeEnhancePriority,
  enhancePosterBuffer,
};
