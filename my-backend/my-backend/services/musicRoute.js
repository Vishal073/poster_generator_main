const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const {
  searchMusicLibrary,
} = require("./musicLibraryService");

const router = express.Router();

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") return error;
  return "Unknown error";
}

/**
 * GET /api/music/library
 * Curated royalty-free tracks (no third-party key required).
 */
router.get("/api/music/library", requireAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 40;
    const result = await searchMusicLibrary({ query: "", limit });
    return res.status(200).json({
      success: true,
      message: `Loaded ${result.tracks.length} track(s).`,
      count: result.tracks.length,
      tracks: result.tracks,
      providers: result.providers,
      warning: result.warning || undefined,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load music library.",
      error: getErrorMessage(error),
    });
  }
});

/**
 * GET /api/music/search?q=&limit=
 * Curated filter + optional Jamendo search when JAMENDO_CLIENT_ID is set.
 */
router.get("/api/music/search", requireAuth, async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Number(req.query.limit) || 40;
    const result = await searchMusicLibrary({ query, limit });

    return res.status(200).json({
      success: true,
      message: query.trim()
        ? `Found ${result.tracks.length} track(s) for “${query.trim()}”.`
        : "Music library loaded.",
      query: query.trim(),
      count: result.tracks.length,
      tracks: result.tracks,
      providers: result.providers,
      warning: result.warning || undefined,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to search music.",
      error: getErrorMessage(error),
    });
  }
});

module.exports = {
  router,
};
