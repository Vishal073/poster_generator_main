/**
 * Detect reel-worthy occasions from user text.
 * Reels only for: birthday | party | festival. Everything else → none.
 */

const REEL_OCCASIONS = new Set(["birthday", "party", "festival"]);

function normalizeOccasionText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectOccasionByKeywords(text) {
  const t = normalizeOccasionText(text);
  if (!t) {
    return "none";
  }

  const birthday =
    /\b(birthday|bday|b\s*day|janamdin|janmdin|salgirah|happy\s*birthday)\b/.test(t) ||
    t.includes("जन्मदिन") ||
    t.includes("बर्थडे") ||
    t.includes("सालगिरह");

  const festival =
    /\b(diwali|deepavali|holi|eid|christmas|xmas|navratri|dussehra|dashahara|rakhi|raksha\s*bandhan|lohri|pongal|onam|gurpurab|janmashtami|ganesh|chhath|baisakhi|vaisakhi|makar\s*sankranti|sankranti|karva\s*chauth|teej|festival|tyohar|tyohaar)\b/.test(
      t,
    ) ||
    t.includes("त्योहार") ||
    t.includes("दिवाली") ||
    t.includes("होली") ||
    t.includes("ईद") ||
    t.includes("नवरात्रि") ||
    t.includes("रक्षाबंधन");

  const party =
    /\b(party|reception|shaadi|shadi|wedding|engagement|anniversary|get\s*together|celebration|bash|sangeet|mehndi)\b/.test(
      t,
    ) ||
    t.includes("पार्टी") ||
    t.includes("शादी") ||
    t.includes("रिसेप्शन");

  // More specific first.
  if (birthday) return "birthday";
  if (festival) return "festival";
  if (party) return "party";
  return "none";
}

function detectOccasion(text) {
  return detectOccasionByKeywords(text);
}

function isReelOccasion(occasion) {
  return REEL_OCCASIONS.has(String(occasion || "").trim().toLowerCase());
}

module.exports = {
  detectOccasion,
  detectOccasionByKeywords,
  isReelOccasion,
  REEL_OCCASIONS,
};
