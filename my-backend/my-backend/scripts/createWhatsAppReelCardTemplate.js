/**
 * Creates a Twilio twilio/card content template for occasion reels:
 * caption + video + Approve + Change Caption.
 *
 * Run:
 *   node my-backend/my-backend/scripts/createWhatsAppReelCardTemplate.js
 *
 * Then set Render:
 *   TWILIO_REEL_CARD_TEMPLATE_CONTENT_SID=HX...
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
    throw new Error("Set CLOUD_NAME for a sample Cloudinary media URL.");
  }

  const sampleVideoUrl =
    String(process.env.TWILIO_REEL_SAMPLE_VIDEO_URL || "").trim() ||
    `https://res.cloudinary.com/${cloudName}/video/upload/v1/sample.mp4`;

  const client = twilio(accountSid, authToken);
  const content = await client.content.v1.contents.create({
    friendly_name: "occasion_reel_review_card",
    language: "en",
    variables: {
      1: "Your birthday reel is ready",
      2: "Sample birthday shayari caption here",
      3: sampleVideoUrl,
    },
    types: {
      "twilio/card": {
        title: "{{1}}",
        body: "{{2}}",
        media: ["{{3}}"],
        actions: [
          {
            type: "QUICK_REPLY",
            title: "Approve",
            id: "approve",
          },
          {
            type: "QUICK_REPLY",
            title: "Change Caption",
            id: "change_caption",
          },
        ],
      },
    },
  });

  console.log("Created reel review card template:");
  console.log("  SID:", content.sid);
  console.log("  name:", content.friendlyName || content.friendly_name);
  console.log("  buttons: Approve | Change Caption");

  try {
    const approval = await client.content.v1
      .contents(content.sid)
      .approvalCreate.create({
        name: "occasion_reel_review_card",
        category: "UTILITY",
      });
    console.log("Submitted for WhatsApp approval:", approval.status || approval);
  } catch (error) {
    console.warn("Template created, but WhatsApp approval submit failed:");
    console.warn(" ", error.message);
    console.warn("Approve it in Twilio Console → Content Template Builder.");
  }

  console.log("\nAdd to Render env, then redeploy:");
  console.log(`TWILIO_REEL_CARD_TEMPLATE_CONTENT_SID=${content.sid}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
