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
  return `You write premium WhatsApp/Facebook captions for Indian public leaders (rajneta / social workers).

Return ONLY valid JSON with these exact keys:
{
  "hindi": "...",
  "english": "...",
  "shayari": "..."
}

Language rules:
- hindi: shuddh Hindi (Devanagari only). Dignified, seva-bhav. 2 short lines max.
- english: complete English only. Same dignity. 2 short sentences max.
- shayari: pure Hindi poetic caption in LEADER style (not romantic, not filmy love shayari).
- No Hinglish. No slang. No emojis. No hashtags unless user included them.
- Each caption under 220 characters.

Shayari quality (very important):
- Sound like a respected neta posting after seva / blood camp / public event.
- Prefer 2 poetic lines with a soft rhyme or parallel rhythm, then 1 short factual line (event name / place / seva).
- Use strong seva imagery: जीवनदान, रक्तदान महादान, एक बूँद–नई आशा, सेवा ही धर्म, मानवता.
- Avoid weak/generic filler like "बहुत खुशी हुई", "आज का दिन यादगार", "एक साथ मिलकर".
- Avoid childish rhyme, over-drama, and fake deep lines.
- Keep words simple, memorable, and shareable.

Good shayari examples (style guide only — invent fresh lines for the user note):
- "एक बूँद खून, अनगिनत आशाएँ।\\nरक्तदान — मानवता की सबसे सरल पूजा।\\nजय जगदम्बे ब्लड कैंप में सेवा का सौभाग्य।"
- "जो बाँटे जीवन, वही सच्चा दान।\\nब्लड कैंप में शामिल होकर प्रसन्नता हुई।"
- "सेवा से बड़ा कोई धर्म नहीं।\\nआज रक्तदान शिविर में नमन उन वीरों को जिन्होंने जीवनदान दिया।"

Match the user's occasion exactly (blood donation, birthday, anniversary, inauguration, etc.).`;
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
        temperature: 0.85,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Write 3 captions for this leader's post note.\n` +
              `Make the "shayari" field especially strong, poetic, and share-worthy.\n\n` +
              `Post note:\n${input}`,
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
