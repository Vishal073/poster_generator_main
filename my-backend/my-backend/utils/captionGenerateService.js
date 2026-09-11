/**
 * OpenAI text-only caption generator.
 * Rough Hinglish life-moment → Hindi shayari (or normal) caption.
 */

const DEFAULT_MODEL = "gpt-4o";

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

/** Remove blank lines before hashtags: body\\n\\n#Tag → body\\n#Tag */
function normalizeCaptionSpacing(caption) {
  return String(caption || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}(?=#)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer real line breaks for couplets; fix one-line comma shayari when needed. */
function normalizeShayariLayout(caption, style) {
  let text = normalizeCaptionSpacing(caption);
  if (style !== "shayari") {
    return text;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const hashLines = lines.filter((line) => line.startsWith("#"));
  const bodyLines = lines.filter((line) => !line.startsWith("#"));

  // If model dumped couplet as one comma-separated line, split into 2 lines.
  if (bodyLines.length === 1 && bodyLines[0].includes(",")) {
    const parts = bodyLines[0]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 2) {
      const second = /[।.!?]$/.test(parts[1]) ? parts[1] : `${parts[1]}।`;
      text = `${parts[0]},\n${second}`;
      if (hashLines.length) {
        text += `\n${hashLines.join(" ")}`;
      }
      return normalizeCaptionSpacing(text);
    }
  }

  return text;
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
- Positive vibe, simple Hindi (Devanagari) for the main caption body.
- Keep user's meaning; improve wording.
- No English/Hinglish in the caption body (except hashtags block).
- No emojis. No labels like "Caption" or "Shayari" in the text.

HASHTAGS (required when relevant)
- Put hashtags on the IMMEDIATE next line after the last caption sentence — NO blank line, NO extra space.
- Format exactly:
  <caption sentence>।
  #Tag1 #Tag2
- Include party tags when mentioned: BJP / भाजपा → #BJP ; Congress → #Congress ; etc.
- Include place/org tags: Fatehabad → #Fatehabad ; company → #Company ; combine when useful → #BJPFatehabad
- Do NOT add generic tags like #Meeting, #Update, #Event.
- Hashtags in Latin script, correct spelling. Only from user's content.
- Prefer short formal closings like "अवसर मिला" (not "अवसर प्राप्त किया").

Gold-standard examples:
Input: "aaj mene jila fatehabad me bjp ki meeting me bhag liya"
"आज जिला फतेहाबाद में आयोजित भारतीय जनता पार्टी की बैठक में शामिल होने का अवसर मिला।
#BJP #Fatehabad #BJPFatehabad"

Input: "aaj company me speech diya"
"आज मैंने कंपनी में भाषण देने का अवसर मिला।
#Company"

WHEN style = "shayari" (birthday, blood donation, tribute, festival, sports win, family, seva, khushi):
- Write ONLY shayari as COMPLETE COUPLETS: exactly 2 lines OR exactly 4 lines.
- Prefer 2 lines. Use 4 lines only if more facts need space.
- NEVER write 3 lines (odd count breaks the couplet feel).
- NEVER put the whole shayari on ONE line with commas. Each poetic line must be its own line separated by \\n.
- Each couplet must rhyme or clearly echo (line1~line2; if 4 lines also line3~line4).
- Simple warm Facebook/WhatsApp Hindi — heartfelt, shareable, not heavy dictionary words.
- Include ALL key facts inside the poetry (name, relation like बेटा/बेटी, occasion).
- Birthday: MUST include the person's name when given. Warm family tone.
- A short birthday wish can be the SECOND line of the couplet, not a plain add-on sentence.
- No plain report sentence after the shayari.
- After the last poetic line, hashtags on the NEXT line (no blank line), e.g. #Birthday #Rajesh

BIRTHDAY shayari — CORRECT (2 lines + hashtags):
Input: "mere bete ka birthday h rajesh ka"
"चाँद सितारे भी आज मुस्कुरा रहे हैं,
बेटे राजेश के जन्मदिन पे खुशियाँ छा रहे हैं।
#Birthday #Rajesh"

Also correct:
"फूलों सी महके ज़िंदगी तुम्हारी,
जन्मदिन मुबारक हो बेटे राजेश हमारे।
#Birthday #Rajesh"

WRONG (do NOT do this):
"तुमसे ही रोशन है जिंदगी हमारी, जन्मदिन मुबारक हो बेटे राजेश प्यारे।"
(Reason: one long comma-line, weak couplet, not 2 separate lines.)

Quality bar for shayari:
- Must feel like a real shareable Facebook shayari, not a robot summary.
- Strong rhyme > forced dua.
- Lines quality > filler words.

WHEN style = "normal" (meeting, visit, notice, detailed update, or non-emotional content):
- Write ONLY normal social-media Hindi (sentences/paragraph).
- No rhyme, no couplets, no "shayari look".
- Use \\n between sentences if helpful.
- Tone: respectful public/leader post — polished but simple.
- Cover all user facts; do not invent slogans or extra events.
- Gold-standard body (hashtags still appended after as above):
  Input: "aaj mene jila fatehabad me bjp ki meeting me bhag liya"
  Correct body: "आज जिला फतेहाबाद में आयोजित भारतीय जनता पार्टी की बैठक में शामिल होने का अवसर मिला।"
  Wrong: flat/chatty wording, incomplete polish, or turning it into shayari.
- Expand short party names naturally when clear (BJP → भारतीय जनता पार्टी) if it fits a formal post.
- Prefer "अवसर मिला" wording for formal opportunity lines.
- Prefer one strong complete sentence when the user gave a short note; add a second sentence only if they gave more points.
- Hashtags must sit on the next line with NO blank line in between.

Under 1200 characters when needed for longer user content.`;
}

/**
 * @param {string} rawText
 * @returns {Promise<{ caption: string, style: 'shayari'|'normal', model: string }>}
 */
async function generateCaption(rawText, options = {}) {
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

  const previousCaption = String(options.previousCaption || "").trim();
  const model = getCaptionModel();
  const timeoutMs = Number(process.env.CAPTION_AI_TIMEOUT_MS || 45000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const userContent =
      `Rewrite my content as ONE Hindi caption.\n` +
      `Pick either shayari OR normal — never mix both.\n` +
      `- Shayari: EXACTLY 2 OR 4 poetic lines with \\n between lines (never one long comma sentence). Prefer 2. Strong rhyme. Include names. Birthday example:\n` +
      `चाँद सितारे भी आज मुस्कुरा रहे हैं,\\nबेटे राजेश के जन्मदिन पे खुशियाँ छा रहे हैं।\\n#Birthday #Rajesh\n` +
      `- Normal: formal simple Hindi social post like Fatehabad BJP "अवसर मिला" style. No shayari.\n` +
      `Hashtags on the NEXT line with NO blank line. Do NOT use #Meeting.\n` +
      (previousCaption
        ? `\nIMPORTANT: Write a DIFFERENT caption than this previous one (new lines/rhyme, keep same facts):\n${previousCaption}\n`
        : "") +
      `\nMy content:\n${input}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: previousCaption ? 0.9 : 0.75,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userContent },
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

    const style =
      String(parsed?.style || "").trim().toLowerCase() === "shayari"
        ? "shayari"
        : "normal";

    const caption = normalizeShayariLayout(
      String(parsed?.caption || "")
        .replace(/\\n/g, "\n")
        .trim(),
      style,
    );
    if (!caption) {
      throw new Error("Caption AI returned an empty caption.");
    }

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
