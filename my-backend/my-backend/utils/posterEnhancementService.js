const { applyLocalPremiumEnhance } = require("./posterLocalEnhanceService");
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

function shouldUseOptionalAi(enhancePriority) {
  return enhancePriority === "high" && isAiEnhanceEnabled() && isAiProviderConfigured();
}

function buildResult(buffer, enhancePriority, enhanceApplied, extra = {}) {
  return {
    buffer,
    enhancePriority,
    enhanceApplied,
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

  // Low: light local polish only — fast and free.
  if (enhancePriority === "low") {
    const polishedBuffer = await applyLocalPremiumEnhance(buffer, "low");
    return buildResult(polishedBuffer, enhancePriority, "local");
  }

  // Medium + High: full local premium stack (Sharp, SVG overlays, grade, glow).
  const localProfile = enhancePriority === "high" ? "premium" : "medium";
  let resultBuffer = await applyLocalPremiumEnhance(buffer, localProfile);

  // Optional AI pass — only for high priority when explicitly enabled.
  if (!shouldUseOptionalAi(enhancePriority)) {
    return buildResult(resultBuffer, enhancePriority, "local-premium");
  }

  try {
    const aiResult = await modifyPosterWithAi(resultBuffer, { enhancePriority });
    return buildResult(aiResult.buffer, enhancePriority, "local-premium+ai", {
      aiProvider: aiResult.provider,
      aiModel: aiResult.model,
    });
  } catch (error) {
    console.error(`Optional AI enhancement skipped (${enhancePriority}):`, error.message);
    return buildResult(resultBuffer, enhancePriority, "local-premium", {
      enhanceFallback: true,
      enhanceError: error.message,
    });
  }
}

module.exports = {
  normalizeEnhancePriority,
  enhancePosterBuffer,
};
