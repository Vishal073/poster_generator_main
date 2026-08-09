const path = require("path");

const REELS_ROOT = path.resolve(__dirname, "..");
const UPLOADS_ROOT = path.resolve(__dirname, "../../uploads/reels");

module.exports = {
  REELS_ROOT,
  UPLOADS_ROOT,
  TEMPLATES_DIR: path.join(REELS_ROOT, "templates"),
  CATEGORIES_DIR: path.join(REELS_ROOT, "categories"),
  IMAGES_DIR: path.join(UPLOADS_ROOT, "images"),
  VIDEOS_DIR: path.join(UPLOADS_ROOT, "videos"),
  MUSIC_DIR: path.join(UPLOADS_ROOT, "music"),
  VOICE_DIR: path.join(UPLOADS_ROOT, "voice"),
  TEMP_DIR: path.join(UPLOADS_ROOT, "temp"),
  MAX_IMAGES: 5,
  MAX_POSTER_IMAGES: 1,
  DEFAULT_TEMPLATE_ID: "cloth-01",
  DEFAULT_CATEGORY_ID: "clothing",
  SLIDER_TEMPLATE_ID: "slider-01",
  SLIDESHOW_CATEGORY_ID: "slideshow",
  CAROUSEL_WIDTH: 1080,
  CAROUSEL_HEIGHT: 1350,
  DEFAULT_FPS: 30,
  FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
  CLOUDINARY_REELS_FOLDER: process.env.CLOUDINARY_REELS_FOLDER || "reels",
  REELS_FONT_DIR: path.join(path.resolve(__dirname, ".."), "assets", "fonts"),
};
