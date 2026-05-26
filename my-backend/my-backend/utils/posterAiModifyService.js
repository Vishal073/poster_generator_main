const sharp = require("sharp");

const DEFAULT_MODIFY_PROMPT = `You are a professional poster designer. Improve this poster to look premium and print-ready.

Rules:
- Keep every word of text exactly as shown (names, titles, phone numbers, Hindi/Punjabi text). Do not change, remove, or misspell any text.
- Keep all faces and profile photos unchanged and recognizable.
- Match colors, style, and theme to the existing poster design.
- Improve the bottom contact/footer area: better layout, background, spacing, and visual polish. Add design elements (waves, dividers, icons) only if they fit the poster naturally.
- Improve overall lighting, contrast, and depth. Make it look like a finished campaign poster, not a plain template with text pasted on.`;

function getModifyPrompt(provider) {
  if (provider === "openai" && process.env.POSTER_AI_OPENAI_MODIFY_PROMPT) {
    return process.env.POSTER_AI_OPENAI_MODIFY_PROMPT.trim();
  }
  if (provider === "google" && process.env.POSTER_AI_GOOGLE_MODIFY_PROMPT) {
    return process.env.POSTER_AI_GOOGLE_MODIFY_PROMPT.trim();
  }
  return (
    process.env.POSTER_AI_MODIFY_PROMPT ||
    process.env.POSTER_AI_ENHANCE_PROMPT ||
    DEFAULT_MODIFY_PROMPT
  ).trim();
}

function getAiProvider() {
  const configured = String(process.env.POSTER_AI_PROVIDER || "").trim().toLowerCase();
  if (["openai", "google", "gemini"].includes(configured)) {
    return configured === "gemini" ? "google" : configured;
  }

  if (String(process.env.OPENAI_API_KEY || "").trim()) {
    return "openai";
  }
  if (String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim()) {
    return "google";
  }

  return null;
}

function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function getGoogleApiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
}

function getOpenAiModel() {
  return process.env.POSTER_AI_OPENAI_MODEL || "gpt-image-1.5";
}

function getGoogleImageModel() {
  return (
    process.env.POSTER_AI_GOOGLE_MODEL ||
    process.env.POSTER_AI_GEMINI_IMAGE_MODEL ||
    "gemini-2.5-flash-image"
  );
}

function extractBase64FromOpenAiResponse(payload) {
  const item = payload?.data?.[0];
  if (item?.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }
  if (item?.url) {
    throw new Error("OpenAI returned a URL; expected b64_json. Set response_format to b64_json.");
  }
  throw new Error("OpenAI returned an unexpected image response format.");
}

function extractImageFromGoogleResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      return Buffer.from(inline.data, "base64");
    }
  }

  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Google image modification blocked: ${blockReason}`);
  }

  throw new Error("Google returned no image in the response.");
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

async function modifyWithOpenAi(buffer) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const form = new FormData();
  form.append("model", getOpenAiModel());
  form.append("prompt", getModifyPrompt("openai"));
  form.append("image", new Blob([buffer], { type: "image/png" }), "poster.png");
  form.append("size", process.env.POSTER_AI_OPENAI_SIZE || "auto");
  form.append("quality", process.env.POSTER_AI_OPENAI_QUALITY || "high");
  form.append("output_format", "png");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI image edit error (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const edited = extractBase64FromOpenAiResponse(payload);
  return resizeToMatchOriginal(edited, buffer);
}

async function modifyWithGoogle(buffer) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not configured on the server.");
  }

  const model = getGoogleImageModel();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: getModifyPrompt("google") },
              {
                inline_data: {
                  mime_type: "image/png",
                  data: buffer.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google image modify error (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const edited = extractImageFromGoogleResponse(payload);
  return resizeToMatchOriginal(edited, buffer);
}

function isAiProviderConfigured(provider = getAiProvider()) {
  if (provider === "openai") {
    return Boolean(getOpenAiApiKey());
  }
  if (provider === "google") {
    return Boolean(getGoogleApiKey());
  }
  return false;
}

async function modifyPosterWithAi(buffer, options = {}) {
  const provider = options.provider || getAiProvider();
  if (!provider) {
    throw new Error(
      "No AI provider configured. Set POSTER_AI_PROVIDER=openai or google and the matching API key."
    );
  }

  if (provider === "openai") {
    const result = await modifyWithOpenAi(buffer);
    return { buffer: result, provider: "openai", model: getOpenAiModel() };
  }

  if (provider === "google") {
    const result = await modifyWithGoogle(buffer);
    return { buffer: result, provider: "google", model: getGoogleImageModel() };
  }

  throw new Error(`Unsupported POSTER_AI_PROVIDER: ${provider}`);
}

module.exports = {
  getAiProvider,
  getModifyPrompt,
  DEFAULT_MODIFY_PROMPT,
  isAiProviderConfigured,
  modifyPosterWithAi,
};
