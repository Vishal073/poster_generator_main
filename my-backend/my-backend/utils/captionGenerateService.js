/**
 * OpenAI text-only caption generator.
 * Returns one Hindi caption; AI picks shayari vs normal style.
 * Stays close to the user's own words — polish, don't invent a new poem.
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
  return `You are a Hindi caption editor for Indian public leaders (rajneta / social posts).

Return ONLY valid JSON:
{
  "style": "shayari" | "normal",
  "caption": "..."
}

CRITICAL — stay close to the user's text:
- The user's note is the source of truth (names, event, feeling, words).
- Do NOT invent a totally new unrelated shayari.
- Polish / elevate THEIR meaning so the result feels like an improved version of what they wrote.
- Keep their key words, names (पापा, जय जगदम्बे, etc.), and occasion.
- If they already wrote good poetic lines, refine lightly (rhythm, rhyme, clarity) — do not replace with generic AI poetry.
- If their text is rough/plain, rewrite into better Hindi while keeping the same message.

Language: shuddh Hindi (Devanagari). No English. No Hinglish. No emojis. No hashtags unless user included them. No labels like "Caption" or "Shayari".

Style decision:
- "shayari" for birthday, blood donation, tribute, festival, sports win, emotional/khushi/seva moments — OR when user already wrote poetic lines.
- "normal" for simple meeting/visit/notice/routine updates.

When style=shayari:
- Prefer 2 lines only, leader/seva dignity (not romantic filmy love shayari).
- Soft rhyme or parallel rhythm is good, but meaning > forced rhyme.
- Do NOT append a flat third news line (e.g. "पापा के जन्मदिन पर हम सबने मिलकर मनाया उत्सव।").
- Weave occasion into the poetic lines themselves.

When style=normal:
- 1–2 clear dignified Hindi sentences. Same facts as user. No forced poetry.

Keep under 220 characters.`;
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
        temperature: 0.55,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Improve this into ONE WhatsApp caption in Hindi.\n` +
              `Stay close to my words and meaning. Do not invent a different poem.\n` +
              `If it should be shayari, polish my lines; if simple, keep normal Hindi.\n\n` +
              `My text:\n${input}`,
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
