const POSTER_SIZE = 1080;

async function preparePosterUploadBuffer(buffer) {
  const sharp = require("sharp");
  const metadata = await sharp(buffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read poster image dimensions.");
  }

  const { width, height } = metadata;

  if (width !== height) {
    throw new Error(
      `Poster must be square ${POSTER_SIZE}x${POSTER_SIZE}. Uploaded image is ${width}x${height}.`
    );
  }

  if (width === POSTER_SIZE && height === POSTER_SIZE) {
    return sharp(buffer).png().toBuffer();
  }

  return sharp(buffer)
    .resize(POSTER_SIZE, POSTER_SIZE, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();
}

module.exports = {
  POSTER_SIZE,
  preparePosterUploadBuffer,
};
