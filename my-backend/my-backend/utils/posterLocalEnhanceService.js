const sharp = require("sharp");

const PROFILES = {
  low: {
    brightness: 1.02,
    saturation: 1.04,
    contrast: 1.03,
    contrastOffset: -4,
    vignette: false,
    bottomGlow: false,
    softGlow: false,
    sharpen: false,
  },
  medium: {
    brightness: 1.04,
    saturation: 1.1,
    contrast: 1.08,
    contrastOffset: -8,
    vignette: true,
    bottomGlow: true,
    softGlow: true,
    sharpen: true,
  },
  premium: {
    brightness: 1.05,
    saturation: 1.14,
    contrast: 1.1,
    contrastOffset: -10,
    vignette: true,
    bottomGlow: true,
    softGlow: true,
    sharpen: true,
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampChannel(value) {
  return clamp(Math.round(value), 0, 255);
}

function resolveProfile(profileName) {
  if (profileName === "low") {
    return PROFILES.low;
  }
  if (profileName === "premium" || profileName === "high") {
    return PROFILES.premium;
  }
  return PROFILES.medium;
}

async function sampleBottomColor(buffer) {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) {
    return { r: 30, g: 25, b: 20 };
  }

  const stripHeight = clamp(Math.round(height * 0.1), 24, 180);
  const { dominant } = await sharp(buffer)
    .extract({ left: 0, top: height - stripHeight, width, height: stripHeight })
    .stats();

  return {
    r: clampChannel(dominant.r),
    g: clampChannel(dominant.g),
    b: clampChannel(dominant.b),
  };
}

function buildVignetteSvg(width, height) {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="v" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.38"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#v)"/>
  </svg>`);
}

function buildBottomDepthSvg(width, height, color) {
  const stripHeight = clamp(Math.round(height * 0.14), 48, 220);
  const waveTop = Math.round(stripHeight * 0.28);
  const mid = Math.round(width / 2);
  const quarter = Math.round(width / 4);
  const darkR = clampChannel(color.r * 0.55);
  const darkG = clampChannel(color.g * 0.55);
  const darkB = clampChannel(color.b * 0.55);
  const accentR = clampChannel(color.r * 0.85);
  const accentG = clampChannel(color.g * 0.85);
  const accentB = clampChannel(color.b * 0.85);

  return Buffer.from(`<svg width="${width}" height="${stripHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="footer" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgb(${accentR},${accentG},${accentB})" stop-opacity="0"/>
        <stop offset="55%" stop-color="rgb(${darkR},${darkG},${darkB})" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="rgb(${darkR},${darkG},${darkB})" stop-opacity="0.42"/>
      </linearGradient>
    </defs>
    <path d="M0,${waveTop + 8} C${quarter},${waveTop - 10} ${mid},${waveTop + 14} ${width},${waveTop + 4} L${width},${stripHeight} L0,${stripHeight} Z" fill="url(#footer)"/>
  </svg>`);
}

async function applyColorGrade(buffer, profile) {
  let pipeline = sharp(buffer).normalize().modulate({
    brightness: profile.brightness,
    saturation: profile.saturation,
  });

  pipeline = pipeline.linear(profile.contrast, profile.contrastOffset);

  // Warm premium LUT-style tint without shifting text hues aggressively.
  pipeline = pipeline.recomb([
    [1.04, 0.02, 0],
    [0.01, 1.02, 0],
    [0, 0.01, 0.98],
  ]);

  return pipeline.png({ quality: 94, compressionLevel: 8 }).toBuffer();
}

async function applySoftGlow(buffer) {
  const blurred = await sharp(buffer).blur(5).ensureAlpha().toBuffer();
  return sharp(buffer)
    .ensureAlpha()
    .composite([{ input: blurred, blend: "soft-light" }])
    .png({ quality: 94, compressionLevel: 8 })
    .toBuffer();
}

async function applySharpen(buffer) {
  return sharp(buffer)
    .sharpen({ sigma: 0.9, m1: 0.5, m2: 2.0, x1: 2, y2: 10, y3: 20 })
    .png({ quality: 94, compressionLevel: 8 })
    .toBuffer();
}

async function applySvgOverlays(buffer, profile) {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) {
    return buffer;
  }

  const composites = [];

  if (profile.vignette) {
    composites.push({
      input: buildVignetteSvg(width, height),
      top: 0,
      left: 0,
    });
  }

  if (profile.bottomGlow) {
    const bottomColor = await sampleBottomColor(buffer);
    const stripHeight = clamp(Math.round(height * 0.14), 48, 220);
    composites.push({
      input: buildBottomDepthSvg(width, height, bottomColor),
      top: height - stripHeight,
      left: 0,
    });
  }

  if (!composites.length) {
    return buffer;
  }

  return sharp(buffer)
    .composite(composites)
    .png({ quality: 94, compressionLevel: 8 })
    .toBuffer();
}

async function applyLocalPremiumEnhance(buffer, profileName = "medium") {
  const profile = resolveProfile(profileName);
  let result = await applyColorGrade(buffer, profile);

  if (profile.softGlow) {
    result = await applySoftGlow(result);
  }

  result = await applySvgOverlays(result, profile);

  if (profile.sharpen) {
    result = await applySharpen(result);
  }

  return result;
}

module.exports = {
  applyLocalPremiumEnhance,
  resolveProfile,
};
