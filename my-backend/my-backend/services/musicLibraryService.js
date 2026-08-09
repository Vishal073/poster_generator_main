/**
 * Music library: Audius (large free catalog) + curated fallback + optional Jamendo.
 * Instagram Music is not available via Meta API.
 */

const AUDIUS_APP_NAME = process.env.AUDIUS_APP_NAME || "GCRGraphix";
const AUDIUS_HOSTS = [
  "https://discoveryprovider.audius.co",
  "https://audius-discovery-1.cultur3stake.com",
  "https://audius-discovery-2.cultur3stake.com",
];

const CURATED_TRACKS = Array.from({ length: 16 }, (_, index) => {
  const n = index + 1;
  const moods = [
    ["promo", "upbeat"],
    ["electronic", "bright"],
    ["chill", "soft"],
    ["energetic", "fun"],
    ["urban", "groove"],
    ["inspiring", "cinematic"],
    ["happy", "pop"],
    ["fashion", "shop"],
    ["calm", "night"],
    ["strong", "motivation"],
    ["warm", "acoustic"],
    ["party", "dance"],
    ["soft", "ambient"],
    ["promo", "business"],
    ["fun", "quirky"],
    ["uplifting", "bright"],
  ][index];

  return {
    id: `soundhelix-${n}`,
    title: `Instrumental BGM ${n}`,
    artist: "SoundHelix",
    url: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${n}.mp3`,
    duration: 180,
    tags: [...moods, "instrumental", "bgm"],
    source: "curated",
    previewUrl: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${n}.mp3`,
  };
});

function normalizeQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function searchCurated(query, limit = 40) {
  const q = normalizeQuery(query);
  const list = !q
    ? CURATED_TRACKS
    : CURATED_TRACKS.filter((track) => {
        const haystack = [track.title, track.artist, ...(track.tags || [])]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });

  return list.slice(0, Math.max(1, Math.min(Number(limit) || 40, 60)));
}

let cachedAudiusHost = null;
let cachedAudiusHostAt = 0;

async function resolveAudiusHost() {
  const now = Date.now();
  if (cachedAudiusHost && now - cachedAudiusHostAt < 10 * 60 * 1000) {
    return cachedAudiusHost;
  }

  try {
    const response = await fetch("https://api.audius.co", {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const payload = await response.json();
      const host = Array.isArray(payload?.data) ? payload.data[0] : null;
      if (typeof host === "string" && host.startsWith("http")) {
        cachedAudiusHost = host.replace(/\/$/, "");
        cachedAudiusHostAt = now;
        return cachedAudiusHost;
      }
    }
  } catch {
    // fall through to static hosts
  }

  cachedAudiusHost = AUDIUS_HOSTS[0];
  cachedAudiusHostAt = now;
  return cachedAudiusHost;
}

async function audiusFetch(pathWithQuery) {
  const hosts = [await resolveAudiusHost(), ...AUDIUS_HOSTS];
  const uniqueHosts = [...new Set(hosts)];
  let lastError = null;

  for (const host of uniqueHosts) {
    try {
      const response = await fetch(`${host}${pathWithQuery}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        lastError = new Error(`Audius ${response.status} from ${host}`);
        continue;
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Audius is unavailable.");
}

function mapAudiusTrack(track, host) {
  const id = String(track?.id || "").trim();
  if (!id) return null;
  const streamUrl = `${host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${encodeURIComponent(AUDIUS_APP_NAME)}`;
  const title = String(track?.title || "Untitled").trim() || "Untitled";
  const artist =
    String(track?.user?.name || track?.user?.handle || "Audius").trim() ||
    "Audius";
  const genre = String(track?.genre || "").trim();
  const mood = String(track?.mood || "").trim();
  const tags = [genre, mood].filter(Boolean);

  return {
    id: `audius-${id}`,
    title,
    artist,
    url: streamUrl,
    previewUrl: streamUrl,
    duration: Number(track?.duration) || null,
    tags,
    source: "audius",
    artwork:
      track?.artwork?.["150x150"] ||
      track?.artwork?.["480x480"] ||
      track?.artwork?.["1000x1000"] ||
      null,
  };
}

// Audius has weak "hindi" text search (often matches Indonesian artist "Hindia").
// Use Bollywood / Hindustani / Punjabi beat queries instead, and prefer instrumentals.
const DEFAULT_INDIAN_INSTRUMENTAL_QUERIES = [
  "bollywood",
  "punjabi music",
  "punjabi beat",
  "indian classical",
  "hindustani",
  "indian lo fi",
  "sitar",
  "bollywood type beat",
];

const CHIP_QUERY_MAP = {
  hindi: ["bollywood", "hindustani", "indian classical"],
  punjabi: ["punjabi music", "punjabi beat", "bhangra beat"],
  bollywood: ["bollywood", "bollywood type beat"],
  bhangra: ["punjabi beat", "bhangra beat", "punjabi music"],
  instrumental: ["indian classical", "sitar", "bollywood type beat"],
  flute: ["indian flute", "sitar"],
  sitar: ["sitar", "indian classical"],
  bgm: ["bollywood", "indian classical", "punjabi beat"],
  "without song": ["indian classical", "sitar", "bollywood type beat"],
  "music only": ["indian classical", "sitar", "bollywood type beat"],
};

function resolveSearchQueries(query) {
  const q = normalizeQuery(query);
  if (!q || q === "trending" || q === "indian" || q === "all") {
    return [...DEFAULT_INDIAN_INSTRUMENTAL_QUERIES];
  }
  const mapped = CHIP_QUERY_MAP[q];
  if (Array.isArray(mapped)) return mapped;
  if (typeof mapped === "string") return [mapped];
  // Free-text: keep user query + instrumental bias for Indian keywords.
  if (/hindi|punjabi|bollywood|bhangra|indian|desi|sitar|tabla|flute/.test(q)) {
    if (/instrumental|bgm|beat|flute|sitar|classical/.test(q)) return [q];
    return [q, `${q} instrumental`, `${q} beat`];
  }
  return [q];
}

function trackHaystack(track) {
  return [
    track?.title,
    track?.artist,
    ...(Array.isArray(track?.tags) ? track.tags : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isFalseIndianMatch(track) {
  const artist = String(track?.artist || "")
    .trim()
    .toLowerCase();
  const title = String(track?.title || "")
    .trim()
    .toLowerCase();
  // Indonesian band "Hindia" pollutes Hindi searches.
  if (artist === "hindia" || title.includes("hindia -") || title.startsWith("hindia ")) {
    return true;
  }
  return false;
}

function looksInstrumental(track) {
  const hay = trackHaystack(track);

  if (
    /instrumental|bgm|karaoke|flute|sitar|tabla|veena|harmonium|orchestra|ambient|lofi|lo-fi|type beat|no vocal|without vocal|music only|classical/.test(
      hay,
    )
  ) {
    return true;
  }
  if (/lyrics|lyrical|sung by|vocals?|rap battle|cover song|mashup/.test(hay)) {
    return false;
  }
  return null;
}

function looksIndian(track) {
  return /hindi|punjabi|bollywood|bhangra|indian|desi|sitar|tabla|flute|hindustani|raag|raga|dhol/.test(
    trackHaystack(track),
  );
}

function scoreIndianInstrumental(track) {
  let score = 0;
  const instrumental = looksInstrumental(track);
  if (instrumental === true) score += 3;
  if (instrumental === false) score -= 3;
  if (looksIndian(track)) score += 3;
  if (/type beat|bgm|instrumental/.test(trackHaystack(track))) score += 1;
  return score;
}

function rankIndianInstrumental(tracks) {
  return [...tracks].sort(
    (a, b) => scoreIndianInstrumental(b) - scoreIndianInstrumental(a),
  );
}

function filterLibraryTracks(tracks) {
  return tracks.filter((track) => track && !isFalseIndianMatch(track));
}

async function searchAudiusOnce(host, query, limit) {
  const path = `/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=${encodeURIComponent(AUDIUS_APP_NAME)}&limit=${limit}`;
  const payload = await audiusFetch(path);
  const results = Array.isArray(payload?.data) ? payload.data : [];
  return results.map((track) => mapAudiusTrack(track, host)).filter(Boolean);
}

async function searchAudius(query, limit = 40) {
  const host = await resolveAudiusHost();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 50));
  const queries = resolveSearchQueries(query).slice(0, 5);
  const perQuery = Math.max(8, Math.ceil(safeLimit / Math.max(1, Math.min(queries.length, 3))));

  const batches = await Promise.all(
    queries.map((q) => searchAudiusOnce(host, q, perQuery).catch(() => [])),
  );

  const merged = [];
  const seen = new Set();
  for (const batch of batches) {
    for (const track of batch) {
      if (!track?.id || seen.has(track.id)) continue;
      seen.add(track.id);
      merged.push(track);
    }
  }

  return rankIndianInstrumental(filterLibraryTracks(merged)).slice(0, safeLimit);
}

async function searchJamendo(query, limit = 20) {
  const clientId = String(process.env.JAMENDO_CLIENT_ID || "").trim();
  if (!clientId) {
    return [];
  }

  const q =
    resolveSearchQueries(query)[0] ||
    normalizeQuery(query) ||
    "indian instrumental";
  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: String(Math.max(1, Math.min(Number(limit) || 20, 40))),
    search: q,
    include: "musicinfo",
    audioformat: "mp32",
    order: "popularity_total",
    vocalinstrumental: "instrumental",
  });

  const response = await fetch(
    `https://api.jamendo.com/v3.0/tracks/?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(`Jamendo search failed (${response.status}).`);
  }

  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];

  return results
    .map((track) => {
      const url = typeof track.audio === "string" ? track.audio.trim() : "";
      if (!url) return null;
      return {
        id: `jamendo-${track.id}`,
        title: String(track.name || "Untitled").trim() || "Untitled",
        artist: String(track.artist_name || "Jamendo").trim() || "Jamendo",
        url,
        duration: Number(track.duration) || null,
        tags: Array.isArray(track.musicinfo?.tags?.genres)
          ? track.musicinfo.tags.genres.slice(0, 4)
          : [],
        source: "jamendo",
        previewUrl: url,
        license: track.license_ccurl || null,
      };
    })
    .filter(Boolean);
}

async function searchMusicLibrary({ query = "", limit = 40 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 60));
  let audius = [];
  let jamendo = [];
  let audiusError = null;

  try {
    audius = await searchAudius(query, safeLimit);
  } catch (error) {
    audiusError =
      error instanceof Error ? error.message : "Audius search failed.";
    audius = [];
  }

  try {
    jamendo = await searchJamendo(query, Math.min(20, safeLimit));
  } catch {
    jamendo = [];
  }

  // Curated SoundHelix tracks are royalty-free instrumental BGM (no vocals).
  // Show them for empty / instrumental / bgm chips; skip language-specific chips
  // so Hindi/Punjabi results stay focused on those catalogs.
  const qNorm = normalizeQuery(query);
  const includeCurated =
    !qNorm ||
    ["instrumental", "bgm", "music only", "without song", "trending", "all"].includes(
      qNorm,
    );

  const curated = includeCurated
    ? searchCurated("", 16).map((track) => ({
        ...track,
        previewUrl: track.url,
      }))
    : [];

  const merged = [];
  const seen = new Set();

  for (const track of filterLibraryTracks([
    ...audius,
    ...jamendo,
    ...curated,
  ])) {
    const key = track.id || track.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(track);
  }

  // Prefer Hindi/Punjabi + instrumental first; keep curated BGM as fallback.
  let tracks = rankIndianInstrumental(merged).slice(0, safeLimit);
  if (!tracks.length) {
    tracks = listCuratedLibrary().slice(0, safeLimit);
  }

  return {
    tracks,
    providers: {
      audius: audius.length > 0 || !audiusError,
      curated: true,
      jamendo: Boolean(String(process.env.JAMENDO_CLIENT_ID || "").trim()),
    },
    warning: audiusError,
  };
}

function listCuratedLibrary() {
  return CURATED_TRACKS.map((track) => ({
    ...track,
    previewUrl: track.url,
  }));
}

module.exports = {
  CURATED_TRACKS,
  searchMusicLibrary,
  listCuratedLibrary,
  searchCurated,
  searchAudius,
};
