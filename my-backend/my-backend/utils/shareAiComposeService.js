const sharp = require("sharp");
const { uploadBufferToCloudinary } = require("../services/cloudnaryService");
const {
  callFalModel,
  extractImageUrlFromFalResponse,
  downloadImageBuffer,
  isAiProviderConfigured,
  getFalApiKey,
} = require("./shareAiFalClient");

const MAX_REFERENCE_IMAGES = 5;
const SHARE_AI_FOLDER = process.env.CLOUDINARY_SHARE_AI_FOLDER || "share-ai";

function buildComposePrompt({ name, category }) {
  const businessName = String(name || "Business").trim();
  const businessCategory = String(category || "General").trim();

  return (
    process.env.SHARE_AI_COMPOSE_PROMPT ||
    `Create a single professional promotional banner image for WhatsApp and Facebook.

Business name: ${businessName}
Business category: ${businessCategory}

Use the reference collage for products, branding, colors, and shop style. Design a polished marketing visual that fits this ${businessCategory} business named "${businessName}".

Rules:
- One cohesive promotional image (not a plain photo collage).
- Include "${businessName}" as clear readable text in the design when appropriate.
- Premium retail / campaign look, vibrant and eye-catching.
- No watermarks. No misspelled text.`
  ).trim();
}

function getComposeModelId() {
  return (
    process.env.SHARE_AI_FAL_MODEL ||
    process.env.POSTER_AI_FAL_MODEL_HIGH ||
    "fal-ai/flux-pro/kontext"
  );
}

async function buildReferenceCollage(buffers) {
  if (!buffers.length) {
    throw new Error("At least one reference image is required.");
  }

  if (buffers.length === 1) {
    return sharp(buffers[0]).jpeg({ quality: 90 }).toBuffer();
  }

  const tileSize = 512;
  const cols = buffers.length <= 2 ? buffers.length : 2;
  const rows = Math.ceil(buffers.length / cols);
  const width = cols * tileSize;
  const height = rows * tileSize;

  const composites = await Promise.all(
    buffers.map(async (buffer, index) => {
      const resized = await sharp(buffer)
        .resize(tileSize, tileSize, { fit: "cover" })
        .toBuffer();
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        input: resized,
        left: col * tileSize,
        top: row * tileSize,
      };
    })
  );

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function composeShareImageWithAi({ referenceBuffers, name, category }) {
  if (!isAiProviderConfigured()) {
    throw new Error("AI image generation is not configured. Set FAL_KEY on the server.");
  }

  if (!referenceBuffers.length) {
    throw new Error("At least one reference image is required.");
  }

  if (referenceBuffers.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Up to ${MAX_REFERENCE_IMAGES} reference images are allowed.`);
  }

  const collageBuffer = await buildReferenceCollage(referenceBuffers);
  const collageUpload = await uploadBufferToCloudinary(
    collageBuffer,
    `share-ai-ref-${Date.now()}.jpg`,
    { folder: SHARE_AI_FOLDER }
  );

  const modelId = getComposeModelId();
  const payload = await callFalModel(modelId, {
    prompt: buildComposePrompt({ name, category }),
    image_url: collageUpload.imageUrl,
    output_format: "png",
    num_images: 1,
    resolution_mode: "match_input",
  });

  const generatedUrl = extractImageUrlFromFalResponse(payload);
  const generatedBuffer = await downloadImageBuffer(generatedUrl);

  const finalUpload = await uploadBufferToCloudinary(
    generatedBuffer,
    `share-ai-gen-${Date.now()}.png`,
    { folder: SHARE_AI_FOLDER }
  );

  return {
    buffer: generatedBuffer,
    imageUrl: finalUpload.imageUrl,
    cloudinaryPublicId: finalUpload.publicId,
    referenceCollageUrl: collageUpload.imageUrl,
    model: modelId,
    provider: "fal",
    referenceCount: referenceBuffers.length,
  };
}

module.exports = {
  MAX_REFERENCE_IMAGES,
  buildComposePrompt,
  composeShareImageWithAi,
  isAiProviderConfigured,
  getFalApiKey,
};
