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
  return `You write ONE WhatsApp/Facebook caption for Indian public / family social posts.

Return ONLY valid JSON:
{
  "style": "shayari" | "normal",
  "caption": "..."
}

User input is usually ROUGH simple text (Hinglish / broken Hindi / short note), e.g.
"Aaj papa ka birthday h hmne cake cut kr k celebrate kiya"

Your job:
- Turn that rough note into a beautiful, share-ready Hindi caption.
- Keep the same facts: who, what happened (papa, birthday, cake cut, celebrate, blood camp, etc.).
- Output must be shuddh Hindi (Devanagari). No English. No Hinglish. No emojis. No hashtags unless user included them.
- Do NOT output the rough note almost unchanged. Elevate the language a lot.
- No labels like "Caption" or "Shayari" in the text.

Style:
- "shayari" for birthday, blood donation, tribute, festival, sports win, emotional/khushi/seva moments.
- "normal" for plain meeting/visit/notice.

When style=shayari:
- Write 2 strong poetic Hindi lines (leader/family dignity — not romantic filmy love shayari).
- Soft rhyme or parallel rhythm.
- Facts woven into the poetry (birthday / cake / papa / camp) — NO flat third news line.
- Quality bar: should feel like a good Facebook birthday/seva post people want to share.

When style=normal:
- 1–2 clear, dignified Hindi sentences with the same facts. Polished, not poetic.

Under 220 characters.

Example direction (do not copy verbatim; invent fresh lines for the user's facts):
Input: "Aaj papa ka birthday h hmne cake cut kr k celebrate kiya"
Good shayari-style idea: affection for father + birthday blessing + celebration, in 2 poetic lines.`;
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
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Rough note (may be Hinglish/simple). Create ONE beautiful Hindi caption.\n` +
              `Keep the same facts. For birthday/seva/khushi use shayari (2 poetic lines).\n\n` +
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
