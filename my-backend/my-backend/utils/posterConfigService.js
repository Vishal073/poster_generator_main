const crypto = require("crypto");
const EventPoster = require("../models/EventPoster");
const { getDefaultPosterConfig } = require("./defaultPosterConfig");

function generatePosterId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `EP_${stamp}_${random}`;
}

function normalizeImageUrl(imageUrl) {
  return String(imageUrl || "").trim();
}

function normalizePublicId(publicId) {
  return String(publicId || "").trim();
}

function extractPublicIdFromPosterSource(posterSource) {
  const source = String(posterSource || "").trim();
  if (!source) {
    return "";
  }

  if (!source.startsWith("http://") && !source.startsWith("https://")) {
    return source;
  }

  try {
    const pathname = decodeURIComponent(new URL(source).pathname);
    const uploadMarker = "/upload/";
    const markerIndex = pathname.indexOf(uploadMarker);
    if (markerIndex === -1) {
      return "";
    }

    const afterUpload = pathname.slice(markerIndex + uploadMarker.length);
    const segments = afterUpload.split("/").filter(Boolean);
    if (segments.length === 0) {
      return "";
    }

    // Cloudinary URLs may include version (v123...) and transformation segments.
    const publicIdSegments = segments.filter(
      (segment) => !/^v\d+$/.test(segment) && !segment.includes(","),
    );

    if (publicIdSegments.length === 0) {
      return "";
    }

    const lastSegment = publicIdSegments[publicIdSegments.length - 1];
    const fileNameWithoutExt = lastSegment.replace(/\.[a-z0-9]+$/i, "");
    publicIdSegments[publicIdSegments.length - 1] = fileNameWithoutExt;

    return publicIdSegments.join("/");
  } catch {
    return "";
  }
}

async function findEventPosterBySource(posterSource) {
  const normalizedImageUrl = normalizeImageUrl(posterSource);
  const normalizedPublicId =
    normalizePublicId(posterSource) ||
    extractPublicIdFromPosterSource(posterSource);

  const query = [];
  if (normalizedImageUrl.startsWith("http")) {
    query.push({ imageUrl: normalizedImageUrl });
  }
  if (normalizedPublicId) {
    query.push({ publicId: normalizedPublicId });
  }

  if (query.length === 0) {
    return null;
  }

  return EventPoster.findOne({ $or: query });
}

function toPlainConfig(config) {
  if (!config) {
    return getDefaultPosterConfig();
  }

  const defaults = getDefaultPosterConfig();
  return {
    textLineStyles: Array.isArray(config.textLineStyles)
      ? config.textLineStyles.map((style) => ({ ...style }))
      : defaults.textLineStyles,
    layout: {
      ...defaults.layout,
      ...(config.layout && typeof config.layout === "object" ? config.layout : {}),
      lineGaps: Array.isArray(config.layout?.lineGaps)
        ? [...config.layout.lineGaps]
        : defaults.layout.lineGaps,
      textLineAlignments: Array.isArray(config.layout?.textLineAlignments)
        ? [...config.layout.textLineAlignments]
        : defaults.layout.textLineAlignments,
    },
    includeUserImage:
      typeof config.includeUserImage === "boolean"
        ? config.includeUserImage
        : defaults.includeUserImage,
    addWatermark:
      typeof config.addWatermark === "boolean" ? config.addWatermark : defaults.addWatermark,
    watermarkPosition:
      typeof config.watermarkPosition === "string" && config.watermarkPosition.trim()
        ? config.watermarkPosition.trim()
        : defaults.watermarkPosition,
    facebook: {
      ...defaults.facebook,
      ...(config.facebook && typeof config.facebook === "object" ? config.facebook : {}),
    },
  };
}

function formatEventPosterRecord(record) {
  if (!record) {
    return null;
  }

  return {
    posterId: record.posterId,
    publicId: record.publicId,
    imageUrl: record.imageUrl,
    width: record.width ?? undefined,
    height: record.height ?? undefined,
    format: record.format || undefined,
    createdAt: record.createdAt?.toISOString?.() || record.createdAt,
    folder: record.folder || "",
    eventName: record.eventName || "",
    date: record.date || "",
    config: toPlainConfig(record.config),
  };
}

async function findEventPosterByLookup({ posterId, imageUrl, publicId }) {
  const normalizedPosterId = typeof posterId === "string" ? posterId.trim() : "";
  const normalizedImageUrl = normalizeImageUrl(imageUrl);
  const normalizedPublicId = normalizePublicId(publicId);

  if (normalizedPosterId) {
    return EventPoster.findOne({ posterId: normalizedPosterId });
  }

  if (normalizedImageUrl) {
    return EventPoster.findOne({ imageUrl: normalizedImageUrl });
  }

  if (normalizedPublicId) {
    return EventPoster.findOne({ publicId: normalizedPublicId });
  }

  return null;
}

async function createEventPosterEntry({
  publicId,
  imageUrl,
  folder = "",
  date = "",
  eventName = "",
  width = null,
  height = null,
  format = "",
  config,
}) {
  const normalizedPublicId = normalizePublicId(publicId);
  const normalizedImageUrl = normalizeImageUrl(imageUrl);

  if (!normalizedPublicId || !normalizedImageUrl) {
    throw new Error("publicId and imageUrl are required to create an event poster entry.");
  }

  const existing = await EventPoster.findOne({
    $or: [{ publicId: normalizedPublicId }, { imageUrl: normalizedImageUrl }],
  });

  if (existing) {
    existing.publicId = normalizedPublicId;
    existing.imageUrl = normalizedImageUrl;
    if (folder) existing.folder = String(folder).trim();
    if (date) existing.date = String(date).trim();
    if (eventName) existing.eventName = String(eventName).trim();
    if (Number.isFinite(Number(width))) existing.width = Number(width);
    if (Number.isFinite(Number(height))) existing.height = Number(height);
    if (format) existing.format = String(format).trim();
    if (config) {
      existing.config = toPlainConfig(config);
    }
    await existing.save();
    return existing;
  }

  return EventPoster.create({
    posterId: generatePosterId(),
    publicId: normalizedPublicId,
    imageUrl: normalizedImageUrl,
    folder: String(folder || "").trim(),
    date: String(date || "").trim(),
    eventName: String(eventName || "").trim(),
    width: Number.isFinite(Number(width)) ? Number(width) : null,
    height: Number.isFinite(Number(height)) ? Number(height) : null,
    format: String(format || "").trim(),
    config: toPlainConfig(config),
  });
}

async function ensureEventPosterEntry(cloudinaryPoster) {
  return createEventPosterEntry({
    publicId: cloudinaryPoster.publicId,
    imageUrl: cloudinaryPoster.imageUrl,
    folder: cloudinaryPoster.folder,
    date: cloudinaryPoster.date,
    eventName: cloudinaryPoster.eventName,
    width: cloudinaryPoster.width,
    height: cloudinaryPoster.height,
    format: cloudinaryPoster.format,
  });
}

async function enrichCloudinaryPostersFromDb(posters) {
  const enriched = [];

  for (const poster of posters) {
    try {
      const record = await ensureEventPosterEntry(poster);
      enriched.push({
        ...poster,
        posterId: record.posterId,
        config: toPlainConfig(record.config),
      });
    } catch (error) {
      console.warn("Failed to enrich event poster from database:", error.message);
      enriched.push({ ...poster });
    }
  }

  return enriched;
}

async function mergeCloudinaryPostersWithDb(posters) {
  return enrichCloudinaryPostersFromDb(posters);
}

function extractConfigFromGenerateBody(body) {
  const defaults = getDefaultPosterConfig();
  const layout = {
    ...defaults.layout,
    language: typeof body.language === "string" ? body.language.trim() : defaults.layout.language,
    insetFromBottom:
      body.insetFromBottom != null ? Number(body.insetFromBottom) : defaults.layout.insetFromBottom,
    insetLeft: body.insetLeft != null ? Number(body.insetLeft) : defaults.layout.insetLeft,
    insetRight: body.insetRight != null ? Number(body.insetRight) : defaults.layout.insetRight,
    imagePosition:
      typeof body.imagePosition === "string" ? body.imagePosition : defaults.layout.imagePosition,
    imageWidth: body.imageWidth != null ? Number(body.imageWidth) : defaults.layout.imageWidth,
    imageHeight: body.imageHeight != null ? Number(body.imageHeight) : defaults.layout.imageHeight,
    imageShape: typeof body.imageShape === "string" ? body.imageShape : defaults.layout.imageShape,
    imageCornerRadius:
      body.imageCornerRadius != null
        ? Number(body.imageCornerRadius)
        : defaults.layout.imageCornerRadius,
    imageGap: body.imageGap != null ? Number(body.imageGap) : defaults.layout.imageGap,
    imageMaxSize:
      body.imageMaxSize != null ? Number(body.imageMaxSize) : defaults.layout.imageMaxSize,
    lineGap: body.lineGap != null ? Number(body.lineGap) : defaults.layout.lineGap,
    lineGaps: Array.isArray(body.lineGaps)
      ? body.lineGaps.map((gap) => Number(gap) || 0)
      : defaults.layout.lineGaps,
    fontSize: body.fontSize != null ? Number(body.fontSize) : defaults.layout.fontSize,
    fontColor: typeof body.fontColor === "string" ? body.fontColor : defaults.layout.fontColor,
    fontFamily:
      typeof body.fontFamily === "string" ? body.fontFamily : defaults.layout.fontFamily,
    textOpacity:
      body.textOpacity != null ? Number(body.textOpacity) : defaults.layout.textOpacity,
    textBlendMode:
      typeof body.textBlendMode === "string"
        ? body.textBlendMode
        : defaults.layout.textBlendMode,
    textBlockAlign:
      typeof body.textBlockAlign === "string"
        ? body.textBlockAlign
        : defaults.layout.textBlockAlign,
    textLineAlignments: Array.isArray(body.textLineAlignments)
      ? body.textLineAlignments.map((value) => String(value))
      : defaults.layout.textLineAlignments,
  };

  const textLineStyles = Array.isArray(body.textLineStyles)
    ? body.textLineStyles.map((style) => ({
        fontSize: Number(style?.fontSize) || defaults.textLineStyles[0].fontSize,
        fontFamily:
          typeof style?.fontFamily === "string"
            ? style.fontFamily
            : defaults.textLineStyles[0].fontFamily,
        fontColor:
          typeof style?.fontColor === "string"
            ? style.fontColor
            : defaults.textLineStyles[0].fontColor,
        fontWeight:
          typeof style?.fontWeight === "string"
            ? style.fontWeight
            : defaults.textLineStyles[0].fontWeight,
      }))
    : defaults.textLineStyles;

  const uploadToFacebook = ["true", "1", "yes", "y"].includes(
    String(body.uploadToFacebook ?? body.postToFacebook ?? body.facebook ?? "")
      .trim()
      .toLowerCase(),
  );
  const uploadToInstagram = ["true", "1", "yes", "y"].includes(
    String(body.uploadToInstagram ?? body.postToInstagram ?? body.instagram ?? "")
      .trim()
      .toLowerCase(),
  );
  const sendWhatsApp = !["false", "0", "no", "n"].includes(
    String(body.sendWhatsApp ?? body.sendToWhatsApp ?? body.sendWhatsapp ?? body.whatsapp ?? "true")
      .trim()
      .toLowerCase(),
  );

  return {
    textLineStyles,
    layout,
    includeUserImage: body.includeUserImage !== false,
    addWatermark: body.addWatermark !== false,
    watermarkPosition:
      typeof body.watermarkPosition === "string" && body.watermarkPosition.trim()
        ? body.watermarkPosition.trim()
        : defaults.watermarkPosition,
    facebook: {
      uploadToFacebook,
      uploadToInstagram,
      sendWhatsApp,
      facebookCaption:
        typeof body.facebookCaption === "string"
          ? body.facebookCaption.trim()
          : typeof body.caption === "string"
            ? body.caption.trim()
            : "",
      instagramCaption:
        typeof body.instagramCaption === "string" ? body.instagramCaption.trim() : "",
    },
  };
}

async function savePosterConfigForSource(posterSource, configPayload) {
  const normalizedSource = String(posterSource || "").trim();
  if (!normalizedSource) {
    return null;
  }

  const normalizedConfig = toPlainConfig(configPayload);
  let record = await findEventPosterBySource(normalizedSource);

  if (record) {
    record.config = normalizedConfig;
    await record.save();
    return record;
  }

  const publicId =
    extractPublicIdFromPosterSource(normalizedSource) || normalizedSource;
  const imageUrl = normalizedSource.startsWith("http") ? normalizedSource : "";

  record = await createEventPosterEntry({
    publicId,
    imageUrl: imageUrl || publicId,
    config: normalizedConfig,
  });

  return record;
}

async function savePosterConfigFromGenerateBody(posterSource, body) {
  const configPayload = extractConfigFromGenerateBody(body);
  return savePosterConfigForSource(posterSource, configPayload);
}

async function syncEventPostersFromCloudinary(listEventPosterResourcesFromCloudinary) {
  const posters = await listEventPosterResourcesFromCloudinary();
  let created = 0;
  let existing = 0;

  for (const poster of posters) {
    const before = await findEventPosterByLookup({
      publicId: poster.publicId,
      imageUrl: poster.imageUrl,
    });

    await ensureEventPosterEntry(poster);

    if (before) {
      existing += 1;
    } else {
      created += 1;
    }
  }

  return {
    total: posters.length,
    created,
    existing,
  };
}

module.exports = {
  generatePosterId,
  getDefaultPosterConfig,
  toPlainConfig,
  formatEventPosterRecord,
  findEventPosterByLookup,
  findEventPosterBySource,
  extractPublicIdFromPosterSource,
  createEventPosterEntry,
  ensureEventPosterEntry,
  enrichCloudinaryPostersFromDb,
  mergeCloudinaryPostersWithDb,
  extractConfigFromGenerateBody,
  savePosterConfigForSource,
  savePosterConfigFromGenerateBody,
  syncEventPostersFromCloudinary,
};
