const fs = require("fs/promises");
const path = require("path");
const { MUSIC_DIR } = require("../config/constants");

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

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

async function downloadMusicToPath(url, destinationPath) {
  if (typeof fetch !== "function") {
    throw new Error("Music download requires Node.js fetch support.");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "audio/*,*/*",
      "User-Agent":
        process.env.IMAGE_FETCH_USER_AGENT ||
        "Mozilla/5.0 (compatible; GCRGraphixReels/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(`Could not download music (${response.status}): ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer);
  return destinationPath;
}

async function resolveLocalMusicPath(musicId) {
  const baseName = String(musicId || "").trim();
  if (!baseName) {
    return null;
  }

  const candidates = [".mp3", ".m4a", ".wav", ".aac"].map((ext) =>
    path.join(MUSIC_DIR, `${baseName}${ext}`),
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

async function resolveMusicPath({ jobDir, musicRef }) {
  const ref = typeof musicRef === "string" ? musicRef.trim() : "";
  if (!ref) {
    return null;
  }

  if (isHttpUrl(ref)) {
    const destinationPath = path.join(
      jobDir,
      `music${getExtensionFromUrl(ref)}`,
    );
    await downloadMusicToPath(ref, destinationPath);
    return destinationPath;
  }

  const localPath = await resolveLocalMusicPath(ref);
  if (localPath) {
    return localPath;
  }

  throw new Error(`Music asset "${ref}" was not found locally or as a URL.`);
}

module.exports = {
  resolveMusicPath,
  isHttpUrl,
  downloadMusicToPath,
};
