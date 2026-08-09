const fs = require("fs/promises");
const path = require("path");
const { VOICE_DIR } = require("../config/constants");
const { isHttpUrl, downloadMusicToPath } = require("./musicInputService");

function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if ([".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext)) {
      return ext;
    }
  } catch {
    // Ignore invalid URLs here — validated elsewhere.
  }
  return ".mp3";
}

async function resolveLocalVoicePath(voiceRef) {
  const baseName = String(voiceRef || "").trim();
  if (!baseName || isHttpUrl(baseName)) {
    return null;
  }

  const candidates = [".mp3", ".m4a", ".wav", ".aac", ".ogg"].map((ext) =>
    path.join(VOICE_DIR, `${baseName}${ext}`),
  );

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next extension.
    }
  }

  return null;
}

async function resolveVoicePath({ jobDir, voiceRef }) {
  const ref = typeof voiceRef === "string" ? voiceRef.trim() : "";
  if (!ref) {
    return null;
  }

  if (isHttpUrl(ref)) {
    const destinationPath = path.join(
      jobDir,
      `voice${getExtensionFromUrl(ref)}`,
    );
    await downloadMusicToPath(ref, destinationPath);
    return destinationPath;
  }

  const localPath = await resolveLocalVoicePath(ref);
  if (localPath) {
    return localPath;
  }

  return null;
}

async function hasVoiceAsset(voiceRef) {
  const ref = typeof voiceRef === "string" ? voiceRef.trim() : "";
  if (!ref) {
    return false;
  }

  if (isHttpUrl(ref)) {
    return true;
  }

  return Boolean(await resolveLocalVoicePath(ref));
}

async function listLocalVoiceAssets() {
  try {
    const entries = await fs.readdir(VOICE_DIR);
    return entries
      .filter((entry) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(entry))
      .map((entry) => {
        const voiceId = path.basename(entry, path.extname(entry));
        return {
          voiceId,
          fileName: entry,
          source: "file",
        };
      })
      .sort((left, right) => left.voiceId.localeCompare(right.voiceId));
  } catch {
    return [];
  }
}

module.exports = {
  resolveVoicePath,
  hasVoiceAsset,
  resolveLocalVoicePath,
  listLocalVoiceAssets,
};
