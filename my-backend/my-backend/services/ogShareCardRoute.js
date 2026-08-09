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

/** Always public — Facebook cannot scrape localhost. */
function getPublicApiBase() {
  return "https://api.gcrgraphix.com";
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
  return /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|meta-externalagent|Googlebot|Bingbot|DuckDuckBot/i.test(
    String(userAgent || ""),
  );
}

/** Crawler HTML: poster og:image only — NO redirect (Meta follows refresh and scrapes the shop logo). */
function renderOgHtmlForCrawler({ title, description, imageUrl, pageUrl }) {
  const safeTitle = escapeHtml(title || "Shop now");
  const safeDesc = escapeHtml(description || "Tap Shop now to continue.");
  const safeImage = escapeHtml(imageUrl);
  const safePage = escapeHtml(pageUrl);

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
</head>
<body>
  <img src="${safeImage}" alt="${safeTitle}" width="1200" height="630" />
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
  // Prefer original poster URL for scrape reliability (transforms can 404 some assets).
  const image = normalizeHttpUrl(imageUrl) || toOgBannerImage(imageUrl);
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

  const publicUrl = `${getPublicApiBase()}/og/s/${code}`;
  if (/localhost|127\.0\.0\.1/i.test(publicUrl)) {
    throw new Error(
      "OG share URL resolved to localhost; Facebook cannot scrape it.",
    );
  }
  console.log("[og-share] created public card", {
    code,
    publicUrl,
    imageUrl: image.slice(0, 160),
    destinationUrl: dest.slice(0, 120),
  });
  return publicUrl;
}

async function loadOgShareCard(code) {
  const raw = String(code || "").trim();
  if (!raw || raw.length > 80) return null;
  return OgShareCard.findOne({ code: raw }).lean();
}

/**
 * GET /og/s/:code
 * - Facebook crawler → 200 HTML with poster og:image (no redirects)
 * - Humans / Shop now tap → 302 to real shop URL
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

    const ua = req.get("user-agent") || "";
    if (!isSocialCrawler(ua)) {
      return res.redirect(302, card.destinationUrl);
    }

    const pageUrl = `${getPublicApiBase()}/og/s/${card.code}`;
    const html = renderOgHtmlForCrawler({
      title: card.title,
      description: card.description,
      imageUrl: card.imageUrl,
      pageUrl,
    });

    return res
      .status(200)
      .type("html")
      .set("Cache-Control", "public, max-age=300")
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
