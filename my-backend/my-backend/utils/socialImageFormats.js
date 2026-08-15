const axios = require("axios");
const { uploadBufferToCloudinary } = require("../services/cloudnaryService");

const IG_STORY_WIDTH = 1080;
const IG_STORY_HEIGHT = 1920;
const CLOUDINARY_UPLOAD_MARKER = "/image/upload/";
const IG_STORY_TRANSFORM =
  `c_pad,w_${IG_STORY_WIDTH},h_${IG_STORY_HEIGHT},b_black,q_auto:good,f_jpg`;

function isCloudinaryImageUrl(imageUrl) {
  return /^https:\/\/res\.cloudinary\.com\/.+\/image\/upload\//i.test(
    String(imageUrl || "").trim(),
  );
}

/**
 * Instagram Stories expect ~9:16 (1080x1920). Square feed posters (1080x1080)
 * get cropped/zoomed if sent as-is — pad onto a 9:16 canvas instead.
 */
function buildInstagramStoryImageUrl(imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!url || !isCloudinaryImageUrl(url)) {
    return url;
  }

  const markerIndex = url.indexOf(CLOUDINARY_UPLOAD_MARKER);
  if (markerIndex === -1) {
    return url;
  }

  const prefix = url.slice(0, markerIndex + CLOUDINARY_UPLOAD_MARKER.length);
  const suffix = url.slice(markerIndex + CLOUDINARY_UPLOAD_MARKER.length);

  if (
    suffix.startsWith(`${IG_STORY_TRANSFORM}/`) ||
    suffix.includes(`/${IG_STORY_TRANSFORM}/`)
  ) {
    return url;
  }

  return `${prefix}${IG_STORY_TRANSFORM}/${suffix}`;
}

async function padImageBufferForInstagramStory(buffer) {
  const sharp = require("sharp");
  return sharp(buffer, { failOn: "none" })
    .rotate()
    .resize(IG_STORY_WIDTH, IG_STORY_HEIGHT, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0 },
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

async function resolveInstagramStoryImageUrl(imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!url) {
    return url;
  }

  if (isCloudinaryImageUrl(url)) {
    return buildInstagramStoryImageUrl(url);
  }

  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxContentLength: 12 * 1024 * 1024,
    });

    const paddedBuffer = await padImageBufferForInstagramStory(
      Buffer.from(response.data),
    );
    const uploaded = await uploadBufferToCloudinary(
      paddedBuffer,
      `ig-story-${Date.now()}.jpg`,
      {
        folder: process.env.CLOUDINARY_POSTER_FOLDER || "posters",
        compress: false,
      },
    );

    return uploaded.imageUrl;
  } catch (error) {
    console.warn(
      "Instagram Story image pad failed, using original URL:",
      error instanceof Error ? error.message : String(error),
    );
    return url;
  }
}

module.exports = {
  IG_STORY_WIDTH,
  IG_STORY_HEIGHT,
  buildInstagramStoryImageUrl,
  resolveInstagramStoryImageUrl,
};
