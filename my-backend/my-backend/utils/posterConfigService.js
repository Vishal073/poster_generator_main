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

function readPlainObject(value) {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => readPlainObject(entry));
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value._doc && typeof value._doc === "object" && !Array.isArray(value._doc)) {
    return { ...value._doc };
  }

  if (typeof value.toObject === "function") {
    return value.toObject({ flattenMaps: true });
  }

  return { ...value };
}

function pickTextLineStyle(style, fallback) {
  const source = readPlainObject(style) || {};

  return {
    fontSize:
      typeof source.fontSize === "number" && Number.isFinite(source.fontSize)
        ? source.fontSize
        : fallback.fontSize,
    fontFamily:
      typeof source.fontFamily === "string" && source.fontFamily.trim()
        ? source.fontFamily.trim()
        : fallback.fontFamily,
    fontColor:
      typeof source.fontColor === "string" && source.fontColor.trim()
        ? source.fontColor.trim()
        : fallback.fontColor,
    fontWeight:
      typeof source.fontWeight === "string" && source.fontWeight.trim()
        ? source.fontWeight.trim()
        : fallback.fontWeight,
  };
}

function pickLayoutFields(layout, defaults) {
  const source = readPlainObject(layout) || {};

  return {
    language:
      typeof source.language === "string" && source.language.trim()
        ? source.language.trim()
        : defaults.language,
    insetFromBottom:
      typeof source.insetFromBottom === "number"
        ? source.insetFromBottom
        : defaults.insetFromBottom,
    insetLeft:
      typeof source.insetLeft === "number" ? source.insetLeft : defaults.insetLeft,
    insetRight:
      typeof source.insetRight === "number" ? source.insetRight : defaults.insetRight,
    imagePosition:
      typeof source.imagePosition === "string"
        ? source.imagePosition
        : defaults.imagePosition,
    imageWidth:
      typeof source.imageWidth === "number" ? source.imageWidth : defaults.imageWidth,
    imageHeight:
      typeof source.imageHeight === "number" ? source.imageHeight : defaults.imageHeight,
    imageShape:
      typeof source.imageShape === "string" ? source.imageShape : defaults.imageShape,
    imageCornerRadius:
      typeof source.imageCornerRadius === "number"
        ? source.imageCornerRadius
        : defaults.imageCornerRadius,
    imageGap:
      typeof source.imageGap === "number" ? source.imageGap : defaults.imageGap,
    imageMaxSize:
      typeof source.imageMaxSize === "number" ? source.imageMaxSize : defaults.imageMaxSize,
    lineGap: typeof source.lineGap === "number" ? source.lineGap : defaults.lineGap,
    lineGaps: Array.isArray(source.lineGaps)
      ? [Number(source.lineGaps[0]) || 0, Number(source.lineGaps[1]) || 0]
      : defaults.lineGaps,
    fontSize:
      typeof source.fontSize === "number" ? source.fontSize : defaults.fontSize,
    fontColor:
      typeof source.fontColor === "string" ? source.fontColor : defaults.fontColor,
    fontFamily:
      typeof source.fontFamily === "string" ? source.fontFamily : defaults.fontFamily,
    textOpacity:
      typeof source.textOpacity === "number" ? source.textOpacity : defaults.textOpacity,
    textBlendMode:
      typeof source.textBlendMode === "string"
        ? source.textBlendMode
        : defaults.textBlendMode,
    textBlockAlign:
      typeof source.textBlockAlign === "string"
        ? source.textBlockAlign
        : defaults.textBlockAlign,
    textLineAlignments: Array.isArray(source.textLineAlignments)
      ? source.textLineAlignments.map((value) => String(value))
      : defaults.textLineAlignments,
  };
}

function pickFacebookFields(facebook, defaults) {
  const source = readPlainObject(facebook) || {};

  return {
    uploadToFacebook:
      typeof source.uploadToFacebook === "boolean"
        ? source.uploadToFacebook
        : defaults.uploadToFacebook,
    uploadToInstagram:
      typeof source.uploadToInstagram === "boolean"
        ? source.uploadToInstagram
        : defaults.uploadToInstagram,
    sendWhatsApp:
      typeof source.sendWhatsApp === "boolean"
        ? source.sendWhatsApp
        : defaults.sendWhatsApp,
    facebookCaption:
      typeof source.facebookCaption === "string"
        ? source.facebookCaption.trim()
        : defaults.facebookCaption,
    instagramCaption:
      typeof source.instagramCaption === "string"
        ? source.instagramCaption.trim()
        : defaults.instagramCaption,
  };
}

function toPlainConfig(config) {
  const raw = readPlainObject(config);
  if (!raw) {
    return getDefaultPosterConfig();
  }

  const defaults = getDefaultPosterConfig();

  return {
    textLineStyles: Array.isArray(raw.textLineStyles)
      ? [0, 1, 2].map((index) =>
          pickTextLineStyle(raw.textLineStyles[index], defaults.textLineStyles[index]),
        )
      : defaults.textLineStyles,
    layout: pickLayoutFields(raw.layout, defaults.layout),
    includeUserImage:
      typeof raw.includeUserImage === "boolean"
        ? raw.includeUserImage
        : defaults.includeUserImage,
    addWatermark:
      typeof raw.addWatermark === "boolean" ? raw.addWatermark : defaults.addWatermark,
    watermarkPosition:
      typeof raw.watermarkPosition === "string" && raw.watermarkPosition.trim()
        ? raw.watermarkPosition.trim()
        : defaults.watermarkPosition,
    facebook: pickFacebookFields(raw.facebook, defaults.facebook),
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
  const normalizedPublicId =
    normalizePublicId(publicId) || extractPublicIdFromPosterSource(imageUrl);

  const query = [];

  if (normalizedPosterId) {
    query.push({ posterId: normalizedPosterId });
  }

  if (normalizedImageUrl) {
    query.push({ imageUrl: normalizedImageUrl });

    try {
      const decodedUrl = decodeURIComponent(normalizedImageUrl);
      if (decodedUrl !== normalizedImageUrl) {
        query.push({ imageUrl: decodedUrl });
      }
    } catch {
      // Ignore malformed URI sequences.
    }
  }

  if (normalizedPublicId) {
    query.push({ publicId: normalizedPublicId });
  }

  if (query.length === 0) {
    return null;
  }

  return EventPoster.findOne({ $or: query });
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
      existing.markModified("config");
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
    record.markModified("config");
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
