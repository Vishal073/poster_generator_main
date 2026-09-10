/**
 * OpenAI text-only caption generator (no image polish).
 * Returns Hindi, English, and leader/shayari style captions.
 */

const DEFAULT_MODEL = "gpt-4o-mini";

function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function getCaptionModel() {
  return String(process.env.CAPTION_AI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function buildSystemPrompt() {
  return `You write short social media captions for Indian public figures and political leaders.

Return ONLY valid JSON with these exact keys:
{
  "hindi": "...",
  "english": "...",
  "shayari": "..."
}

Rules:
- hindi: pure Hindi (Devanagari). Clear, respectful, seva tone. 1–3 short sentences.
- english: complete English only. Same tone. 1–3 short sentences.
- shayari: leader-style poetic Hindi (1–2 lines) plus one short factual event line if useful.
- No Hinglish. No slang. No hashtags unless the user included them.
- No quotes around the caption text values beyond normal punctuation.
- Keep each caption under 280 characters when possible.
- Match the user's occasion (blood donation, birthday, camp, anniversary, etc.).`;
}

function normalizeCaptions(parsed) {
  const hindi = String(parsed?.hindi || "").trim();
  const english = String(parsed?.english || "").trim();
  const shayari = String(parsed?.shayari || "").trim();

  if (!hindi || !english || !shayari) {
    throw new Error("Caption AI returned incomplete captions.");
  }

  return { hindi, english, shayari };
}

/**
 * @param {string} rawText - User's rough note about the post
 * @returns {Promise<{ hindi: string, english: string, shayari: string, model: string }>}
 */
async function generateCaptions(rawText) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const input = String(rawText || "").trim();
  if (!input) {
    throw new Error("Please send some text about your post.");
  }
  if (input.length > 2000) {
    throw new Error("Text is too long. Please keep it under 2000 characters.");
  }

  const model = getCaptionModel();
  const timeoutMs = Number(process.env.CAPTION_AI_TIMEOUT_MS || 45000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: `Write captions for this post note:\n\n${input}`,
          },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        data?.error?.message ||
        data?.message ||
        `OpenAI caption request failed (${response.status})`;
      throw new Error(detail);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("Caption AI returned an empty response.");
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Caption AI returned invalid JSON.");
    }

    const captions = normalizeCaptions(parsed);
    return {
      ...captions,
      model,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Caption generation timed out. Please try again.");
    }
    throw new Error(getErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  generateCaptions,
  getCaptionModel,
};
