const fs = require("fs/promises");
const path = require("path");
const { uploadVideoBufferToCloudinary } = require("../../services/cloudnaryService");
const { getCategoryPreset } = require("./categoryPresetService");
const { buildRenderPlan } = require("./reelDecisionService");
const { getTemplate } = require("./templateService");
const { extendTemplateForPoster } = require("./templatePosterService");
const { resolveImagePaths } = require("./imageInputService");
const {
  assertFfmpegAvailable,
  renderReelVideo,
  mixAudioIntoVideo,
  applyTextOverlayToVideo,
} = require("./ffmpegService");
const { resolveMusicPath, isHttpUrl } = require("./musicInputService");
const { resolveVoicePath } = require("./voiceInputService");
const { generateSpeechToFile } = require("./elevenLabsService");
const { resolveElevenLabsVoiceId } = require("../config/voiceMap");
const {
  resolveNarrationText,
  shouldGenerateVoice,
  shouldUseElevenLabs,
} = require("./narrationService");
const {
  buildTextOverlayPlan,
  writeTextOverlayAssets,
} = require("./reelTextOverlayService");
const {
  cleanupJobWorkspace,
  createJobId,
  createJobWorkspace,
  ensureReelDirectories,
  saveVideoCopy,
} = require("./reelStorageService");

function padImageSources(imagePaths, targetCount) {
  if (imagePaths.length >= targetCount) {
    return imagePaths.slice(0, targetCount);
  }

  const padded = [...imagePaths];
  while (padded.length < targetCount) {
    padded.push(imagePaths[imagePaths.length - 1]);
  }
  return padded;
}

function matchVoicePoolEntry(voicePool, voiceKey) {
  const trimmed = String(voiceKey || "").trim();
  if (!trimmed) {
    return null;
  }

  const normalize = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "_");

  return (
    voicePool.find((entry) => {
      const entryTrimmed = String(entry).trim();
      if (isHttpUrl(entryTrimmed) || isHttpUrl(trimmed)) {
        return entryTrimmed === trimmed;
      }
      return normalize(entryTrimmed) === normalize(trimmed);
    }) || null
  );
}

async function generateReel({
  templateId,
  categoryId,
  imageUrls = [],
  uploadedFiles = [],
  durationOverride,
  shopName,
  offer,
  clientName,
  phoneNumber,
  offerText,
  voiceScript,
  enableVoice,
  voiceId,
  voiceKey,
  voiceUrl,
  textStyle,
  sticker,
  posterUrl,
  posterFile,
}) {
  await ensureReelDirectories();
  await assertFfmpegAvailable();

  const template = await getTemplate(templateId);
  const categoryPreset = await getCategoryPreset(categoryId);
  const resolvedTemplate =
    typeof durationOverride === "number" &&
    Number.isFinite(durationOverride) &&
    durationOverride > 0
      ? {
          ...template,
          duration: durationOverride,
          segments: template.segments.map((segment) => ({
            ...segment,
            duration:
              (segment.duration / template.expectedDuration) * durationOverride,
            frames: Math.max(
              1,
              Math.round(
                ((segment.duration / template.expectedDuration) *
                  durationOverride *
                  template.fps),
              ),
            ),
          })),
          expectedDuration: durationOverride,
        }
      : template;

  const hasPoster = Boolean(
    (typeof posterUrl === "string" && posterUrl.trim()) || posterFile,
  );
  const templateForRender = hasPoster
    ? extendTemplateForPoster(resolvedTemplate)
    : resolvedTemplate;

  const renderPlan = buildRenderPlan(categoryPreset, templateForRender);
  const customVoiceUrl =
    typeof voiceUrl === "string" && isHttpUrl(voiceUrl) ? voiceUrl.trim() : null;
  const matchedVoice = matchVoicePoolEntry(categoryPreset.voicePool, voiceKey);

  if (customVoiceUrl) {
    renderPlan.voice = customVoiceUrl;
  } else if (matchedVoice) {
    renderPlan.voice = String(matchedVoice).trim();
  }
  const preparedTemplate = {
    ...templateForRender,
    segments: templateForRender.segments.map((segment, index) => ({
      ...segment,
      animation:
        segment.sceneRole === "poster"
          ? "static"
          : renderPlan.animations[index] || segment.animation,
      transition: renderPlan.transitions[index] || null,
    })),
  };
  renderPlan.posterIncluded = hasPoster;

  const jobId = createJobId();
  const jobDir = await createJobWorkspace(jobId);

  try {
    const imagePaths = await resolveImagePaths({
      jobDir,
      imageUrls,
      uploadedFiles,
      posterUrl: hasPoster ? posterUrl : undefined,
      posterFile: hasPoster ? posterFile : undefined,
    });

    const segmentCount = preparedTemplate.segments.length;
    const preparedImages = padImageSources(imagePaths, segmentCount);
    const silentVideoPath = path.join(jobDir, "silent.mp4");
    const withTextPath = path.join(jobDir, "with-text.mp4");
    const withAudioPath = path.join(jobDir, "with-audio.mp4");

    await renderReelVideo({
      template: preparedTemplate,
      imagePaths: preparedImages,
      outputPath: silentVideoPath,
    });

    const overlayPlan = buildTextOverlayPlan({
      clientName,
      phoneNumber,
      offerText,
      shopName,
      offer,
      textStyle,
      sticker,
    });
    let videoForAudio = silentVideoPath;

    if (overlayPlan.enabled) {
      const overlayAssets = await writeTextOverlayAssets({
        jobDir,
        template: preparedTemplate,
        overlayPlan,
      });
      await applyTextOverlayToVideo({
        videoPath: silentVideoPath,
        overlayFramePattern: overlayAssets.framePattern,
        overlayFps: overlayAssets.fps,
        outputPath: withTextPath,
        duration: preparedTemplate.duration,
      });
      videoForAudio = withTextPath;
      renderPlan.textOverlay = {
        clientName: overlayPlan.clientName,
        offerText: overlayPlan.offerText,
        phoneNumber: overlayPlan.phoneNumber,
        style: overlayPlan.style,
      };
      renderPlan.sticker = overlayPlan.sticker
        ? {
            id: overlayPlan.sticker.id,
            text: overlayPlan.sticker.text,
            x: overlayPlan.sticker.x,
            y: overlayPlan.sticker.y,
            scale: overlayPlan.sticker.scale,
          }
        : null;
    }

    let musicPath = null;
    if (renderPlan.music) {
      musicPath = await resolveMusicPath({
        jobDir,
        musicRef: renderPlan.music,
      });
    }

    let voicePath = null;
    const narrationText = resolveNarrationText({
      voiceScript,
      shopName: shopName || clientName,
      offer: offer || offerText,
    });
    const wantsVoice = shouldGenerateVoice({
      enableVoice,
      voiceScript,
      shopName: shopName || clientName,
      offer: offer || offerText,
    });
    const useElevenLabs = shouldUseElevenLabs({
      enableVoice,
      voiceScript,
      shopName: shopName || clientName,
      offer: offer || offerText,
    });

    if (wantsVoice) {
      const fileVoicePath = await resolveVoicePath({
        jobDir,
        voiceRef: renderPlan.voice,
      });

      if (fileVoicePath) {
        voicePath = fileVoicePath;
        renderPlan.voiceSource = isHttpUrl(renderPlan.voice) ? "url" : "file";
        renderPlan.voiceAsset = renderPlan.voice;
      } else if (useElevenLabs) {
        if (!narrationText) {
          throw new Error("Voice narration text could not be resolved.");
        }

        const elevenLabsVoiceId = resolveElevenLabsVoiceId(
          renderPlan.voice,
          voiceId,
        );
        const voiceOutputPath = path.join(jobDir, "voice.mp3");
        await generateSpeechToFile({
          text: narrationText,
          voiceId: elevenLabsVoiceId,
          outputPath: voiceOutputPath,
        });
        voicePath = voiceOutputPath;
        renderPlan.voiceSource = "elevenlabs";
        renderPlan.voiceScript = narrationText;
        renderPlan.elevenLabsVoiceId = elevenLabsVoiceId;
      } else {
        const error = new Error(
          `Voice file "${renderPlan.voice}" not found. Add it to uploads/reels/voice/ (e.g. ${renderPlan.voice}.mp3) or provide shop/offer for ElevenLabs.`,
        );
        error.statusCode = 400;
        throw error;
      }
    }

    let finalVideoPath = videoForAudio;
    if (musicPath || voicePath) {
      await mixAudioIntoVideo({
        videoPath: videoForAudio,
        musicPath,
        voicePath,
        outputPath: withAudioPath,
        duration: preparedTemplate.duration,
      });
      finalVideoPath = withAudioPath;
    }

    const videoBuffer = await fs.readFile(finalVideoPath);
    await saveVideoCopy(jobId, finalVideoPath);

    const uploaded = await uploadVideoBufferToCloudinary(videoBuffer, `${jobId}.mp4`);

    return {
      success: true,
      video: uploaded.videoUrl,
      templateId: preparedTemplate.id,
      categoryId: categoryPreset.id,
      duration: preparedTemplate.duration,
      jobId,
      publicId: uploaded.publicId,
      decisions: renderPlan,
    };
  } finally {
    await cleanupJobWorkspace(jobId);
  }
}

module.exports = {
  generateReel,
};
