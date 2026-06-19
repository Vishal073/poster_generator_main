const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/requireAuth");
const {
  uploadBufferToCloudinary,
  buildEventPosterFolder,
  getEventPosterRootFolder,
  groupEventPostersByFolder,
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
    const folder =
      typeof req.query.folder === "string" ? req.query.folder.trim() : "";

    if (folder) {
      const posters = await listEventPosterResourcesFromCloudinary({ folder });

      return res.status(200).json({
        success: true,
        message: posters.length
          ? `Event posters fetched for folder ${folder}.`
          : `No event posters found for folder ${folder}.`,
        rootFolder: getEventPosterRootFolder(),
        folder,
        count: posters.length,
        data: posters,
      });
    }

    const posters = await listEventPosterResourcesFromCloudinary();
    const grouped = groupEventPostersByFolder(posters);

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
