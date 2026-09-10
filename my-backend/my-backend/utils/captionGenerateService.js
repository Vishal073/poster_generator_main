/**
 * OpenAI text-only caption generator.
 * Returns one Hindi caption; AI picks shayari vs normal style.
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
  return `You write ONE WhatsApp/Facebook caption for Indian public leaders (rajneta / social workers).

Return ONLY valid JSON:
{
  "style": "shayari" | "normal",
  "caption": "..."
}

Language: shuddh Hindi (Devanagari) only. Default Hindi. No English. No Hinglish. No emojis. No hashtags unless the user included them.

Decide style yourself:
- Use "shayari" for emotional / celebratory / seva moments: blood donation, birthday, anniversary, sports win, festival, tribute, big public event, khushi / gambhir seva.
- Use "normal" for simple updates: meeting, visit, small notice, routine announcement, plain info.

Shayari rules (when style=shayari):
- Leader tone, not romantic/filmy love shayari.
- 2 strong poetic lines + optional 1 short factual line (event/place).
- Soft rhyme or parallel rhythm. Memorable and shareable.
- Avoid weak filler: "बहुत खुशी हुई", "आज का दिन यादगार".

Normal rules (when style=normal):
- Clear, dignified 1–2 short Hindi sentences.
- Factual, seva/public tone. No forced poetry.

Keep caption under 220 characters. Match the user's occasion exactly.`;
}

/**
 * @param {string} rawText
 * @returns {Promise<{ caption: string, style: 'shayari'|'normal', model: string }>}
 */
async function generateCaption(rawText) {
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
        temperature: 0.85,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Write one Hindi caption for this note.\n` +
              `Choose shayari or normal yourself.\n\n` +
              `Note:\n${input}`,
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

    const caption = String(parsed?.caption || "").trim();
    if (!caption) {
      throw new Error("Caption AI returned an empty caption.");
    }

    const style =
      String(parsed?.style || "").trim().toLowerCase() === "shayari"
        ? "shayari"
        : "normal";

    return { caption, style, model };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Caption generation timed out. Please try again.");
    }
    throw new Error(getErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

/** @deprecated use generateCaption */
async function generateCaptions(rawText) {
  const result = await generateCaption(rawText);
  return {
    hindi: result.caption,
    english: result.caption,
    shayari: result.caption,
    style: result.style,
    model: result.model,
  };
}

module.exports = {
  generateCaption,
  generateCaptions,
  getCaptionModel,
};
