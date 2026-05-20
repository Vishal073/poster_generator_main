const express = require("express");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { router: authRoute } = require("./services/authRoute");
const { router: generatePosterRoute } = require("./services/generatePosterRoute");
const { router: userRoute } = require("./services/userRoute");
const { router: whatsappFlowRoute } = require("./services/whatsappFlowRoute");

const app = express();

app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(authRoute);
app.use(generatePosterRoute);
app.use(userRoute);
app.use(whatsappFlowRoute);

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