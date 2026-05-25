const cloudinary = require("cloudinary").v2;
const path = require("path");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

function getPublicIdFromFileName(fileName) {
  return path.parse(String(fileName || "upload")).name;
}

function uploadBufferToCloudinary(buffer, fileName, options = {}) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer)) {
      reject(new Error("Upload buffer is missing or invalid."));
      return;
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || process.env.CLOUDINARY_USER_FOLDER || "user-images",
        public_id: getPublicIdFromFileName(fileName),
        resource_type: "image",
        overwrite: true,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          imageUrl: result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

function uploadPosterToCloudinary(buffer, fileName) {
  return uploadBufferToCloudinary(buffer, fileName, {
    folder: process.env.CLOUDINARY_POSTER_FOLDER || "posters",
  });
}

function getBasePosterFolder() {
  return process.env.CLOUDINARY_BASE_POSTER_FOLDER || "base_posters";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedBasePosterSource(posterSource) {
  const source = String(posterSource || "").trim();
  if (!source) {
    return false;
  }

  const folder = getBasePosterFolder();
  const folderPattern = new RegExp(`/${escapeRegExp(folder)}/`, "i");
  if (folderPattern.test(source)) {
    return true;
  }

  const publicIdPattern = new RegExp(`^${escapeRegExp(folder)}/`, "i");
  return publicIdPattern.test(source);
}

function formatBasePosterResource(resource) {
  return {
    publicId: resource.public_id,
    imageUrl: resource.secure_url,
    width: resource.width,
    height: resource.height,
    format: resource.format,
    createdAt: resource.created_at,
  };
}

async function listBasePostersFromCloudinary(options = {}) {
  const folder = options.folder || getBasePosterFolder();
  const maxResults = Number(options.maxResults) > 0 ? Number(options.maxResults) : 100;
  const posters = [];
  let nextCursor;

  do {
    const response = await cloudinary.api.resources({
      type: "upload",
      prefix: `${folder}/`,
      max_results: Math.min(maxResults - posters.length, 500),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });

    posters.push(...(response.resources || []).map(formatBasePosterResource));
    nextCursor = response.next_cursor;

    if (posters.length >= maxResults) {
      break;
    }
  } while (nextCursor);

  return posters.slice(0, maxResults);
}

module.exports = cloudinary;
module.exports.uploadBufferToCloudinary = uploadBufferToCloudinary;
module.exports.uploadPosterToCloudinary = uploadPosterToCloudinary;
module.exports.getBasePosterFolder = getBasePosterFolder;
module.exports.isAllowedBasePosterSource = isAllowedBasePosterSource;
module.exports.listBasePostersFromCloudinary = listBasePostersFromCloudinary;
