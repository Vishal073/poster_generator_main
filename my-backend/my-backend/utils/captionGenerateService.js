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
  return `You turn a rough WhatsApp-style Hinglish life moment into a share-ready Hindi caption.

Return ONLY valid JSON:
{
  "style": "shayari" | "normal",
  "caption": "..."
}

INPUT
The user gives 1–2 rough lines (Hinglish / broken Hindi), e.g.
"Aaj papa ka birthday h hmne cake cut kr k celebrate kiya"

STEP 1 — Understand facts (do not invent new events)
Extract and keep: who, occasion, what happened.
Examples of facts to preserve: papa, birthday, cake cut, celebrate, blood camp, school win, etc.
Do not add people, places, or events the user did not mention.

STEP 2 — Choose style
- "shayari": birthday, blood donation, tribute, festival, sports win, family love, seva, emotional/khushi moments.
- "normal": plain meeting, visit, notice, routine update with little emotion.

STEP 3 — Write the caption
Language: shuddh emotional Hindi (Devanagari only).
No English, no Hinglish, no emojis, no hashtags (unless user included them).
No labels like "Caption" or "Shayari" inside the text.
Do NOT copy the user's rough wording — elevate fully.

If style = "shayari":
- Write 4 to 6 lines of beautiful Hindi shayari.
- Natural rhyme / rhythm (not forced or childish).
- Warm, dignified tone (family / seva / public post — not romantic filmy love shayari).
- Weave the real facts into the poetry (who + occasion + what happened).
- Last 1–2 lines must be a blessing or good wishes suited to the occasion
  (birthday → long life/happiness; blood donation → life/seva blessing; win → shubhkamnayein, etc.).
- Separate lines with \\n.

If style = "normal":
- 1–2 clear, polished Hindi sentences with the same facts. No forced poetry.

Keep the full caption under 500 characters.`;
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
              `I will give you a moment from my life written in rough Hinglish — just 1-2 lines, the way people type on WhatsApp.\n\n` +
              `Your job:\n` +
              `1) Understand all the facts from my line (who, what occasion, what happened)\n` +
              `2) Without changing those facts, write a beautiful Hindi shayari — 4 to 6 lines (if the moment deserves shayari; otherwise polished normal Hindi)\n` +
              `3) Elevate the language — pure, emotional Hindi; do not copy my rough wording\n` +
              `4) The rhyme should feel natural, not forced\n` +
              `5) End with a blessing or good wishes suited to the occasion\n\n` +
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
