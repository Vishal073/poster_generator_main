/**
 * Creates a Twilio twilio/media content template and submits it for WhatsApp approval.
 *
 * Run from repo root:
 *   node my-backend/my-backend/scripts/createWhatsAppMediaTemplate.js
 *
 * Then set Render env:
 *   TWILIO_MEDIA_TEMPLATE_CONTENT_SID=HX...
 */
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const cloudName = String(process.env.CLOUD_NAME || "").trim();

  if (!accountSid || !authToken) {
    throw new Error("Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
  }
  if (!cloudName) {
    throw new Error("Set CLOUD_NAME so the template media URL matches Cloudinary.");
  }

  const mediaBase = `https://res.cloudinary.com/${cloudName}/image/upload/{{3}}`;
  const samplePath =
    String(process.env.TWILIO_MEDIA_SAMPLE_PATH || "").trim() ||
    "v1776929207/Bjp-poster_roz8od.jpg";

  const client = twilio(accountSid, authToken);
  const content = await client.content.v1.contents.create({
    friendly_name: "poster_ready_media",
    language: "en",
    variables: {
      1: "Vishal",
      2: "Independence Day",
      3: samplePath,
    },
    types: {
      "twilio/media": {
        body: "Hi {{1}}, your {{2}} poster is ready",
        media: [mediaBase],
      },
    },
  });

  console.log("Created content template:");
  console.log("  SID:", content.sid);
  console.log("  name:", content.friendlyName || content.friendly_name);
  console.log("  media:", mediaBase);

  try {
    const approval = await client.content.v1
      .contents(content.sid)
      .approvalCreate.create({
        name: "poster_ready_media",
        category: "UTILITY",
      });
    console.log("Submitted for WhatsApp approval:", approval.status || approval);
  } catch (error) {
    console.warn("Created the template, but WhatsApp approval submit failed:");
    console.warn(" ", error.message);
    console.warn("Submit it in Twilio Console → Content Template Builder → WhatsApp approval.");
  }

  console.log("\nAdd this to Render env, then redeploy:");
  console.log(`TWILIO_MEDIA_TEMPLATE_CONTENT_SID=${content.sid}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
