const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { FFMPEG_PATH } = require("../config/constants");

function buildScaleCrop(width, height) {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

function normalizeAnimation(animation) {
  return String(animation || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function resolveTransitionName(transition, index) {
  const normalized = String(transition || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  switch (normalized) {
    case "cross_dissolve":
      return "dissolve";
    case "slide_left":
      return "slideleft";
    case "slide_right":
      return "slideright";
    case "push":
      return index % 2 === 0 ? "smoothleft" : "smoothright";
    case "blur":
      return "fadeblack";
    case "fade":
    default:
      return "fade";
  }
}

function buildZoomPanFilter(animation, frames, width, height, fps) {
  const scaleCrop = buildScaleCrop(width, height);
  const common = `:s=${width}x${height}:fps=${fps},format=yuv420p`;
  const normalized = normalizeAnimation(animation);

  switch (normalized) {
    case "zoom_in":
      return `${scaleCrop},zoompan=z='min(zoom+0.0025,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}${common}`;
    case "zoom_out":
      return `${scaleCrop},zoompan=z='if(lte(on,1),1.25,max(1.001,zoom-0.002))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}${common}`;
    case "pan_left":
      return `${scaleCrop},zoompan=z='1.08':x='max(0,iw/18-on*(iw/9/${frames}))':y='ih/2-(ih/zoom/2)':d=${frames}${common}`;
    case "pan_right":
      return `${scaleCrop},zoompan=z='1.08':x='min(iw/9,on*(iw/9/${frames}))':y='ih/2-(ih/zoom/2)':d=${frames}${common}`;
    case "slide_up":
      return `${scaleCrop},zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='max(0,ih/18-on*(ih/9/${frames}))':d=${frames}${common}`;
    case "slide_down":
      return `${scaleCrop},zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='min(ih/9,on*(ih/9/${frames}))':d=${frames}${common}`;
    case "ken_burns":
      return `${scaleCrop},zoompan=z='min(zoom+0.0018,1.18)':x='min(iw/10,on*(iw/20/${frames}))':y='min(ih/12,on*(ih/18/${frames}))':d=${frames}${common}`;
    case "fade":
    case "crossfade":
    case "static":
    default:
      return `${scaleCrop},zoompan=z='1':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}${common}`;
  }
}

function getClipDuration(segment, transitionDuration, index, segmentCount) {
  if (segmentCount <= 1) {
    return segment.duration;
  }

  if (index === 0 || index === segmentCount - 1) {
    return segment.duration + transitionDuration / 2;
  }

  return segment.duration + transitionDuration;
}

function buildFilterComplex(template, imageCount) {
  const { width, height, fps, transitionDuration } = template;
  const segments = template.segments.slice(0, imageCount);
  const filters = [];
  const clipDurations = segments.map((segment, index) =>
    getClipDuration(segment, transitionDuration, index, segments.length),
  );

  segments.forEach((segment, index) => {
    filters.push(
      `[${index}:v]${buildZoomPanFilter(
        segment.animation,
        segment.frames,
        width,
        height,
        fps,
      )}[v${index}]`,
    );
  });

  if (segments.length === 1) {
    filters.push("[v0]copy[outv]");
    return {
      filterComplex: filters.join(";"),
      clipDurations,
    };
  }

  let previousLabel = "v0";
  let offset = clipDurations[0] - transitionDuration;

  for (let index = 1; index < segments.length; index += 1) {
    const outputLabel = index === segments.length - 1 ? "outv" : `vx${index - 1}`;
    const transition = resolveTransitionName(
      segments[index - 1]?.transition || "fade",
      index,
    );
    filters.push(
      `[${previousLabel}][v${index}]xfade=transition=${transition}:duration=${transitionDuration}:offset=${Math.max(
        0,
        offset,
      ).toFixed(3)}[${outputLabel}]`,
    );
    previousLabel = outputLabel;
    offset += clipDurations[index] - transitionDuration;
  }

  return {
    filterComplex: filters.join(";"),
    clipDurations,
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
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
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}.`));
    });
  });
}

async function assertFfmpegAvailable() {
  try {
    await runFfmpeg(["-version"]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "FFmpeg is not available.";
    const wrapped = new Error(message);
    wrapped.statusCode = 503;
    throw wrapped;
  }
}

async function mixAudioIntoVideo({
  videoPath,
  musicPath,
  voicePath,
  outputPath,
  duration,
  musicVolume = 0.35,
  voiceVolume = 1,
}) {
  if (!musicPath && !voicePath) {
    throw new Error("At least one audio track is required to mix audio.");
  }

  const targetDuration = Number(duration);
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new Error("A positive duration is required to mix audio.");
  }

  const args = ["-y", "-i", videoPath];
  const filterParts = [];
  const mixInputs = [];
  let inputIndex = 1;

  if (musicPath) {
    const volume = Math.min(Math.max(Number(musicVolume) || 0.35, 0.05), 1.5);
    args.push("-stream_loop", "-1", "-i", musicPath);
    filterParts.push(
      `[${inputIndex}:a]atrim=0:${targetDuration},asetpts=PTS-STARTPTS,volume=${volume}[music]`,
    );
    mixInputs.push("[music]");
    inputIndex += 1;
  }

  if (voicePath) {
    const volume = Math.min(Math.max(Number(voiceVolume) || 1, 0.1), 2);
    args.push("-i", voicePath);
    filterParts.push(
      `[${inputIndex}:a]atrim=0:${targetDuration},asetpts=PTS-STARTPTS,volume=${volume}[voice]`,
    );
    mixInputs.push("[voice]");
    inputIndex += 1;
  }

  if (mixInputs.length === 1) {
    filterParts.push(`${mixInputs[0]}anull[aout]`);
  } else {
    filterParts.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0[aout]`,
    );
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-t",
    String(targetDuration),
    outputPath,
  );

  await runFfmpeg(args);

  const stats = await fs.stat(outputPath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error("FFmpeg did not produce a valid MP4 with audio.");
  }

  return {
    outputPath,
    bytes: stats.size,
    duration: targetDuration,
  };
}

async function applyTextOverlayToVideo({
  videoPath,
  overlayFramePattern,
  overlayFps,
  outputPath,
  duration,
}) {
  const targetDuration = Number(duration);
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new Error("A positive duration is required for text overlays.");
  }

  const fps = Math.max(1, Number(overlayFps) || 30);
  const filter = `[0:v][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p`;
  const args = [
    "-y",
    "-i",
    videoPath,
    "-framerate",
    String(fps),
    "-i",
    overlayFramePattern,
    "-filter_complex",
    filter,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    String(targetDuration),
    outputPath,
  ];

  await runFfmpeg(args);

  const stats = await fs.stat(outputPath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error("FFmpeg did not produce a valid MP4 with text overlays.");
  }

  return {
    outputPath,
    bytes: stats.size,
    duration: targetDuration,
  };
}

async function mixMusicIntoVideo(options) {
  return mixAudioIntoVideo(options);
}

async function renderReelVideo({ template, imagePaths, outputPath }) {
  if (!Array.isArray(imagePaths) || !imagePaths.length) {
    throw new Error("At least one image path is required for rendering.");
  }

  const imageCount = Math.min(imagePaths.length, template.segments.length);
  const { filterComplex, clipDurations } = buildFilterComplex(template, imageCount);
  const args = ["-y"];

  for (let index = 0; index < imageCount; index += 1) {
    args.push("-loop", "1", "-t", String(clipDurations[index]), "-i", imagePaths[index]);
  }

  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    String(template.duration),
    outputPath,
  );

  await runFfmpeg(args);

  const stats = await fs.stat(outputPath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error("FFmpeg did not produce a valid MP4 file.");
  }

  return {
    outputPath,
    bytes: stats.size,
    duration: template.duration,
  };
}

module.exports = {
  assertFfmpegAvailable,
  renderReelVideo,
  mixMusicIntoVideo,
  mixAudioIntoVideo,
  applyTextOverlayToVideo,
  buildFilterComplex,
};
