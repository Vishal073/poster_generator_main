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

module.exports = cloudinary;
module.exports.uploadBufferToCloudinary = uploadBufferToCloudinary;
module.exports.uploadPosterToCloudinary = uploadPosterToCloudinary;
