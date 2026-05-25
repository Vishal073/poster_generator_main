const sharp = require("sharp");

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
  const value = String(process.env.POSTER_AI_ENHANCE_ENABLED ?? "true").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(value);
}

async function applyLocalPolish(buffer, profile = "medium") {
  const isPremium = profile === "high" || profile === "premium";

  return sharp(buffer)
    .normalize()
    .modulate({
      brightness: isPremium ? 1.02 : 1.01,
      saturation: isPremium ? 1.06 : 1.03,
    })
    .linear(isPremium ? 1.08 : 1.04, isPremium ? -8 : -4)
    .sharpen({
      sigma: isPremium ? 1.15 : 0.85,
      m1: 0.5,
      m2: isPremium ? 2.5 : 2,
      x1: 2,
      y2: 10,
      y3: 20,
    })
    .png({
      quality: isPremium ? 96 : 92,
      compressionLevel: 8,
    })
    .toBuffer();
}

async function downloadImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download enhanced image: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function applyAiEnhancement(buffer) {
  const token = String(process.env.REPLICATE_API_TOKEN || "").trim();
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is not configured.");
  }

  const modelPath =
    process.env.POSTER_AI_REPLICATE_MODEL || "recraft-ai/recraft-crisp-upscale";
  const imageDataUri = `data:image/png;base64,${buffer.toString("base64")}`;

  const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=120",
    },
    body: JSON.stringify({
      input: {
        image: imageDataUri,
        prompt:
          process.env.POSTER_AI_ENHANCE_PROMPT ||
          "Professional premium political poster. Improve lighting, shadows, contrast, and texture. Sharpen details. Keep all text, layout, and faces exactly the same. Minimal changes only.",
        negative_prompt:
          process.env.POSTER_AI_ENHANCE_NEGATIVE_PROMPT ||
          "changed text, misspelling, blurry text, distorted face, moved layout, watermark, low quality",
        ...(process.env.POSTER_AI_REPLICATE_DENOISE
          ? { denoising_strength: Number(process.env.POSTER_AI_REPLICATE_DENOISE) }
          : {}),
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate API error (${response.status}): ${errorText}`);
  }

  const prediction = await response.json();
  if (prediction.status === "failed") {
    throw new Error(prediction.error || "Replicate prediction failed.");
  }

  const output = prediction.output;
  const outputUrl = Array.isArray(output) ? output[0] : output;
  if (!outputUrl || typeof outputUrl !== "string") {
    throw new Error("Replicate returned an unexpected output format.");
  }

  return downloadImageBuffer(outputUrl);
}

async function enhancePosterBuffer(buffer, options = {}) {
  const defaultPriority = options.defaultPriority || "medium";
  const enhancePriority = normalizeEnhancePriority(options.enhancePriority, defaultPriority);

  if (enhancePriority === "low") {
    return {
      buffer,
      enhancePriority,
      enhanceApplied: "none",
      enhanceFallback: false,
    };
  }

  if (enhancePriority === "medium") {
    const polishedBuffer = await applyLocalPolish(buffer, "medium");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local",
      enhanceFallback: false,
    };
  }

  if (isAiEnhanceEnabled() && process.env.REPLICATE_API_TOKEN) {
    try {
      const aiBuffer = await applyAiEnhancement(buffer);
      return {
        buffer: aiBuffer,
        enhancePriority,
        enhanceApplied: "ai",
        enhanceFallback: false,
      };
    } catch (error) {
      console.error("AI poster enhancement failed, using local premium polish:", error.message);
      const polishedBuffer = await applyLocalPolish(buffer, "high");
      return {
        buffer: polishedBuffer,
        enhancePriority,
        enhanceApplied: "local-premium",
        enhanceFallback: true,
      };
    }
  }

  const polishedBuffer = await applyLocalPolish(buffer, "high");
  return {
    buffer: polishedBuffer,
    enhancePriority,
    enhanceApplied: "local-premium",
    enhanceFallback: !process.env.REPLICATE_API_TOKEN,
  };
}

module.exports = {
  normalizeEnhancePriority,
  enhancePosterBuffer,
};
