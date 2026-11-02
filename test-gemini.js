require("dotenv").config();

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

if (!apiKey) {
  console.error("GEMINI_API_KEY is missing from .env.");
  process.exit(1);
}

if (!/^[A-Za-z0-9._-]+$/.test(model)) {
  console.error("GEMINI_MODEL must be a model name without a path.");
  process.exit(1);
}

async function main() {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hello, confirm connection!" }] }]
      }),
      signal: AbortSignal.timeout(90_000)
    }
  );
  const result = await response.json();

  if (!response.ok) {
    console.error(`Gemini API request failed with HTTP ${response.status}.`);
    if (result.error?.message) console.error(result.error.message);
    process.exitCode = 1;
    return;
  }

  const text = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!text) {
    console.error("Gemini returned no generated text.");
    process.exitCode = 1;
    return;
  }

  console.log(`Gemini API connection succeeded (${model}).`);
  console.log(text);
}

main().catch((error) => {
  console.error(`Gemini API request failed: ${error.message}`);
  process.exitCode = 1;
});
