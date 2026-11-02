function redactText(text, maxChars = 64) {
  if (typeof text !== "string") {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()}…`;
}

function sanitiseForStorage(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  const clone = { ...value };
  delete clone.text;
  delete clone.source;
  if (typeof clone.preview === "string") {
    clone.preview = redactText(clone.preview, 64);
  }
  return clone;
}

function secureErase(buffer) {
  if (Buffer.isBuffer(buffer)) {
    buffer.fill(0);
  }
  return buffer;
}

module.exports = { redactText, sanitiseForStorage, secureErase };
