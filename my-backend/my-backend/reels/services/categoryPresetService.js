const fs = require("fs/promises");
const path = require("path");
const {
  CATEGORIES_DIR,
  DEFAULT_CATEGORY_ID,
} = require("../config/constants");

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeCategory(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Category preset must be an object.");
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new Error("Category preset id is required.");
  }

  const animationPool = normalizeStringArray(raw.animationPool);
  const transitionPool = normalizeStringArray(raw.transitionPool);
  if (!animationPool.length || !transitionPool.length) {
    throw new Error(`Category preset "${id}" must define animation and transition pools.`);
  }

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : "",
    animationPool,
    transitionPool,
    musicPool: normalizeStringArray(raw.musicPool),
    voicePool: normalizeStringArray(raw.voicePool),
    rules:
      raw.rules && typeof raw.rules === "object"
        ? {
            pace:
              typeof raw.rules.pace === "string" && raw.rules.pace.trim()
                ? raw.rules.pace.trim()
                : "medium",
            maxAggressiveTransitions:
              Number.isFinite(Number(raw.rules.maxAggressiveTransitions))
                ? Math.max(0, Number(raw.rules.maxAggressiveTransitions))
                : 1,
            avoidBackToBackSameAnimation: raw.rules.avoidBackToBackSameAnimation !== false,
          }
        : {
            pace: "medium",
            maxAggressiveTransitions: 1,
            avoidBackToBackSameAnimation: true,
          },
  };
}

async function getCategoryPreset(categoryId) {
  const resolvedId =
    typeof categoryId === "string" && categoryId.trim()
      ? categoryId.trim()
      : DEFAULT_CATEGORY_ID;
  const filePath = path.join(CATEGORIES_DIR, `${resolvedId}.json`);

  try {
    const text = await fs.readFile(filePath, "utf8");
    return normalizeCategory(JSON.parse(text));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const notFound = new Error(`Category preset "${resolvedId}" was not found.`);
      notFound.statusCode = 404;
      throw notFound;
    }
    throw error;
  }
}

async function listCategoryPresets() {
  const entries = await fs.readdir(CATEGORIES_DIR, { withFileTypes: true });
  const categories = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const text = await fs.readFile(path.join(CATEGORIES_DIR, entry.name), "utf8");
    const category = normalizeCategory(JSON.parse(text));
    categories.push({
      id: category.id,
      name: category.name,
      description: category.description,
      animationPool: category.animationPool,
      transitionPool: category.transitionPool,
      musicPool: category.musicPool,
      voicePool: category.voicePool,
      rules: category.rules,
    });
  }

  return categories.sort((left, right) => left.name.localeCompare(right.name));
}

module.exports = {
  getCategoryPreset,
  listCategoryPresets,
  normalizeCategory,
};
