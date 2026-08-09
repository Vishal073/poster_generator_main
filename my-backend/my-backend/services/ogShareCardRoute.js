const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const DEFAULT_PUBLIC_API_BASE = "https://api.gcrgraphix.com";

function getSigningSecret() {
  return (
    process.env.OG_SHARE_CARD_SECRET ||
    process.env.FACEBOOK_APP_SECRET ||
    process.env.JWT_SECRET ||
    "gcr-og-share-card"
  );
}

/**
 * Facebook must scrape a public https URL (not localhost).
 */
function getPublicApiBase() {
  const raw =
    process.env.API_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    DEFAULT_PUBLIC_API_BASE;
  let base = String(raw || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) {
    base = DEFAULT_PUBLIC_API_BASE;
  }
  try {
    const host = new URL(base).hostname;
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".local")
    ) {
      return DEFAULT_PUBLIC_API_BASE;
    }
  } catch {
    return DEFAULT_PUBLIC_API_BASE;
  }
  return base;
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
}

function signPayload(payloadB64) {
  return crypto
    .createHmac("sha256", getSigningSecret())
    .update(payloadB64)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

/**
 * Prefer 1200x630 banner for Amazon-style full-width link preview.
 */
function toOgBannerImage(imageUrl) {
  const raw = normalizeHttpUrl(imageUrl);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!/res\.cloudinary\.com$/i.test(parsed.hostname) && !/\.cloudinary\.com$/i.test(parsed.hostname)) {
      return raw;
    }
    // .../upload/v123/x.jpg  OR  .../upload/folder/x.jpg
    if (parsed.pathname.includes("/upload/")) {
      parsed.pathname = parsed.pathname.replace(
        /\/upload\//,
        "/upload/c_fill,w_1200,h_630,g_auto,f_jpg,q_auto/",
      );
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

/**
 * Build a public URL Facebook can scrape for OG tags (poster image)
 * while humans/taps redirect to the real shop URL.
 */
function buildOgShareCardUrl({
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

  const apiBase = getPublicApiBase();
  const payload = {
    u: dest,
    i: image,
    t: String(title || "Shop now").slice(0, 120),
    d: String(description || title || "Tap Shop now to continue.").slice(0, 200),
  };
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(payloadB64);
  return `${apiBase}/og/s/${payloadB64}.${signature}`;
}

function decodeOgShareCardToken(token) {
  const raw = String(token || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!payloadB64 || !signature) return null;
  const expected = signPayload(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadB64));
    const dest = normalizeHttpUrl(parsed.u);
    const image = normalizeHttpUrl(parsed.i);
    if (!dest || !image) return null;
    return {
      destinationUrl: dest,
      imageUrl: image,
      title: String(parsed.t || "Shop now").slice(0, 120),
      description: String(parsed.d || "").slice(0, 200),
    };
  } catch {
    return null;
  }
}

function isSocialCrawler(userAgent = "") {
  return /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|meta-externalagent/i.test(
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
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:image:secure_url" content="${safeImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${safePage}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeImage}" />
</head>
<body style="font-family:system-ui,sans-serif;padding:24px;background:#111;color:#fff">
  <p>${safeTitle}</p>
  <p><a href="${safeDest}" style="color:#9cf">Continue to shop</a></p>
  <script>location.replace(${JSON.stringify(destinationUrl)});</script>
</body>
</html>`;
}

/**
 * GET /og/s/:token
 * Facebook crawler → OG HTML with poster image
 * Humans → redirect to shop URL
 */
router.get("/og/s/:token", (req, res) => {
  const decoded = decodeOgShareCardToken(req.params.token);
  if (!decoded) {
    return res.status(400).type("html").send("<p>Invalid or expired share link.</p>");
  }

  const pageUrl = `${getPublicApiBase()}/og/s/${req.params.token}`;
  const ua = req.get("user-agent") || "";

  // Always serve OG HTML to crawlers; redirect people to the shop.
  if (!isSocialCrawler(ua)) {
    return res.redirect(302, decoded.destinationUrl);
  }

  res
    .status(200)
    .type("html")
    .set("Cache-Control", "public, max-age=300")
    .send(
      renderOgHtml({
        title: decoded.title,
        description: decoded.description,
        imageUrl: decoded.imageUrl,
        destinationUrl: decoded.destinationUrl,
        pageUrl,
      }),
    );
});

module.exports = {
  router,
  buildOgShareCardUrl,
  decodeOgShareCardToken,
  getPublicApiBase,
  toOgBannerImage,
};
