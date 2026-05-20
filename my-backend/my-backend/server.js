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
  res.status(200).json({ status: "ok" });
});

const PORT = process.env.PORT || 5000;

async function connectMongo() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not configured");
    return;
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  connectMongo();
});