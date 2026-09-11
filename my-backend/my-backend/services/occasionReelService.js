/**
 * Occasion reels: birthday / party / festival only, with fixed music each.
 */

const path = require("path");
const fs = require("fs");
const { generateReel } = require("../reels/services/reelGenerateService");
const { MUSIC_DIR } = require("../reels/config/constants");
const {
  detectOccasion,
  isReelOccasion,
} = require("../utils/occasionDetectService");

const LOCAL_EXTS = [".mp3", ".m4a", ".wav", ".aac"];

/** Royalty-free instrumental placeholders until custom tracks are uploaded. */
const DEFAULT_MUSIC_URLS = {
  birthday:
    process.env.REEL_MUSIC_BIRTHDAY_URL ||
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  party:
    process.env.REEL_MUSIC_PARTY_URL ||
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
  festival:
    process.env.REEL_MUSIC_FESTIVAL_URL ||
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3",
};

function localMusicExists(basename) {
  const id = String(basename || "").trim();
  if (!id) return false;
  return LOCAL_EXTS.some((ext) =>
    fs.existsSync(path.join(MUSIC_DIR, `${id}${ext}`)),
  );
}

/**
 * Prefer local uploads/reels/music/{occasion}.mp3, else env/default URL.
 */
function resolveOccasionMusicRef(occasion) {
  const key = String(occasion || "").trim().toLowerCase();
  if (!isReelOccasion(key)) {
    throw new Error(`Unsupported reel occasion: ${occasion}`);
  }

  const envLocal = String(
    process.env[`REEL_MUSIC_${key.toUpperCase()}`] || "",
  ).trim();
  if (envLocal && !/^https?:\/\//i.test(envLocal) && localMusicExists(envLocal)) {
    return envLocal;
  }
  if (localMusicExists(key)) {
    return key;
  }
  if (envLocal && /^https?:\/\//i.test(envLocal)) {
    return envLocal;
  }

  return DEFAULT_MUSIC_URLS[key];
}

async function generateOccasionReel({ occasion, imageUrls = [] }) {
  const key = String(occasion || "").trim().toLowerCase();
  if (!isReelOccasion(key)) {
    throw new Error("Reel generation is only for birthday, party, or festival.");
  }

  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error("At least one photo is required for an occasion reel.");
  }

  const musicOverride = resolveOccasionMusicRef(key);
  const result = await generateReel({
    templateId: "slider-01",
    categoryId: key,
    imageUrls: urls.slice(0, 5),
    musicOverride,
    enableVoice: false,
  });

  return {
    videoUrl: result.video,
    occasion: key,
    music: musicOverride,
    duration: result.duration,
    jobId: result.jobId,
    publicId: result.publicId,
  };
}

module.exports = {
  detectOccasion,
  isReelOccasion,
  resolveOccasionMusicRef,
  generateOccasionReel,
  DEFAULT_MUSIC_URLS,
};
