const fs = require("fs/promises");
const path = require("path");
const { TEMPLATES_DIR, DEFAULT_TEMPLATE_ID } = require("../config/constants");

function normalizeSegment(segment, index, fps) {
  const duration = Number(segment.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Template segment ${index} has invalid duration.`);
  }

  const animation =
    typeof segment.animation === "string" && segment.animation.trim()
      ? segment.animation.trim()
      : "fade";
  const sceneRole =
    typeof segment.sceneRole === "string" && segment.sceneRole.trim()
      ? segment.sceneRole.trim()
      : index === 0
        ? "hook"
        : "content";

  return {
    index,
    duration,
    animation,
    sceneRole,
    transition: segment.transition || "crossfade",
    frames: Math.max(1, Math.round(duration * fps)),
  };
}

function normalizeTemplate(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Template JSON must be an object.");
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new Error("Template id is required.");
  }

  const width = Number(raw.width) > 0 ? Number(raw.width) : 1080;
  const height = Number(raw.height) > 0 ? Number(raw.height) : 1920;
  const fps = Number(raw.fps) > 0 ? Number(raw.fps) : 30;
  const duration = Number(raw.duration) > 0 ? Number(raw.duration) : 10;
  const transitionDuration =
    Number(raw.transitionDuration) >= 0 ? Number(raw.transitionDuration) : 0.5;

  const segments = Array.isArray(raw.segments) ? raw.segments : [];
  if (!segments.length) {
    throw new Error(`Template "${id}" must define at least one segment.`);
  }

  const normalizedSegments = segments.map((segment, index) =>
    normalizeSegment(segment, index, fps),
  );

  const segmentTotal = normalizedSegments.reduce(
    (sum, segment) => sum + segment.duration,
    0,
  );
  const expectedDuration =
    segmentTotal -
    Math.max(0, normalizedSegments.length - 1) * transitionDuration;

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    duration,
    aspectRatio:
      typeof raw.aspectRatio === "string" && raw.aspectRatio.trim()
        ? raw.aspectRatio.trim()
        : "9:16",
    width,
    height,
    fps,
    transitionDuration,
    supportsMusic: raw.supportsMusic !== false,
    supportsVoice: raw.supportsVoice === true,
    animations: Array.isArray(raw.animations)
      ? raw.animations
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
      : [],
    segments: normalizedSegments,
    expectedDuration,
  };
}

async function listTemplates() {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
  const templates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const template = await loadTemplateByFileName(entry.name);
    templates.push({
      id: template.id,
      name: template.name,
      duration: template.duration,
      aspectRatio: template.aspectRatio,
      segmentCount: template.segments.length,
      animations: template.animations.length
        ? template.animations
        : template.segments.map((segment) => segment.animation),
    });
  }

  return templates.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadTemplateByFileName(fileName) {
  const filePath = path.join(TEMPLATES_DIR, fileName);
  const rawText = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(rawText);
  return normalizeTemplate(parsed);
}

async function getTemplate(templateId) {
  const resolvedId =
    typeof templateId === "string" && templateId.trim()
      ? templateId.trim()
      : DEFAULT_TEMPLATE_ID;

  const directPath = path.join(TEMPLATES_DIR, `${resolvedId}.json`);
  try {
    const rawText = await fs.readFile(directPath, "utf8");
    return normalizeTemplate(JSON.parse(rawText));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const errorMessage = new Error(`Template "${resolvedId}" was not found.`);
      errorMessage.statusCode = 404;
      throw errorMessage;
    }
    throw error;
  }
}

module.exports = {
  getTemplate,
  listTemplates,
  normalizeTemplate,
};
