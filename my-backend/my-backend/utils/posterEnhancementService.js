const sharp = require("sharp");
const cloudinary = require("../services/cloudnaryService");
const { uploadBufferToCloudinary } = require("../services/cloudnaryService");

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

function getReplicateToken() {
  return String(process.env.REPLICATE_API_TOKEN || "").trim();
}

function getAiModelPath() {
  return (
    process.env.POSTER_AI_REPLICATE_MODEL ||
    process.env.POSTER_AI_MODIFY_MODEL ||
    "black-forest-labs/flux-kontext-pro"
  );
}

function isUpscaleModel(modelPath) {
  return /upscale|esrgan|clarity|swinir|gfpgan/i.test(String(modelPath || ""));
}

function isKontextModel(modelPath) {
  return /kontext|flux-kontext/i.test(String(modelPath || ""));
}

async function applyLocalPolish(buffer, profile = "medium") {
  const isPremium = profile === "high" || profile === "premium";

  if (isPremium) {
    return sharp(buffer)
      .normalize()
      .modulate({ brightness: 1.05, saturation: 1.12 })
      .linear(1.12, -12)
      .sharpen({ sigma: 1.4, m1: 0.6, m2: 3, x1: 2, y2: 12, y3: 24 })
      .png({ quality: 96, compressionLevel: 8 })
      .toBuffer();
  }

  return sharp(buffer)
    .normalize()
    .modulate({ brightness: 1.03, saturation: 1.08 })
    .linear(1.06, -6)
    .sharpen({ sigma: 1.0, m1: 0.5, m2: 2.2, x1: 2, y2: 10, y3: 20 })
    .png({ quality: 93, compressionLevel: 8 })
    .toBuffer();
}

async function downloadImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download enhanced image: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadTempImageForAi(buffer) {
  const fileName = `ai-temp-${Date.now()}.png`;
  const folder = process.env.CLOUDINARY_AI_TEMP_FOLDER || "poster-ai-temp";
  return uploadBufferToCloudinary(buffer, fileName, { folder });
}

async function deleteTempImage(publicId) {
  if (!publicId) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (error) {
    console.warn("Failed to delete temp AI image:", error.message);
  }
}

function buildReplicateInput(imageUrl, modelPath) {
  const prompt =
    process.env.POSTER_AI_ENHANCE_PROMPT ||
    process.env.POSTER_AI_MODIFY_PROMPT ||
    "Modify it.";

  if (isKontextModel(modelPath)) {
    return {
      prompt,
      input_image: imageUrl,
      aspect_ratio: "match_input_image",
    };
  }

  if (isUpscaleModel(modelPath)) {
    return { image: imageUrl };
  }

  return {
    image: imageUrl,
    prompt,
    negative_prompt:
      process.env.POSTER_AI_ENHANCE_NEGATIVE_PROMPT ||
      "changed text, misspelling, blurry text, distorted face, watermark, low quality",
    ...(process.env.POSTER_AI_REPLICATE_DENOISE
      ? { denoising_strength: Number(process.env.POSTER_AI_REPLICATE_DENOISE) }
      : {}),
  };
}

async function waitForReplicatePrediction(prediction, token) {
  const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
  let current = prediction;
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (terminalStatuses.has(current.status)) {
      return current;
    }

    if (!current.urls?.get) {
      throw new Error("Replicate prediction did not return a polling URL.");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const pollResponse = await fetch(current.urls.get, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(`Replicate polling error (${pollResponse.status}): ${errorText}`);
    }

    current = await pollResponse.json();
  }

  throw new Error("Replicate prediction timed out while waiting for AI enhancement.");
}

async function applyAiModification(buffer) {
  const token = getReplicateToken();
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is not configured on the server.");
  }

  const modelPath = getAiModelPath();
  let tempUpload = null;

  try {
    tempUpload = await uploadTempImageForAi(buffer);

    const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        input: buildReplicateInput(tempUpload.imageUrl, modelPath),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Replicate API error (${response.status}): ${errorText}`);
    }

    const prediction = await waitForReplicatePrediction(await response.json(), token);
    if (prediction.status === "failed") {
      throw new Error(prediction.error || "Replicate prediction failed.");
    }

    const output = prediction.output;
    const outputUrl = Array.isArray(output) ? output[0] : output;
    if (!outputUrl || typeof outputUrl !== "string") {
      throw new Error("Replicate returned an unexpected output format.");
    }

    return downloadImageBuffer(outputUrl);
  } finally {
    if (tempUpload?.publicId) {
      await deleteTempImage(tempUpload.publicId);
    }
  }
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
      enhanceError: null,
    };
  }

  if (enhancePriority === "medium") {
    const polishedBuffer = await applyLocalPolish(buffer, "medium");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local",
      enhanceFallback: false,
      enhanceError: null,
    };
  }

  const replicateToken = getReplicateToken();
  if (!isAiEnhanceEnabled()) {
    const polishedBuffer = await applyLocalPolish(buffer, "high");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local-premium",
      enhanceFallback: true,
      enhanceError: "POSTER_AI_ENHANCE_ENABLED is false.",
    };
  }

  if (!replicateToken) {
    const polishedBuffer = await applyLocalPolish(buffer, "high");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local-premium",
      enhanceFallback: true,
      enhanceError: "REPLICATE_API_TOKEN is not configured on the server.",
    };
  }

  try {
    const aiBuffer = await applyAiModification(buffer);
    return {
      buffer: aiBuffer,
      enhancePriority,
      enhanceApplied: "ai-modify",
      enhanceFallback: false,
      enhanceError: null,
    };
  } catch (error) {
    console.error("AI poster modification failed, using local premium polish:", error.message);
    const polishedBuffer = await applyLocalPolish(buffer, "high");
    return {
      buffer: polishedBuffer,
      enhancePriority,
      enhanceApplied: "local-premium",
      enhanceFallback: true,
      enhanceError: error.message,
    };
  }
}

module.exports = {
  normalizeEnhancePriority,
  enhancePosterBuffer,
};
