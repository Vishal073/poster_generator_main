const sharp = require("sharp");

const DEFAULT_MODIFY_PROMPT = `Lightly polish this already-composed poster so it looks cleaner and more premium.

This is a polish-only job. Do not redesign.

Keep exactly the same:
- Layout, crop, and placement of every element
- All text (names, titles, party, address, phone, Hindi/Punjabi/English) — same words, same spelling, same position
- Face, pose, identity, logo, colors, and background design

Only improve:
- Lighting, contrast, sharpness, and color balance
- Photo blend so it does not look pasted on
- Overall finished print look

Do not add, remove, or move text, people, slogans, icons, watermarks, or decorations.`;

const DEFAULT_FAL_MODELS = {
  medium: "fal-ai/flux-kontext/dev",
  high: "fal-ai/flux-pro/kontext",
};

function getBaseModifyPrompt() {
  if (process.env.POSTER_AI_FAL_MODIFY_PROMPT) {
    return process.env.POSTER_AI_FAL_MODIFY_PROMPT.trim();
  }
  return (
    process.env.POSTER_AI_MODIFY_PROMPT ||
    process.env.POSTER_AI_ENHANCE_PROMPT ||
    DEFAULT_MODIFY_PROMPT
  ).trim();
}

function formatLockedText(textLines) {
  if (!Array.isArray(textLines)) {
    return "";
  }

  const lines = textLines
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  return `\n\nLocked text (keep identical, sharp, and fully readable):\n${lines
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n")}`;
}

function getModifyPrompt(textLines) {
  return `${getBaseModifyPrompt()}${formatLockedText(textLines)}`;
}

function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function getOpenAiModel() {
  return String(process.env.POSTER_AI_OPENAI_MODEL || "gpt-image-1-mini").trim();
}

function getOpenAiQuality() {
  const quality = String(process.env.POSTER_AI_OPENAI_QUALITY || "medium")
    .trim()
    .toLowerCase();
  if (["low", "medium", "high"].includes(quality)) {
    return quality;
  }
  return "medium";
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
    return sharp(modifiedBuffer).png({ compressionLevel: 6 }).toBuffer();
  }

  const modified = await sharp(modifiedBuffer).metadata();
  const alreadyMatches =
    modified.width === original.width && modified.height === original.height;

  const pipeline = alreadyMatches
    ? sharp(modifiedBuffer)
    : sharp(modifiedBuffer).resize(original.width, original.height, {
        fit: "fill",
      });

  return pipeline.png({ compressionLevel: 6 }).toBuffer();
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

async function pickOpenAiSize(buffer) {
  const configured = String(process.env.POSTER_AI_OPENAI_SIZE || "auto")
    .trim()
    .toLowerCase();
  if (configured && configured !== "auto") {
    return configured;
  }

  const { width = 1024, height = 1024 } = await sharp(buffer).metadata();
  const ratio = width / Math.max(height, 1);
  if (ratio > 1.15) {
    return "1536x1024";
  }
  if (ratio < 0.87) {
    return "1024x1536";
  }
  return "1024x1024";
}

async function modifyWithOpenAi(buffer, textLines) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const png = await sharp(buffer).png().toBuffer();
  const form = new FormData();
  form.append("model", getOpenAiModel());
  form.append("prompt", getModifyPrompt(textLines));
  form.append("quality", getOpenAiQuality());
  form.append("size", await pickOpenAiSize(buffer));
  form.append("n", "1");
  form.append("output_format", "png");
  form.append(
    "image",
    new File([new Uint8Array(png)], "poster.png", { type: "image/png" }),
  );

  const timeoutMs = Number(process.env.POSTER_AI_OPENAI_TIMEOUT_MS || 120000);
  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      `OpenAI image edit failed (${response.status}).`;
    throw new Error(message);
  }

  const b64 = payload?.data?.[0]?.b64_json;
  if (b64) {
    return resizeToMatchOriginal(Buffer.from(b64, "base64"), buffer);
  }

  const url = payload?.data?.[0]?.url;
  if (url) {
    const edited = await downloadImageBuffer(url);
    return resizeToMatchOriginal(edited, buffer);
  }

  throw new Error("OpenAI returned no image in the response.");
}

async function modifyWithFal(buffer, enhancePriority, textLines) {
  const modelId = getFalModelForPriority(enhancePriority);
  const imageUrl = `data:image/png;base64,${buffer.toString("base64")}`;

  const payload = await callFalModel(modelId, {
    prompt: getModifyPrompt(textLines),
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
  return Boolean(getOpenAiApiKey() || getFalApiKey());
}

async function modifyPosterWithAi(buffer, options = {}) {
  const enhancePriority = options.enhancePriority || "medium";
  const textLines = options.textLines;

  if (getOpenAiApiKey()) {
    const model = getOpenAiModel();
    const result = await modifyWithOpenAi(buffer, textLines);
    return { buffer: result, provider: "openai", model };
  }

  if (getFalApiKey()) {
    const model = getFalModelForPriority(enhancePriority);
    const result = await modifyWithFal(buffer, enhancePriority, textLines);
    return { buffer: result, provider: "fal", model };
  }

  throw new Error("Set OPENAI_API_KEY (GPT Image mini) or FAL_KEY on the server.");
}

module.exports = {
  getModifyPrompt,
  DEFAULT_MODIFY_PROMPT,
  getFalModelForPriority,
  isAiProviderConfigured,
  modifyPosterWithAi,
};
