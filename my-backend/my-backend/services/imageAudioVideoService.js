const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { uploadVideoBufferToCloudinary } = require("./cloudnaryService");

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
/** Short clip — enough for promo posts, avoids request timeouts. */
const MAX_AUDIO_DURATION_SECONDS = Number(process.env.POSTER_AUDIO_SECONDS) || 8;
const FFMPEG_TIMEOUT_MS = Number(process.env.POSTER_AUDIO_FFMPEG_TIMEOUT_MS) || 30000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.POSTER_AUDIO_DOWNLOAD_TIMEOUT_MS) || 25000;
const MAX_DOWNLOAD_BYTES = Number(process.env.POSTER_AUDIO_MAX_BYTES) || 2 * 1024 * 1024;
const OUTPUT_WIDTH = Number(process.env.POSTER_AUDIO_WIDTH) || 720;
const OUTPUT_HEIGHT = Number(process.env.POSTER_AUDIO_HEIGHT) || 1280;

let ffmpegReadyPromise = null;

function getExtension(fileName, fallback) {
  const match = String(fileName || "").match(/\.[^.]+$/);
  return match ? match[0].toLowerCase() : fallback;
}

function runFfmpeg(args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `FFmpeg timed out after ${Math.round(timeoutMs / 1000)}s while attaching song.`,
        ),
      );
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && error.code === "ENOENT") {
        reject(
          new Error(
            "FFmpeg is not installed on the server. Install ffmpeg or set FFMPEG_PATH.",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(undefined);
        return;
      }
      const detail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new Error(detail || `FFmpeg exited with code ${code}.`));
    });
  });
}

async function assertFfmpegAvailable() {
  if (!ffmpegReadyPromise) {
    ffmpegReadyPromise = runFfmpeg(["-version"], 8000).catch((error) => {
      ffmpegReadyPromise = null;
      const message =
        error instanceof Error ? error.message : "FFmpeg is not available.";
      const wrapped = new Error(message);
      wrapped.statusCode = 503;
      throw wrapped;
    });
  }
  await ffmpegReadyPromise;
}

function resolveDurationSeconds() {
  return Math.max(5, Math.min(MAX_AUDIO_DURATION_SECONDS, 15));
}

/**
 * Trim/normalize audio once (used by bulk so every user reuses a small clip).
 */
async function prepareAudioBuffer(audioBuffer, audioFileName = "audio.mp3") {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("Audio buffer is required to attach audio.");
  }

  await assertFfmpegAvailable();

  const duration = resolveDurationSeconds();
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "poster-audio-prep-"));
  const inputPath = path.join(
    jobDir,
    `in${getExtension(audioFileName, ".mp3")}`,
  );
  const outputPath = path.join(jobDir, "prepared.m4a");

  try {
    await fs.writeFile(inputPath, audioBuffer);
    await runFfmpeg(
      [
        "-y",
        "-i",
        inputPath,
        "-t",
        String(duration),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "2",
        "-ar",
        "44100",
        outputPath,
      ],
      20000,
    );
    const prepared = await fs.readFile(outputPath);
    if (!prepared.length) {
      throw new Error("Failed to prepare audio clip.");
    }
    return {
      buffer: prepared,
      fileName: "prepared.m4a",
      durationSeconds: duration,
    };
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fast still-image + audio encode (single pass, low fps, 720p).
 */
async function createStillImageVideoBuffer({
  imageBuffer,
  audioBuffer,
  imageFileName,
  audioFileName,
  audioAlreadyPrepared = false,
}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw new Error("Image buffer is required to attach audio.");
  }
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("Audio buffer is required to attach audio.");
  }

  await assertFfmpegAvailable();

  const duration = resolveDurationSeconds();
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "poster-audio-"));
  const imagePath = path.join(
    jobDir,
    `image${getExtension(imageFileName, ".jpg")}`,
  );
  const framePath = path.join(jobDir, "frame.png");
  const audioPath = path.join(
    jobDir,
    `audio${getExtension(audioFileName, audioAlreadyPrepared ? ".m4a" : ".mp3")}`,
  );
  const outputPath = path.join(jobDir, "with-audio.mp4");

  try {
    await fs.writeFile(imagePath, imageBuffer);
    await fs.writeFile(audioPath, audioBuffer);

    // Normalize poster to one even-sized frame first.
    // Avoids rare FFmpeg hangs on odd PNG/WebP sources with -loop.
    try {
      await runFfmpeg(
        [
          "-y",
          "-i",
          imagePath,
          "-vf",
          `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
          "-frames:v",
          "1",
          framePath,
        ],
        15000,
      );
    } catch {
      // Fallback: still usable for normal poster JPEGs from our generator.
      await fs.copyFile(imagePath, framePath);
    }

    const audioCodecArgs = audioAlreadyPrepared
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "44100"];

    await runFfmpeg(
      [
        "-y",
        "-loop",
        "1",
        "-i",
        framePath,
        "-i",
        audioPath,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "stillimage",
        ...audioCodecArgs,
        "-pix_fmt",
        "yuv420p",
        "-vf",
        `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-t",
        String(duration),
        "-shortest",
        "-movflags",
        "+faststart",
        "-threads",
        "0",
        outputPath,
      ],
      FFMPEG_TIMEOUT_MS,
    );

    const stats = await fs.stat(outputPath);
    if (!stats.isFile() || stats.size <= 0) {
      throw new Error("FFmpeg did not produce a valid video with audio.");
    }

    return fs.readFile(outputPath);
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function uploadImageWithAudioVideo({
  imageBuffer,
  audioBuffer,
  imageFileName,
  audioFileName,
  folder,
  publicFileName,
  audioAlreadyPrepared = false,
}) {
  const videoBuffer = await createStillImageVideoBuffer({
    imageBuffer,
    audioBuffer,
    imageFileName,
    audioFileName,
    audioAlreadyPrepared,
  });

  const upload = await uploadVideoBufferToCloudinary(
    videoBuffer,
    publicFileName || `poster-audio-${Date.now()}.mp4`,
    {
      folder:
        folder ||
        process.env.CLOUDINARY_POSTER_AUDIO_FOLDER ||
        "poster-with-audio",
    },
  );

  return {
    videoUrl: upload.videoUrl,
    publicId: upload.publicId,
    videoBuffer,
  };
}

async function downloadAudioFromUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    throw new Error("audioUrl is required.");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("audioUrl must be a valid http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("audioUrl must use http or https.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(trimmed, {
      headers: {
        Accept: "audio/*,*/*",
        "User-Agent": "GCRGraphixPosterAudio/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(
        `Audio download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s. Try another song or upload a short MP3.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Could not download audio (${response.status}).`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const reader =
    response.body && response.body.getReader ? response.body.getReader() : null;
  let buffer;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        try {
          reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(Buffer.from(value));
    }
    buffer = Buffer.concat(chunks, Math.min(total, MAX_DOWNLOAD_BYTES));
  } else {
    const full = Buffer.from(await response.arrayBuffer());
    buffer =
      full.length > MAX_DOWNLOAD_BYTES
        ? full.subarray(0, MAX_DOWNLOAD_BYTES)
        : full;
  }

  if (!buffer.length) {
    throw new Error("Downloaded audio file is empty.");
  }

  const head = buffer.subarray(0, 64).toString("utf8").toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) {
    throw new Error("Audio URL returned a web page instead of an audio file.");
  }

  const finalUrl = response.url || trimmed;
  let finalPath = parsed.pathname;
  try {
    finalPath = new URL(finalUrl).pathname;
  } catch {
    // keep
  }
  const extMatch = finalPath.match(/\.(mp3|wav|m4a|aac|ogg|mpeg)(\?|$)/i);
  const fileName = `remote-audio${extMatch ? `.${extMatch[1].toLowerCase()}` : ".mp3"}`;

  return {
    buffer,
    fileName,
    contentType,
  };
}

function isAudioUpload(file) {
  if (!file) return false;
  if (file.mimetype && file.mimetype.startsWith("audio/")) return true;
  return /\.(mp3|wav|m4a|aac|ogg|mpeg)$/i.test(file.originalname || "");
}

module.exports = {
  createStillImageVideoBuffer,
  prepareAudioBuffer,
  uploadImageWithAudioVideo,
  downloadAudioFromUrl,
  isAudioUpload,
  assertFfmpegAvailable,
};
