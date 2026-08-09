const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

const DEFAULT_PUBLIC_API_BASE = "https://api.gcrgraphix.com";

const OgShareCardSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    destinationUrl: { type: String, required: true },
    imageUrl: { type: String, required: true },
    title: { type: String, default: "Shop now" },
    description: { type: String, default: "" },
  },
  { timestamps: true },
);

// Auto-clean old cards after 60 days
OgShareCardSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

const OgShareCard =
  mongoose.models.OgShareCard || mongoose.model("OgShareCard", OgShareCardSchema);

function getPublicApiBase() {
  const raw =
    process.env.API_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    DEFAULT_PUBLIC_API_BASE;
  let base = String(raw || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) base = DEFAULT_PUBLIC_API_BASE;
  try {
    const host = new URL(base).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
      return DEFAULT_PUBLIC_API_BASE;
    }
  } catch {
    return DEFAULT_PUBLIC_API_BASE;
  }
  return base;
}

function normalizeHttpUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function toOgBannerImage(imageUrl) {
  const raw = normalizeHttpUrl(imageUrl);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!/\.cloudinary\.com$/i.test(parsed.hostname)) {
      return raw;
    }
    if (parsed.pathname.includes("/upload/")) {
      // Avoid double-transform if already present
      if (!/\/upload\/c_fill,w_1200,h_630/.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(
          /\/upload\//,
          "/upload/c_fill,w_1200,h_630,g_auto,f_jpg,q_auto/",
        );
      }
      return parsed.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSocialCrawler(userAgent = "") {
  return /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|meta-externalagent|Googlebot/i.test(
    String(userAgent || ""),
  );
}

function renderOgHtml({ title, description, imageUrl, destinationUrl, pageUrl }) {
  const safeTitle = escapeHtml(title || "Shop now");
  const safeDesc = escapeHtml(description || "Tap Shop now to continue.");
  const safeImage = escapeHtml(imageUrl);
  const safeDest = escapeHtml(destinationUrl);
  const safePage = escapeHtml(pageUrl || destinationUrl);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="GCR Graphix" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:image:secure_url" content="${safeImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:url" content="${safePage}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeImage}" />
  <link rel="image_src" href="${safeImage}" />
  <meta http-equiv="refresh" content="0;url=${safeDest}" />
</head>
<body style="font-family:system-ui,sans-serif;padding:24px;background:#111;color:#fff">
  <p>${safeTitle}</p>
  <p><img src="${safeImage}" alt="" width="600" style="max-width:100%;height:auto" /></p>
  <p><a href="${safeDest}" style="color:#9cf">Continue to shop</a></p>
  <script>location.replace(${JSON.stringify(destinationUrl)});</script>
</body>
</html>`;
}

/**
 * Create a DB-backed public OG URL so local + Render share the same Mongo record
 * (no HMAC secret mismatch).
 */
async function buildOgShareCardUrl({
  destinationUrl,
  imageUrl,
  title = "",
  description = "",
}) {
  const dest = normalizeHttpUrl(destinationUrl);
  const image = toOgBannerImage(imageUrl);
  if (!dest || !image) {
    return null;
  }

  const code = crypto.randomBytes(12).toString("hex");
  await OgShareCard.create({
    code,
    destinationUrl: dest,
    imageUrl: image,
    title: String(title || "Shop now").slice(0, 120),
    description: String(description || title || "Tap Shop now to continue.").slice(0, 200),
  });

  return `${getPublicApiBase()}/og/s/${code}`;
}

async function loadOgShareCard(code) {
  const raw = String(code || "").trim();
  if (!raw || raw.length > 80) return null;
  return OgShareCard.findOne({ code: raw }).lean();
}

/**
 * GET /og/s/:code
 * Always return 200 HTML with og:image so Facebook scrape never misses the poster.
 * Humans are redirected via meta-refresh + JS to the shop URL.
 */
router.get("/og/s/:code", async (req, res) => {
  try {
    const card = await loadOgShareCard(req.params.code);
    if (!card) {
      return res
        .status(404)
        .type("html")
        .send("<p>Share link not found. Create a new Facebook post from the app.</p>");
    }

    const pageUrl = `${getPublicApiBase()}/og/s/${card.code}`;
    const html = renderOgHtml({
      title: card.title,
      description: card.description,
      imageUrl: card.imageUrl,
      destinationUrl: card.destinationUrl,
      pageUrl,
    });

    return res
      .status(200)
      .type("html")
      .set("Cache-Control", "public, max-age=60")
      .send(html);
  } catch (error) {
    console.error("[og-share] serve failed", error?.message || error);
    return res.status(500).type("html").send("<p>Share link error.</p>");
  }
});

module.exports = {
  router,
  buildOgShareCardUrl,
  getPublicApiBase,
  toOgBannerImage,
};
