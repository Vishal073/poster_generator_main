const sharp = require("sharp");

const DEFAULT_MODIFY_PROMPT = `You are a professional poster designer. Improve this poster to look premium and print-ready.

Rules:
- Keep every word of text exactly as shown (names, titles, phone numbers, Hindi/Punjabi text). Do not change, remove, or misspell any text.
- Keep all faces and profile photos unchanged and recognizable.
- Match colors, style, and theme to the existing poster design.
- Improve the bottom contact/footer area: better layout, background, spacing, and visual polish. Add design elements (waves, dividers, icons) only if they fit the poster naturally.
- Improve overall lighting, contrast, and depth. Make it look like a finished campaign poster, not a plain template with text pasted on.`;

const DEFAULT_FAL_MODELS = {
  medium: "fal-ai/flux-kontext/dev",
  high: "fal-ai/flux-pro/kontext",
};

function getModifyPrompt() {
  if (process.env.POSTER_AI_FAL_MODIFY_PROMPT) {
    return process.env.POSTER_AI_FAL_MODIFY_PROMPT.trim();
  }
  return (
    process.env.POSTER_AI_MODIFY_PROMPT ||
    process.env.POSTER_AI_ENHANCE_PROMPT ||
    DEFAULT_MODIFY_PROMPT
  ).trim();
}

function getFalApiKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
}

function getFalModelForPriority(enhancePriority) {
  if (enhancePriority === "high") {
    return process.env.POSTER_AI_FAL_MODEL_HIGH || DEFAULT_FAL_MODELS.high;
  }
  if (enhancePriority === "medium") {
    return process.env.POSTER_AI_FAL_MODEL_MEDIUM || DEFAULT_FAL_MODELS.medium;
  }
  return process.env.POSTER_AI_FAL_MODEL || DEFAULT_FAL_MODELS.medium;
}

async function resizeToMatchOriginal(modifiedBuffer, originalBuffer) {
  const original = await sharp(originalBuffer).metadata();
  if (!original.width || !original.height) {
    return modifiedBuffer;
  }

  return sharp(modifiedBuffer)
    .resize(original.width, original.height, { fit: "cover" })
    .png()
    .toBuffer();
}

function extractImageUrlFromFalResponse(payload) {
  const data = payload?.response || payload?.data || payload;
  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("fal.ai returned no image in the response.");
  }
  return imageUrl;
}

async function downloadImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download fal.ai image (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function pollFalQueueResult(modelId, requestId) {
  const apiKey = getFalApiKey();
  const timeoutMs = Number(process.env.POSTER_AI_FAL_TIMEOUT_MS || 120000);
  const pollIntervalMs = Number(process.env.POSTER_AI_FAL_POLL_MS || 2000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const statusResponse = await fetch(
      `https://queue.fal.run/${modelId}/requests/${requestId}/status`,
      {
        headers: {
          Authorization: `Key ${apiKey}`,
        },
      }
    );

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text();
      throw new Error(`fal.ai queue status error (${statusResponse.status}): ${errorText}`);
    }

    const statusPayload = await statusResponse.json();
    if (statusPayload.status === "COMPLETED") {
      const resultResponse = await fetch(
        `https://queue.fal.run/${modelId}/requests/${requestId}`,
        {
          headers: {
            Authorization: `Key ${apiKey}`,
          },
        }
      );

      if (!resultResponse.ok) {
        const errorText = await resultResponse.text();
        throw new Error(`fal.ai queue result error (${resultResponse.status}): ${errorText}`);
      }

      return resultResponse.json();
    }

    if (["FAILED", "CANCELLED"].includes(statusPayload.status)) {
      throw new Error(`fal.ai request ${statusPayload.status.toLowerCase()}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("fal.ai request timed out.");
}

async function callFalModel(modelId, input) {
  const apiKey = getFalApiKey();
  if (!apiKey) {
    throw new Error("FAL_KEY is not configured on the server.");
  }

  const response = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fal.ai request error (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (payload.request_id) {
    return pollFalQueueResult(modelId, payload.request_id);
  }

  return payload;
}

async function modifyWithFal(buffer, enhancePriority) {
  const modelId = getFalModelForPriority(enhancePriority);
  const imageUrl = `data:image/png;base64,${buffer.toString("base64")}`;

  const payload = await callFalModel(modelId, {
    prompt: getModifyPrompt(),
    image_url: imageUrl,
    output_format: "png",
    num_images: 1,
    resolution_mode: "match_input",
  });

  const editedUrl = extractImageUrlFromFalResponse(payload);
  const edited = await downloadImageBuffer(editedUrl);
  return resizeToMatchOriginal(edited, buffer);
}

function isAiProviderConfigured() {
  return Boolean(getFalApiKey());
}

async function modifyPosterWithAi(buffer, options = {}) {
  const enhancePriority = options.enhancePriority || "medium";
  const model = getFalModelForPriority(enhancePriority);
  const result = await modifyWithFal(buffer, enhancePriority);
  return { buffer: result, provider: "fal", model };
}

module.exports = {
  getModifyPrompt,
  DEFAULT_MODIFY_PROMPT,
  getFalModelForPriority,
  isAiProviderConfigured,
  modifyPosterWithAi,
};
