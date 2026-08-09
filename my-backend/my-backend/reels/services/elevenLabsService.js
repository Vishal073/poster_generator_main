const fs = require("fs/promises");

const ELEVENLABS_API_BASE =
  process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

function getApiKey() {
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error(
      "ELEVENLABS_API_KEY is not configured on the server.",
    );
    error.statusCode = 503;
    throw error;
  }
  return apiKey;
}

function isApiUsableVoice(category) {
  const normalized = String(category || "").trim().toLowerCase();
  return normalized !== "premade";
}

function formatElevenLabsError(status, errorBody) {
  if (status === 402) {
    try {
      const parsed = JSON.parse(errorBody);
      const code = parsed?.detail?.code || parsed?.detail?.type;
      if (code === "paid_plan_required") {
        return (
          "ElevenLabs free plan library voices ko API se use nahi kar sakta. " +
          "Apni custom/cloned voice banao (My Voices) ya paid plan lo, phir us voice ka ID use karo."
        );
      }
    } catch {
      // Fall through to generic message.
    }
    return (
      "ElevenLabs payment/plan error (402). Library voice ki jagah apni custom voice use karo."
    );
  }

  if (status === 401) {
    return "ElevenLabs API key invalid hai. .env me ELEVENLABS_API_KEY check karo.";
  }

  return `ElevenLabs voice generation failed (${status})${
    errorBody ? `: ${errorBody.slice(0, 240)}` : "."
  }`;
}

async function listVoices() {
  if (typeof fetch !== "function") {
    throw new Error("ElevenLabs voice listing requires Node.js fetch support.");
  }

  const response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
    headers: {
      Accept: "application/json",
      "xi-api-key": getApiKey(),
    },
  });

  const errorBody = await response.text().catch(() => "");
  if (!response.ok) {
    const error = new Error(formatElevenLabsError(response.status, errorBody));
    error.statusCode = response.status === 401 ? 401 : 502;
    throw error;
  }

  const payload = JSON.parse(errorBody || "{}");
  const voices = Array.isArray(payload.voices) ? payload.voices : [];

  return voices
    .map((voice) => {
      const voiceId =
        typeof voice.voice_id === "string" ? voice.voice_id.trim() : "";
      const name = typeof voice.name === "string" ? voice.name.trim() : voiceId;
      const category =
        typeof voice.category === "string" ? voice.category.trim() : "unknown";

      if (!voiceId) {
        return null;
      }

      return {
        voiceId,
        name,
        category,
        apiUsable: isApiUsableVoice(category),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.apiUsable !== right.apiUsable) {
        return left.apiUsable ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

async function generateSpeechToFile({
  text,
  voiceId,
  outputPath,
  modelId = DEFAULT_MODEL_ID,
}) {
  const narration = String(text || "").trim();
  if (!narration) {
    throw new Error("Narration text is required for voice generation.");
  }

  const resolvedVoiceId = String(voiceId || "").trim();
  if (!resolvedVoiceId) {
    const error = new Error(
      "ElevenLabs voice id is missing. Set ELEVENLABS_DEFAULT_VOICE_ID or map the selected voice in .env.",
    );
    error.statusCode = 400;
    throw error;
  }

  if (typeof fetch !== "function") {
    throw new Error("ElevenLabs voice generation requires Node.js fetch support.");
  }

  const response = await fetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(resolvedVoiceId)}`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": getApiKey(),
      },
      body: JSON.stringify({
        text: narration,
        model_id: modelId,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const error = new Error(formatElevenLabsError(response.status, errorBody));
    error.statusCode =
      response.status === 401 ? 401 : response.status === 402 ? 402 : 502;
    throw error;
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!audioBuffer.length) {
    throw new Error("ElevenLabs returned an empty audio file.");
  }

  await fs.writeFile(outputPath, audioBuffer);

  return {
    outputPath,
    bytes: audioBuffer.length,
    voiceId: resolvedVoiceId,
    modelId,
  };
}

module.exports = {
  generateSpeechToFile,
  listVoices,
  isApiUsableVoice,
};
