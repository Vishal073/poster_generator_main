const { v2: cloudinary } = require("cloudinary");

function configureCloudinary() {
  if (process.env.CLOUDINARY_URL) {
    return;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY || process.env.API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET || process.env.API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary configuration is missing. Set CLOUDINARY_CLOUD_NAME/CLOUD_NAME, CLOUDINARY_API_KEY/API_KEY, and CLOUDINARY_API_SECRET/API_SECRET."
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

function uploadPosterToCloudinary(buffer, fileName) {
  if (!buffer) {
    throw new Error("Poster buffer is required for Cloudinary upload.");
  }

  configureCloudinary();

  const publicId = String(fileName || `poster-${Date.now()}`).replace(/\.[^.]+$/, "");

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: process.env.CLOUDINARY_POSTER_FOLDER || "generated-posters",
        public_id: publicId,
        resource_type: "image",
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          imageUrl: result.secure_url,
          imageName: fileName,
          publicId: result.public_id,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

module.exports = {
  uploadPosterToCloudinary,
};
