const express = require("express");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { router: generatePosterRoute } = require("./services/generatePosterRoute");
const { router: whatsappFlowRoute } = require("./services/whatsappFlowRoute");

const app = express();

app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(generatePosterRoute);
app.use(whatsappFlowRoute);

app.get("/", (req, res) => {
  res.json({ message: "API is running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});