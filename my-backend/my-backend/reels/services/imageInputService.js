const fs = require("fs/promises");
const path = require("path");
const { MAX_IMAGES } = require("../config/constants");

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function getExtensionFromMime(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  return ".jpg";
}

function getExtensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname);
    if (/^\.(jpe?g|png|webp|gif)$/i.test(ext)) {
      return ext.toLowerCase();
    }
  } catch {
    // Ignore invalid URLs here — validated elsewhere.
  }
  return ".jpg";
}

async function downloadImageToPath(url, destinationPath) {
  if (typeof fetch !== "function") {
    throw new Error("Image download requires Node.js fetch support.");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "User-Agent":
        process.env.IMAGE_FETCH_USER_AGENT ||
        "Mozilla/5.0 (compatible; GCRGraphixReels/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(`Could not download image (${response.status}): ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer);
  return destinationPath;
}

async function saveUploadedImage(file, destinationPath) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new Error("Uploaded image buffer is missing.");
  }

  await fs.writeFile(destinationPath, file.buffer);
  return destinationPath;
}

async function resolvePosterPath({ jobDir, posterUrl, posterFile }) {
  const url = typeof posterUrl === "string" ? posterUrl.trim() : "";
  const hasUpload = posterFile && Buffer.isBuffer(posterFile.buffer);

  if (!url && !hasUpload) {
    return null;
  }

  let extension = ".jpg";
  if (hasUpload) {
    extension = getExtensionFromMime(posterFile.mimetype);
  } else if (isHttpUrl(url)) {
    extension = getExtensionFromUrl(url);
  } else {
    const error = new Error("Poster must be a valid http(s) URL or uploaded image.");
    error.statusCode = 400;
    throw error;
  }

  const destinationPath = path.join(jobDir, `poster${extension}`);

  if (hasUpload) {
    await saveUploadedImage(posterFile, destinationPath);
  } else {
    await downloadImageToPath(url, destinationPath);
  }

  return destinationPath;
}

async function resolveImagePaths({
  jobDir,
  imageUrls = [],
  uploadedFiles = [],
  posterUrl,
  posterFile,
}) {
  const sources = [];

  if (uploadedFiles.length) {
    sources.push(
      ...uploadedFiles.map((file) => ({
        type: "upload",
        file,
      })),
    );
  } else {
    sources.push(
      ...imageUrls.map((url) => ({
        type: "url",
        url: String(url).trim(),
      })),
    );
  }

  if (!sources.length) {
    const error = new Error("At least one image is required.");
    error.statusCode = 400;
    throw error;
  }

  if (sources.length > MAX_IMAGES) {
    const error = new Error(`A maximum of ${MAX_IMAGES} product images is allowed.`);
    error.statusCode = 400;
    throw error;
  }

  const resolvedPaths = [];

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    let extension = ".jpg";

    if (source.type === "upload") {
      extension = getExtensionFromMime(source.file.mimetype);
    } else if (source.type === "url") {
      if (!isHttpUrl(source.url)) {
        const error = new Error(`Image ${index + 1} must be a valid http(s) URL.`);
        error.statusCode = 400;
        throw error;
      }
      extension = getExtensionFromUrl(source.url);
    }

    const destinationPath = path.join(jobDir, `image-${index + 1}${extension}`);

    if (source.type === "upload") {
      await saveUploadedImage(source.file, destinationPath);
    } else {
      await downloadImageToPath(source.url, destinationPath);
    }

    resolvedPaths.push(destinationPath);
  }

  const posterPath = await resolvePosterPath({ jobDir, posterUrl, posterFile });
  if (posterPath) {
    resolvedPaths.push(posterPath);
  }

  return resolvedPaths;
}

module.exports = {
  resolveImagePaths,
  resolvePosterPath,
  isHttpUrl,
};
