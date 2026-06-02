async function pollFalQueueResult(modelId, requestId) {
  const apiKey = String(process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
  const timeoutMs = Number(process.env.POSTER_AI_FAL_TIMEOUT_MS || 120000);
  const pollIntervalMs = Number(process.env.POSTER_AI_FAL_POLL_MS || 2000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const statusResponse = await fetch(
      `https://queue.fal.run/${modelId}/requests/${requestId}/status`,
      {
        headers: { Authorization: `Key ${apiKey}` },
      }
    );

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text();
      throw new Error(`fal.ai queue status error (${statusResponse.status}): ${errorText}`);
    }

    const statusPayload = await statusResponse.json();
    if (statusPayload.status === "COMPLETED") {
      const resultResponse = await fetch(
        `https://queue.fal.run/${modelId}/requests/${requestId}`,
        { headers: { Authorization: `Key ${apiKey}` } }
      );

      if (!resultResponse.ok) {
        const errorText = await resultResponse.text();
        throw new Error(`fal.ai queue result error (${resultResponse.status}): ${errorText}`);
      }

      return resultResponse.json();
    }

    if (["FAILED", "CANCELLED"].includes(statusPayload.status)) {
      throw new Error(`fal.ai request ${statusPayload.status.toLowerCase()}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("fal.ai request timed out.");
}

async function callFalModel(modelId, input) {
  const apiKey = String(process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("FAL_KEY is not configured on the server.");
  }

  const response = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fal.ai request error (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (payload.request_id) {
    return pollFalQueueResult(modelId, payload.request_id);
  }

  return payload;
}

function extractImageUrlFromFalResponse(payload) {
  const data = payload?.response || payload?.data || payload;
  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("fal.ai returned no image in the response.");
  }
  return imageUrl;
}

async function downloadImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function isAiProviderConfigured() {
  return Boolean(String(process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim());
}

function getFalApiKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
}

module.exports = {
  callFalModel,
  extractImageUrlFromFalResponse,
  downloadImageBuffer,
  isAiProviderConfigured,
  getFalApiKey,
};
