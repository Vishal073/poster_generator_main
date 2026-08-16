const express = require("express");
const mongoose = require("mongoose");
const { router: authRoute } = require("./services/authRoute");
const { router: userAuthRoute } = require("./services/userAuthRoute");
const { router: generatePosterRoute } = require("./services/generatePosterRoute");
const { router: userRoute } = require("./services/userRoute");
const { router: whatsappFlowRoute } = require("./services/whatsappFlowRoute");
const facebookRoutes = require("./routes/facebookRoutes");
const { router: shareImageRoute } = require("./services/shareImageRoute");
const { router: eventPosterRoute } = require("./services/eventPosterRoute");
const { router: reelsRoute } = require("./services/reelsRoute");
const { router: musicRoute } = require("./services/musicRoute");
const { router: ogShareCardRoute } = require("./services/ogShareCardRoute");
const { router: shopRoute } = require("./services/shop/shopRoute");
const { router: shopAdminRoute } = require("./services/shop/shopAdminRoute");
const FacebookConnection = require("./models/FacebookConnection");

const defaultAllowedOrigins = [
  "https://admin.gcrgraphix.com",
  "https://gcrgraphix.com",
  "https://www.gcrgraphix.com",
  "https://poster-generator-admin-portal.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function buildAllowedOrigins() {
  return [
    ...defaultAllowedOrigins,
    ...(process.env.CORS_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ].filter((origin, index, list) => list.indexOf(origin) === index);
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) {
    return false;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (/^https:\/\/([a-z0-9-]+\.)*gcrgraphix\.com$/.test(origin)) {
    return true;
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;

  if (isAllowedOrigin(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
}

function createApp() {
  const app = express();
  const allowedOrigins = buildAllowedOrigins();

  app.set("trust proxy", true);

  app.use((req, res, next) => {
    applyCors(req, res, allowedOrigins);

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  });

  app.options(/.*/, (req, res) => {
    applyCors(req, res, allowedOrigins);
    return res.sendStatus(204);
  });

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(authRoute);
  app.use(userAuthRoute);
  app.use(generatePosterRoute);
  app.use(userRoute);
  app.use(shareImageRoute);
  app.use(eventPosterRoute);
  app.use(reelsRoute);
  app.use(musicRoute);
  app.use(ogShareCardRoute);
  app.use(shopAdminRoute);
  app.use(shopRoute);
  app.use(whatsappFlowRoute);
  app.use(facebookRoutes);

  app.get("/", (req, res) => {
    res.json({ message: "API is running" });
  });

  app.get("/health", (req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;
    res.status(dbConnected ? 200 : 503).json({
      status: dbConnected ? "ok" : "degraded",
      database: dbConnected ? "connected" : "disconnected",
      dbState: mongoose.connection.readyState,
    });
  });

  return app;
}

async function removeFacebookConnectionTtlIndex() {
  try {
    const indexes = await FacebookConnection.collection.indexes();
    for (const index of indexes) {
      if (
        index.key &&
        index.key.expiresAt === 1 &&
        typeof index.expireAfterSeconds === "number"
      ) {
        await FacebookConnection.collection.dropIndex(index.name);
        console.log(`Dropped FacebookConnection TTL index: ${index.name}`);
      }
    }
  } catch (error) {
    console.warn("Could not update FacebookConnection indexes:", error.message);
  }
}

let databasePromise = null;

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (databasePromise) {
    return databasePromise;
  }

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  databasePromise = mongoose
    .connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
    })
    .then(async (connection) => {
      console.log("MongoDB Connected");
      await removeFacebookConnectionTtlIndex();
      return connection;
    })
    .catch((error) => {
      databasePromise = null;
      throw error;
    });

  return databasePromise;
}

function startFacebookTokenRefreshJobIfNeeded() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return;
  }

  const { startFacebookTokenRefreshJob } = require("./services/facebookTokenRefreshService");
  startFacebookTokenRefreshJob();
}

module.exports = {
  createApp,
  connectDatabase,
  startFacebookTokenRefreshJobIfNeeded,
};
