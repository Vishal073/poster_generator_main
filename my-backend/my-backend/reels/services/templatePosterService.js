function extendTemplateForPoster(template) {
  const posterDuration = 2.5;
  const productDuration = Math.max(template.duration - posterDuration, template.duration * 0.7);
  const scale = productDuration / template.expectedDuration;

  const productSegments = template.segments.map((segment, index) => ({
    ...segment,
    index,
    duration: segment.duration * scale,
    frames: Math.max(1, Math.round(segment.duration * scale * template.fps)),
  }));

  const posterSegment = {
    index: productSegments.length,
    duration: template.duration - productDuration,
    animation: "static",
    sceneRole: "poster",
    transition: null,
    frames: Math.max(
      1,
      Math.round((template.duration - productDuration) * template.fps),
    ),
  };

  return {
    ...template,
    segments: [...productSegments, posterSegment],
    expectedDuration: template.duration,
  };
}

module.exports = {
  extendTemplateForPoster,
};
