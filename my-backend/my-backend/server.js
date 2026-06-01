const express = require("express");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { router: authRoute } = require("./services/authRoute");
const { router: userAuthRoute } = require("./services/userAuthRoute");
const { router: generatePosterRoute } = require("./services/generatePosterRoute");
const { router: userRoute } = require("./services/userRoute");
const { router: whatsappFlowRoute } = require("./services/whatsappFlowRoute");
const facebookRoutes = require("./routes/facebookRoutes");
const { router: shareImageRoute } = require("./services/shareImageRoute");

const app = express();

app.set("trust proxy", true);

const allowedOrigins = (process.env.CORS_ORIGINS ||
  "http://localhost:3000,http://localhost:5173,http://localhost:5174,http://127.0.0.1:3000,http://127.0.0.1:5173,http://127.0.0.1:5174")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) {
    return false;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (isAllowedOrigin(origin)) {
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

app.use((req, res, next) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.options(/.*/, (req, res) => {
  applyCors(req, res);
  return res.sendStatus(204);
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(authRoute);
app.use(userAuthRoute);
app.use(generatePosterRoute);
app.use(userRoute);
app.use(shareImageRoute);
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

const PORT = process.env.PORT || 5000;

async function startServer() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000,
  });
  console.log("MongoDB Connected");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});