const fs = require("fs");
const path = require("path");
const {
  createApp,
  connectDatabase,
  startFacebookTokenRefreshJobIfNeeded,
} = require("./app");

const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const app = createApp();
const PORT = process.env.PORT || 5000;

async function startServer() {
  await connectDatabase();
  startFacebookTokenRefreshJobIfNeeded();

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  server.timeout = Number(process.env.HTTP_SERVER_TIMEOUT_MS) || 600000;
  server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 610000;
  if (typeof server.requestTimeout === "number" || "requestTimeout" in server) {
    server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 600000;
  }
}

startServer().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
