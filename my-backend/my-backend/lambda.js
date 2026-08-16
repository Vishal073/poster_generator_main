const fs = require("fs");
const path = require("path");
const serverless = require("serverless-http");
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
let handlerPromise = null;

async function getHandler() {
  if (handlerPromise) {
    return handlerPromise;
  }

  handlerPromise = connectDatabase().then(() => serverless(app));
  return handlerPromise;
}

module.exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const handler = await getHandler();
  return handler(event, context);
};
