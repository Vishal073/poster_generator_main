const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/requireAuth");
const {
  uploadBufferToCloudinary,
  buildEventPosterFolder,
  getEventPosterRootFolder,
  groupEventPostersByDate,
  isValidEventDate,
  listEventPosterResourcesFromCloudinary,
  sanitizeEventName,
} = require("./cloudnaryService");

const router = express.Router();

const eventPosterUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed."));
      return;
    }

    cb(null, true);
  },
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

router.get("/event-posters", async (req, res) => {
  try {
    const date = typeof req.query.date === "string" ? req.query.date.trim() : "";

    if (date && !isValidEventDate(date)) {
      return res.status(400).json({
        success: false,
        message: "date query must be in DD-MM-YYYY format.",
        rootFolder: getEventPosterRootFolder(),
      });
    }

    const posters = await listEventPosterResourcesFromCloudinary({
      date: date || undefined,
    });

    if (date) {
      return res.status(200).json({
        success: true,
        message: posters.length
          ? `Event posters fetched for ${date}.`
          : `No event posters found for ${date}.`,
        rootFolder: getEventPosterRootFolder(),
        date,
        count: posters.length,
        data: posters,
      });
    }

    const grouped = groupEventPostersByDate(posters);

    return res.status(200).json({
      success: true,
      message: grouped.length
        ? "Event poster folders fetched successfully."
        : "No event poster folders found in Cloudinary.",
      rootFolder: getEventPosterRootFolder(),
      count: grouped.length,
      data: grouped,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch event posters from Cloudinary.",
      rootFolder: getEventPosterRootFolder(),
      error: getErrorMessage(error),
    });
  }
});

router.post(
  "/event-posters",
  requireAuth,
  eventPosterUpload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required (field name: 'image').",
        });
      }

      const date = typeof req.body.date === "string" ? req.body.date.trim() : "";
      const eventName =
        typeof req.body.eventName === "string" ? req.body.eventName.trim() : "";

      if (!isValidEventDate(date)) {
        return res.status(400).json({
          success: false,
          message: "date is required in DD-MM-YYYY format.",
        });
      }

      if (!sanitizeEventName(eventName)) {
        return res.status(400).json({
          success: false,
          message: "eventName is required.",
        });
      }

      const folder = buildEventPosterFolder(date, eventName);
      const fallbackName = `event-poster-${Date.now()}`;
      const fileName = req.file.originalname || fallbackName;

      const uploadResult = await uploadBufferToCloudinary(
        req.file.buffer,
        fileName,
        { folder },
      );

      return res.status(201).json({
        success: true,
        message: "Event poster uploaded successfully.",
        rootFolder: getEventPosterRootFolder(),
        folder,
        date,
        eventName: sanitizeEventName(eventName),
        data: {
          publicId: uploadResult.publicId,
          imageUrl: uploadResult.imageUrl,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to upload event poster.",
        rootFolder: getEventPosterRootFolder(),
        error: getErrorMessage(error),
      });
    }
  },
);

module.exports = { router };
