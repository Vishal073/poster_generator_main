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
  const dateFilter = options.date ? String(options.date).trim() : "";
  const prefix = dateFilter
    ? `${rootFolder}/${dateFilter}-`
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

function groupEventPostersByDate(posters) {
  const groups = new Map();

  for (const poster of posters) {
    const date = poster.date;
    if (!date) {
      continue;
    }

    if (!groups.has(date)) {
      groups.set(date, {
        date,
        imageCount: 0,
        folders: new Set(),
      });
    }

    const group = groups.get(date);
    group.imageCount += 1;
    if (poster.folder) {
      group.folders.add(poster.folder);
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      date: group.date,
      imageCount: group.imageCount,
      folders: Array.from(group.folders).sort(),
    }))
    .sort((left, right) => {
      const leftParts = left.date.split("-").reverse().join("-");
      const rightParts = right.date.split("-").reverse().join("-");
      return rightParts.localeCompare(leftParts);
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
module.exports.getBasePosterFolder = getBasePosterFolder;
module.exports.isAllowedBasePosterSource = isAllowedBasePosterSource;
module.exports.listBasePostersFromCloudinary = listBasePostersFromCloudinary;
module.exports.getEventPosterRootFolder = getEventPosterRootFolder;
module.exports.isValidEventDate = isValidEventDate;
module.exports.sanitizeEventName = sanitizeEventName;
module.exports.buildEventPosterFolder = buildEventPosterFolder;
module.exports.parseEventPosterFolderKey = parseEventPosterFolderKey;
module.exports.listEventPosterResourcesFromCloudinary = listEventPosterResourcesFromCloudinary;
module.exports.groupEventPostersByDate = groupEventPostersByDate;
module.exports.isAllowedEventPosterSource = isAllowedEventPosterSource;
module.exports.isAllowedPosterSource = isAllowedPosterSource;
