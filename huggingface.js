const INFERENCE_URL = "https://router.huggingface.co/v1/chat/completions";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_GENERATION_DURATION_MS = 4 * 60 * 1000;
const MAX_OUTPUT_CHARACTERS = 64 * 1024;

async function readJsonResponse(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Hugging Face response exceeded the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Hugging Face returned an empty response.");
  const chunks = [];
  let responseBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    responseBytes += value.byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Hugging Face response exceeded the size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Hugging Face returned an invalid response.");
  }
}

async function runHuggingFaceGeneration({ jobId, prompt, signal, fetchImpl = fetch }) {
  const token = process.env.HF_TOKEN;
  const model = process.env.HF_MODEL;
  if (!token || !model) {
    throw new Error("Hugging Face Inference Providers requires HF_TOKEN and HF_MODEL.");
  }
  if (typeof prompt !== "string" || Buffer.byteLength(prompt, "utf8") === 0 ||
    Buffer.byteLength(prompt, "utf8") > 64 * 1024) {
    throw new Error("Prompt must contain 1–64 KiB of text.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_GENERATION_DURATION_MS);
  const abortRequest = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortRequest, { once: true });

  try {
    const response = await fetchImpl(INFERENCE_URL, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": jobId
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.7,
        stream: false
      })
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      if (response.status === 503) {
        throw new Error("Hugging Face inference is temporarily unavailable; the job may be retried.");
      }
      throw new Error("Hugging Face inference request failed.");
    }
    const generatedText = body?.choices?.[0]?.message?.content;
    if (typeof generatedText !== "string" || !generatedText.trim() ||
      generatedText.length > MAX_OUTPUT_CHARACTERS) {
      throw new Error("Hugging Face did not return valid generated text.");
    }
    return {
      generatedText,
      model,
      worker: "huggingface-inference",
      executionMode: "external",
      provider: "Hugging Face Inference Providers"
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Hugging Face inference exceeded its time limit or was cancelled.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortRequest);
  }
}

module.exports = { INFERENCE_URL, MAX_GENERATION_DURATION_MS, runHuggingFaceGeneration };
