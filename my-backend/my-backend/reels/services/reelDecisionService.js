const AGGRESSIVE_TRANSITIONS = new Set(["slide_left", "slide_right", "push"]);

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pickWithoutImmediateRepeat(list, previous) {
  const filtered = list.filter((item) => item !== previous);
  if (!filtered.length) {
    return pickRandom(list);
  }
  return pickRandom(filtered);
}

function buildAnimationPool(categoryPreset, template, segmentIndex) {
  const templateAnimations = Array.isArray(template.animations)
    ? template.animations.map(normalizeKey).filter(Boolean)
    : [];
  if (templateAnimations.length) {
    return templateAnimations;
  }

  const segment = template.segments[segmentIndex];
  const segmentAnimation = normalizeKey(segment?.animation);
  if (segmentAnimation) {
    return [segmentAnimation, ...categoryPreset.animationPool.map(normalizeKey)];
  }

  return categoryPreset.animationPool.map(normalizeKey);
}

function selectAnimations(categoryPreset, template) {
  const selected = [];
  let previous = "";

  for (let index = 0; index < template.segments.length; index += 1) {
    const pool = buildAnimationPool(categoryPreset, template, index);
    const next = categoryPreset.rules.avoidBackToBackSameAnimation
      ? pickWithoutImmediateRepeat(pool, previous)
      : pickRandom(pool);
    selected.push(next);
    previous = next;
  }

  return selected;
}

function selectTransitions(categoryPreset, transitionCount) {
  const pool = categoryPreset.transitionPool.map(normalizeKey);
  const selected = [];
  let previous = "";
  let aggressiveCount = 0;

  for (let index = 0; index < transitionCount; index += 1) {
    let candidates = pool.filter((item) => item !== previous);

    if (aggressiveCount >= categoryPreset.rules.maxAggressiveTransitions) {
      candidates = candidates.filter((item) => !AGGRESSIVE_TRANSITIONS.has(item));
    }

    if (!candidates.length) {
      candidates = pool;
    }

    const picked = pickRandom(candidates);
    if (AGGRESSIVE_TRANSITIONS.has(picked)) {
      aggressiveCount += 1;
    }
    selected.push(picked);
    previous = picked;
  }

  return selected;
}

function selectAudioProfile(categoryPreset) {
  return {
    music:
      categoryPreset.musicPool.length > 0
        ? pickRandom(categoryPreset.musicPool)
        : null,
    voice:
      categoryPreset.voicePool.length > 0
        ? pickRandom(categoryPreset.voicePool)
        : null,
  };
}

function buildRenderPlan(categoryPreset, template) {
  const animations = selectAnimations(categoryPreset, template);
  const transitions = selectTransitions(
    categoryPreset,
    Math.max(0, template.segments.length - 1),
  );
  const audio = selectAudioProfile(categoryPreset);

  return {
    categoryId: categoryPreset.id,
    categoryName: categoryPreset.name,
    pace: categoryPreset.rules.pace,
    animations,
    transitions,
    music: audio.music,
    voice: audio.voice,
    scenes: template.segments.map((segment, index) => ({
      index,
      duration: segment.duration,
      animation: animations[index],
      transitionOut: transitions[index] || null,
    })),
  };
}

module.exports = {
  buildRenderPlan,
  normalizeKey,
};
