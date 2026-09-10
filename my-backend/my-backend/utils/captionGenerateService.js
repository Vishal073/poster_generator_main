/**
 * OpenAI text-only caption generator.
 * Rough Hinglish life-moment → Hindi shayari (or normal) caption.
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
  return `You turn a rough WhatsApp Hinglish note into a simple, positive Hindi caption.

Return ONLY valid JSON:
{
  "style": "shayari" | "normal",
  "caption": "..."
}

INPUT example:
"Aaj papa ka birthday h hmne cake cut kr k celebrate kiya"

RULES
1) Keep the user's facts (who / occasion / what happened). Include them clearly — same or very similar meaning. Do not invent new events or people.
2) Keep language SIMPLE and warm. Positive vibe is most important.
3) Do NOT make it over-fancy, heavy, or "shaayari competition" style. Easy words people actually share on WhatsApp/Facebook.
4) Shuddh Hindi (Devanagari). No English, no Hinglish, no emojis, no hashtags (unless user included them). No "Caption/Shayari" labels.

Style:
- "shayari": birthday, blood donation, tribute, festival, sports win, family, seva, khushi — simple 2–3 lines (max 4). Light natural rhyme OK; not forced.
- "normal": meeting / visit / notice — 1–2 simple positive Hindi sentences.

For shayari:
- Mention the real moment (e.g. papa, birthday, cake, celebrate) in a natural way.
- End with a short positive wish / blessing suited to the occasion.
- Separate lines with \\n.

Under 400 characters. Prefer short and clear over literary.`;
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
        temperature: 0.75,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Rough Hinglish note from WhatsApp.\n\n` +
              `Write a SIMPLE positive Hindi caption (prefer light shayari 2–3 lines, max 4; or short normal Hindi).\n` +
              `Must include my facts (same or very similar). Positive vibe. Not over-fancy.\n` +
              `End with a short good wish if it fits.\n\n` +
              `My line:\n${input}`,
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

    const caption = String(parsed?.caption || "")
      .replace(/\\n/g, "\n")
      .trim();
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
