const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { requireAuth } = require("../middleware/requireAuth");
const { requireDb } = require("../middleware/requireDb");
const {
  uploadBufferToCloudinary,
  buildEventPosterFolder,
  getEventPosterRootFolder,
  groupEventPostersByFolder,
  isValidEventDate,
  listEventPosterResourcesFromCloudinary,
  sanitizeEventName,
} = require("./cloudnaryService");
const {
  createEventPosterEntry,
  findEventPosterByLookup,
  formatEventPosterRecord,
  enrichCloudinaryPostersFromDb,
  syncEventPostersFromCloudinary,
  toPlainConfig,
} = require("../utils/posterConfigService");

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

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

router.get("/event-posters/config", requireDb, async (req, res) => {
  try {
    const posterId =
      typeof req.query.posterId === "string" ? req.query.posterId.trim() : "";
    const imageUrl =
      typeof req.query.imageUrl === "string" ? req.query.imageUrl.trim() : "";
    const publicId =
      typeof req.query.publicId === "string" ? req.query.publicId.trim() : "";

    if (!posterId && !imageUrl && !publicId) {
      return res.status(400).json({
        success: false,
        message: "Provide posterId, imageUrl, or publicId to fetch poster config.",
      });
    }

    const record = await findEventPosterByLookup({ posterId, imageUrl, publicId });

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Poster config not found for the given lookup.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Poster config fetched successfully.",
      data: formatEventPosterRecord(record),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch poster config.",
      error: getErrorMessage(error),
    });
  }
});

router.put("/event-posters/:posterId/config", requireAuth, requireDb, async (req, res) => {
  try {
    const posterId = String(req.params.posterId || "").trim();
    if (!posterId) {
      return res.status(400).json({
        success: false,
        message: "posterId is required.",
      });
    }

    const record = await findEventPosterByLookup({ posterId });
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Poster not found.",
      });
    }

    record.config = toPlainConfig(req.body?.config ?? req.body);
    record.markModified("config");
    await record.save();

    return res.status(200).json({
      success: true,
      message: "Poster config saved successfully.",
      data: formatEventPosterRecord(record),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to save poster config.",
      error: getErrorMessage(error),
    });
  }
});

router.post("/event-posters/sync", requireAuth, requireDb, async (req, res) => {
  try {
    const result = await syncEventPostersFromCloudinary(
      listEventPosterResourcesFromCloudinary,
    );

    return res.status(200).json({
      success: true,
      message: "Event poster database sync completed.",
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to sync event posters to database.",
      error: getErrorMessage(error),
    });
  }
});

router.get("/event-posters", async (req, res) => {
  try {
    const folder =
      typeof req.query.folder === "string" ? req.query.folder.trim() : "";

    if (folder) {
      const posters = await listEventPosterResourcesFromCloudinary({ folder });
      let data = posters;

      if (isDbConnected()) {
        try {
          data = await enrichCloudinaryPostersFromDb(posters);
        } catch (dbError) {
          console.warn(
            "Event poster DB enrich failed, returning Cloudinary data only:",
            getErrorMessage(dbError),
          );
        }
      }

      return res.status(200).json({
        success: true,
        message: data.length
          ? `Event posters fetched for folder ${folder}.`
          : `No event posters found for folder ${folder}.`,
        rootFolder: getEventPosterRootFolder(),
        folder,
        count: data.length,
        data,
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

      const folderKey = folder.replace(`${getEventPosterRootFolder()}/`, "");
      const parsedEventName = sanitizeEventName(eventName);

      let configPayload;
      if (req.body.config) {
        try {
          configPayload =
            typeof req.body.config === "string"
              ? JSON.parse(req.body.config)
              : req.body.config;
        } catch {
          configPayload = undefined;
        }
      }

      const responseData = {
        publicId: uploadResult.publicId,
        imageUrl: uploadResult.imageUrl,
      };

      if (isDbConnected()) {
        try {
          const record = await createEventPosterEntry({
            publicId: uploadResult.publicId,
            imageUrl: uploadResult.imageUrl,
            folder: folderKey,
            date,
            eventName: parsedEventName,
            config: configPayload,
          });
          responseData.posterId = record.posterId;
          responseData.config = toPlainConfig(record.config);
        } catch (dbError) {
          console.warn(
            "Event poster uploaded to Cloudinary but database save failed:",
            getErrorMessage(dbError),
          );
        }
      }

      return res.status(201).json({
        success: true,
        message: "Event poster uploaded successfully.",
        rootFolder: getEventPosterRootFolder(),
        folder: folderKey,
        date,
        eventName: parsedEventName,
        data: responseData,
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
