function envVoiceId(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const VOICE_MAP = {
  female_hindi_energetic: envVoiceId("ELEVENLABS_VOICE_FEMALE_HINDI_ENERGETIC"),
  male_hinglish_offer: envVoiceId("ELEVENLABS_VOICE_MALE_HINGLISH_OFFER"),
  female_hindi_premium: envVoiceId("ELEVENLABS_VOICE_FEMALE_HINDI_PREMIUM"),
  male_hindi_premium: envVoiceId("ELEVENLABS_VOICE_MALE_HINDI_PREMIUM"),
  female_hinglish_fast: envVoiceId("ELEVENLABS_VOICE_FEMALE_HINGLISH_FAST"),
  male_hindi_offer: envVoiceId("ELEVENLABS_VOICE_MALE_HINDI_OFFER"),
  female_hindi_neutral: envVoiceId("ELEVENLABS_VOICE_FEMALE_HINDI_NEUTRAL"),
  male_hindi_informative: envVoiceId("ELEVENLABS_VOICE_MALE_HINDI_INFORMATIVE"),
};

function isElevenLabsVoiceId(value) {
  return /^[A-Za-z0-9]{15,}$/.test(String(value || "").trim());
}

function resolveElevenLabsVoiceId(voiceKey, overrideVoiceId) {
  const directOverride =
    typeof overrideVoiceId === "string" ? overrideVoiceId.trim() : "";
  if (isElevenLabsVoiceId(directOverride)) {
    return directOverride;
  }

  const normalizedKey = String(voiceKey || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  if (isElevenLabsVoiceId(normalizedKey)) {
    return normalizedKey;
  }

  const mapped = VOICE_MAP[normalizedKey];
  if (mapped) {
    return mapped;
  }

  const fallback = envVoiceId("ELEVENLABS_DEFAULT_VOICE_ID");
  if (fallback) {
    return fallback;
  }

  return null;
}

module.exports = {
  resolveElevenLabsVoiceId,
  isElevenLabsVoiceId,
};
