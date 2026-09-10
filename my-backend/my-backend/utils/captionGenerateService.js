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
  return `You rewrite the user's rough WhatsApp content into ONE Hindi social-media caption.

Return ONLY valid JSON:
{
  "style": "shayari" | "normal",
  "caption": "..."
}

IMPORTANT: "shayari" and "normal" are TWO DIFFERENT formats. Never mix them in one caption.
- If style=shayari → ONLY poetic lines. No plain news/report sentences mixed in.
- If style=normal → ONLY normal prose lines. No shayari / rhyme / couplets.

INPUT
User may send short or long rough text (Hinglish / broken Hindi). Use ALL their facts (names, place, what happened). Do not invent new people/events.

COMMON RULES
- Positive vibe, simple Hindi (Devanagari).
- Keep user's meaning; improve wording.
- No English/Hinglish, no emojis, no hashtags (unless user included them).
- No labels like "Caption" or "Shayari" in the text.

WHEN style = "shayari" (birthday, blood donation, tribute, festival, sports win, family, seva, khushi):
- Write ONLY shayari: 2–3 lines preferred, max 4.
- Light natural rhyme OK; not forced; not over-fancy.
- All facts must appear inside the poetic lines themselves.
- Last line = short wish/blessing.
- Do NOT add extra normal/prose lines below the shayari.

WHEN style = "normal" (meeting, visit, notice, detailed update, or non-emotional content):
- Write ONLY normal social-media Hindi (sentences/paragraph).
- No line limit — cover everything the user wrote, improved.
- No rhyme, no couplets, no "shayari look".
- Use \\n between sentences if helpful.

Under 1200 characters when needed for longer user content.`;
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
              `Rewrite my content as ONE Hindi caption.\n` +
              `Pick either shayari OR normal — never mix both in the same caption.\n` +
              `- Shayari: only poetic lines (2–3, max 4) + short wish. No plain report lines.\n` +
              `- Normal: only normal social post prose covering ALL my points. No shayari.\n` +
              `Positive, simple. Improve my wording; keep my facts.\n\n` +
              `My content:\n${input}`,
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
