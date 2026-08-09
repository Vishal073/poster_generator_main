const cloudinary = require("cloudinary").v2;
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const CLOUDINARY_TIMEOUT_MS =
  Number(process.env.CLOUDINARY_TIMEOUT_MS) || 120000;
const CLOUDINARY_UPLOAD_RETRIES =
  Math.max(1, Number(process.env.CLOUDINARY_UPLOAD_RETRIES) || 5);
const POSTER_UPLOAD_MAX_WIDTH =
  Number(process.env.CLOUDINARY_POSTER_MAX_WIDTH) || 1080;
const POSTER_UPLOAD_MAX_HEIGHT =
  Number(process.env.CLOUDINARY_POSTER_MAX_HEIGHT) || 1920;
const POSTER_UPLOAD_JPEG_QUALITY =
  Number(process.env.CLOUDINARY_POSTER_JPEG_QUALITY) || 78;
const POSTER_UPLOAD_TARGET_BYTES =
  Number(process.env.CLOUDINARY_POSTER_TARGET_BYTES) || 45000;

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  timeout: CLOUDINARY_TIMEOUT_MS,
});

function getPublicIdFromFileName(fileName) {
  return path.parse(String(fileName || "upload")).name;
}

function getCloudinaryErrorMessage(error) {
  if (!error) return "Unknown Cloudinary error";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  if (error.error && typeof error.error.message === "string") {
    return error.error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Cloudinary error";
  }
}

function getCloudinaryErrorCode(error) {
  return Number(
    error?.http_code ||
      error?.statusCode ||
      error?.error?.http_code ||
      error?.error?.statusCode ||
      0,
  );
}

function isTransientCloudinaryError(error) {
  const message = getCloudinaryErrorMessage(error).toLowerCase();
  const code = getCloudinaryErrorCode(error);
  return (
    code === 499 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Downscale + JPEG so ~1MB+ PNG posters don't hit Cloudinary Request Timeout.
 * Uses a fresh sharp pipeline (never reuse after metadata()).
 */
async function prepareImageBufferForUpload(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return buffer;
  }

  const maxWidth = Number(options.maxWidth) || POSTER_UPLOAD_MAX_WIDTH;
  const maxHeight = Number(options.maxHeight) || POSTER_UPLOAD_MAX_HEIGHT;
  let quality = Number(options.quality) || POSTER_UPLOAD_JPEG_QUALITY;
  const targetBytes =
    Number(options.targetBytes) || POSTER_UPLOAD_TARGET_BYTES;

  try {
    const sharp = require("sharp");
    const meta = await sharp(buffer, { failOn: "none" }).metadata();
    let best = null;

    for (let round = 0; round < 4; round += 1) {
      const width = Math.max(640, Math.round(maxWidth * (1 - round * 0.12)));
      const height = Math.max(960, Math.round(maxHeight * (1 - round * 0.12)));
      const q = Math.max(55, quality - round * 8);

      let pipeline = sharp(buffer, { failOn: "none" }).rotate();
      if (
        (meta.width && meta.width > width) ||
        (meta.height && meta.height > height)
      ) {
        pipeline = pipeline.resize({
          width,
          height,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      const compressed = await pipeline
        .jpeg({ quality: q, mozjpeg: true, progressive: true })
        .toBuffer();

      if (!compressed.length) continue;
      if (!best || compressed.length < best.length) {
        best = compressed;
      }
      if (compressed.length <= targetBytes) {
        best = compressed;
        break;
      }
    }

    if (best && best.length > 0 && best.length < buffer.length) {
      console.log(
        `[cloudinary] compressed upload buffer ${buffer.length} → ${best.length} bytes`,
      );
      return best;
    }
  } catch (error) {
    console.warn(
      "[cloudinary] compress failed, uploading original:",
      getCloudinaryErrorMessage(error),
    );
  }

  return buffer;
}

function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}

function uploadViaSdkStream(buffer, uploadOptions) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, uploaded) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(uploaded);
      },
    );
    stream.on("error", reject);
    stream.end(buffer);
  });
}

async function uploadViaDataUri(buffer, uploadOptions) {
  const mime = detectImageMime(buffer);
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
  return cloudinary.uploader.upload(dataUri, uploadOptions);
}

/**
 * Bypass flaky Cloudinary SDK transport: signed multipart over raw HTTPS.
 */
function uploadViaHttpsMultipart(buffer, fileName, uploadOptions) {
  const cloudName = process.env.CLOUD_NAME;
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return Promise.reject(new Error("Cloudinary credentials missing."));
  }

  const resourceType = uploadOptions.resource_type || "image";
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = uploadOptions.folder || "";
  const publicId = uploadOptions.public_id || getPublicIdFromFileName(fileName);

  const paramsToSign = {
    folder,
    overwrite: "true",
    public_id: publicId,
    timestamp,
  };
  const signatureBase = Object.keys(paramsToSign)
    .sort()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");
  const signature = crypto
    .createHash("sha1")
    .update(`${signatureBase}${apiSecret}`)
    .digest("hex");

  const boundary = `----cld${crypto.randomBytes(12).toString("hex")}`;
  const mime = detectImageMime(buffer);
  const safeName = `${publicId}${mime === "image/png" ? ".png" : ".jpg"}`;

  const fields = {
    api_key: apiKey,
    timestamp: String(timestamp),
    signature,
    folder,
    public_id: publicId,
    overwrite: "true",
  };

  const chunks = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
  );
  chunks.push(buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudinary.com",
        path: `/v1_1/${cloudName}/${resourceType}/upload`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: CLOUDINARY_TIMEOUT_MS,
      },
      (res) => {
        const parts = [];
        res.on("data", (chunk) => parts.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(parts).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            reject(
              new Error(
                `Cloudinary HTTPS upload returned non-JSON (${res.statusCode}).`,
              ),
            );
            return;
          }
          if (res.statusCode >= 400 || parsed.error) {
            const err = new Error(
              parsed?.error?.message || `Cloudinary HTTP ${res.statusCode}`,
            );
            err.http_code = parsed?.error?.http_code || res.statusCode;
            reject(err);
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      const err = new Error("Request Timeout");
      err.http_code = 499;
      reject(err);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function uploadBufferOnce(buffer, fileName, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Upload buffer is missing or invalid.");
  }

  const resourceType = options.resource_type || "image";
  const method = options.uploadMethod || "stream";
  const uploadOptions = {
    folder:
      options.folder || process.env.CLOUDINARY_USER_FOLDER || "user-images",
    public_id: getPublicIdFromFileName(fileName),
    resource_type: resourceType,
    overwrite: true,
    timeout: CLOUDINARY_TIMEOUT_MS,
  };

  if (resourceType === "video") {
    uploadOptions.chunk_size =
      Number(process.env.CLOUDINARY_CHUNK_SIZE) || 6000000;
  }

  const startedAt = Date.now();
  let result;

  if (resourceType === "video") {
    result = await uploadViaSdkStream(buffer, uploadOptions);
  } else if (method === "https") {
    result = await uploadViaHttpsMultipart(buffer, fileName, uploadOptions);
  } else if (method === "datauri") {
    result = await uploadViaDataUri(buffer, uploadOptions);
  } else {
    result = await uploadViaSdkStream(buffer, uploadOptions);
  }

  console.log(
    `[cloudinary] upload ok via ${method} in ${Date.now() - startedAt}ms (${buffer.length} bytes, ${resourceType})`,
  );

  if (resourceType === "video") {
    return {
      videoUrl: result.secure_url,
      publicId: result.public_id,
    };
  }

  return {
    imageUrl: result.secure_url,
    publicId: result.public_id,
  };
}

async function uploadBufferToCloudinary(buffer, fileName, options = {}) {
  const resourceType = options.resource_type || "image";
  let payload = buffer;

  // Poster PNGs (~1MB+) often timeout on this network — compress by default for images.
  if (resourceType === "image" && options.compress !== false) {
    payload = await prepareImageBufferForUpload(buffer, options);
  }

  const methods =
    resourceType === "image"
      ? ["stream", "https", "datauri", "stream", "https"]
      : ["stream", "stream", "stream", "stream", "stream"];

  let lastError = null;

  for (let attempt = 1; attempt <= CLOUDINARY_UPLOAD_RETRIES; attempt += 1) {
    const method = methods[(attempt - 1) % methods.length];
    try {
      return await uploadBufferOnce(payload, fileName, {
        ...options,
        resource_type: resourceType,
        uploadMethod: method,
      });
    } catch (error) {
      lastError = error;
      const retryable =
        attempt < CLOUDINARY_UPLOAD_RETRIES &&
        isTransientCloudinaryError(error);
      console.warn(
        `[cloudinary] upload failed (attempt ${attempt}/${CLOUDINARY_UPLOAD_RETRIES}, method=${method}):`,
        getCloudinaryErrorMessage(error),
        `bytes=${payload?.length || 0}`,
        retryable ? "— retrying…" : "",
      );
      if (!retryable) {
        const wrapped = new Error(getCloudinaryErrorMessage(error));
        wrapped.http_code = getCloudinaryErrorCode(error);
        wrapped.cause = error;
        throw wrapped;
      }
      if (
        resourceType === "image" &&
        isTransientCloudinaryError(error) &&
        Buffer.isBuffer(payload)
      ) {
        payload = await prepareImageBufferForUpload(payload, {
          maxWidth: Math.min(POSTER_UPLOAD_MAX_WIDTH, 900 - attempt * 40),
          maxHeight: Math.min(POSTER_UPLOAD_MAX_HEIGHT, 1600 - attempt * 60),
          quality: Math.max(55, 72 - attempt * 4),
          targetBytes: Math.max(28000, POSTER_UPLOAD_TARGET_BYTES - attempt * 4000),
        });
      }
      await sleep(1000 * attempt);
    }
  }

  const wrapped = new Error(
    getCloudinaryErrorMessage(lastError) || "Cloudinary upload failed.",
  );
  wrapped.http_code = getCloudinaryErrorCode(lastError);
  wrapped.cause = lastError;
  throw wrapped;
}

function uploadPosterToCloudinary(buffer, fileName) {
  return uploadBufferToCloudinary(buffer, fileName, {
    folder: process.env.CLOUDINARY_POSTER_FOLDER || "posters",
    compress: true,
  });
}

function uploadVideoBufferToCloudinary(buffer, fileName, options = {}) {
  return uploadBufferToCloudinary(buffer, fileName, {
    folder: options.folder || process.env.CLOUDINARY_REELS_FOLDER || "reels",
    resource_type: "video",
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

function getEventPosterRootFolder() {
  return process.env.CLOUDINARY_EVENT_POSTER_FOLDER || "event_posters";
}

const EVENT_DATE_PATTERN = /^(\d{2}-\d{2}-\d{4})$/;

function isValidEventDate(date) {
  return EVENT_DATE_PATTERN.test(String(date || "").trim());
}

function sanitizeEventName(eventName) {
  const sanitized = String(eventName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "event";
}

function buildEventPosterFolder(date, eventName) {
  const normalizedDate = String(date || "").trim();
  if (!isValidEventDate(normalizedDate)) {
    throw new Error("date must be in DD-MM-YYYY format.");
  }

  const normalizedEventName = sanitizeEventName(eventName);
  if (!normalizedEventName) {
    throw new Error("eventName is required.");
  }

  return `${getEventPosterRootFolder()}/${normalizedDate}-${normalizedEventName}`;
}

function parseEventPosterFolderKey(folderPath) {
  const relativePath = String(folderPath || "")
    .replace(new RegExp(`^${escapeRegExp(getEventPosterRootFolder())}/`, "i"), "")
    .trim();

  const match = relativePath.match(/^(\d{2}-\d{2}-\d{4})-(.+)$/);
  if (!match) {
    return null;
  }

  return {
    date: match[1],
    eventName: match[2].replace(/-/g, " "),
    folderKey: `${match[1]}-${match[2]}`,
  };
}

function formatEventPosterResource(resource) {
  const folderPath = String(resource.public_id || "").replace(/\/[^/]+$/, "");
  const parsed = parseEventPosterFolderKey(folderPath);

  return {
    publicId: resource.public_id,
    imageUrl: resource.secure_url,
    width: resource.width,
    height: resource.height,
    format: resource.format,
    createdAt: resource.created_at,
    folder: parsed?.folderKey || folderPath.split("/").pop() || "",
    eventName: parsed?.eventName || "",
    date: parsed?.date || "",
  };
}

async function listEventPosterResourcesFromCloudinary(options = {}) {
  const rootFolder = getEventPosterRootFolder();
  const folderFilter = options.folder ? String(options.folder).trim() : "";
  const prefix = folderFilter
    ? `${rootFolder}/${folderFilter}/`
    : `${rootFolder}/`;
  const maxResults = Number(options.maxResults) > 0 ? Number(options.maxResults) : 500;
  const posters = [];
  let nextCursor;

  do {
    const response = await cloudinary.api.resources({
      type: "upload",
      prefix,
      max_results: Math.min(maxResults - posters.length, 500),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });

    posters.push(...(response.resources || []).map(formatEventPosterResource));
    nextCursor = response.next_cursor;

    if (posters.length >= maxResults) {
      break;
    }
  } while (nextCursor);

  return posters.slice(0, maxResults);
}

function formatEventDisplayName(eventName) {
  return String(eventName || "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function groupEventPostersByFolder(posters) {
  const groups = new Map();

  for (const poster of posters) {
    if (!poster.folder) {
      continue;
    }

    if (!groups.has(poster.folder)) {
      const displayEvent = formatEventDisplayName(poster.eventName);
      groups.set(poster.folder, {
        folder: poster.folder,
        date: poster.date,
        eventName: displayEvent,
        title: `${poster.date} ${displayEvent}`.trim(),
        imageCount: 0,
        coverImageUrl: poster.imageUrl,
        latestCreatedAt: poster.createdAt || "",
      });
    }

    const group = groups.get(poster.folder);
    group.imageCount += 1;

    if ((poster.createdAt || "") >= group.latestCreatedAt) {
      group.latestCreatedAt = poster.createdAt || "";
      group.coverImageUrl = poster.imageUrl;
    }
  }

  return Array.from(groups.values())
    .map(({ latestCreatedAt, ...group }) => group)
    .sort((left, right) => {
      const leftParts = left.date.split("-").reverse().join("-");
      const rightParts = right.date.split("-").reverse().join("-");
      if (leftParts !== rightParts) {
        return rightParts.localeCompare(leftParts);
      }
      return left.title.localeCompare(right.title);
    });
}

function isAllowedEventPosterSource(posterSource) {
  const source = String(posterSource || "").trim();
  if (!source) {
    return false;
  }

  const rootFolder = getEventPosterRootFolder();
  const folderPattern = new RegExp(`/${escapeRegExp(rootFolder)}/`, "i");
  if (folderPattern.test(source)) {
    return true;
  }

  const publicIdPattern = new RegExp(`^${escapeRegExp(rootFolder)}/`, "i");
  return publicIdPattern.test(source);
}

function isAllowedPosterSource(posterSource) {
  return (
    isAllowedBasePosterSource(posterSource) ||
    isAllowedEventPosterSource(posterSource)
  );
}

module.exports = cloudinary;
module.exports.uploadBufferToCloudinary = uploadBufferToCloudinary;
module.exports.uploadPosterToCloudinary = uploadPosterToCloudinary;
module.exports.uploadVideoBufferToCloudinary = uploadVideoBufferToCloudinary;
module.exports.getBasePosterFolder = getBasePosterFolder;
module.exports.isAllowedBasePosterSource = isAllowedBasePosterSource;
module.exports.listBasePostersFromCloudinary = listBasePostersFromCloudinary;
module.exports.getEventPosterRootFolder = getEventPosterRootFolder;
module.exports.isValidEventDate = isValidEventDate;
module.exports.sanitizeEventName = sanitizeEventName;
module.exports.buildEventPosterFolder = buildEventPosterFolder;
module.exports.parseEventPosterFolderKey = parseEventPosterFolderKey;
module.exports.listEventPosterResourcesFromCloudinary = listEventPosterResourcesFromCloudinary;
module.exports.groupEventPostersByFolder = groupEventPostersByFolder;
module.exports.formatEventDisplayName = formatEventDisplayName;
module.exports.isAllowedEventPosterSource = isAllowedEventPosterSource;
module.exports.isAllowedPosterSource = isAllowedPosterSource;
