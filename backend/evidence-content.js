"use strict";

const crypto = require("node:crypto");

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const signatures = {
  "image/png": Buffer.from("89504e470d0a1a0a", "hex"),
  "image/jpeg": Buffer.from("ffd8ff", "hex"),
  "application/pdf": Buffer.from("%PDF-", "ascii")
};

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function validateFilename(filename, mimeType) {
  if (typeof filename !== "string" || !filename.isWellFormed() || !filename.trim() || filename.length > 120 ||
      /[\\/:<>"|?*\p{Cc}\p{Cf}]/u.test(filename) || /[. ]$/.test(filename)) fail("INVALID_EVIDENCE_FILENAME");
  const extensions = { "image/png": /\.png$/i, "image/jpeg": /\.jpe?g$/i, "application/pdf": /\.pdf$/i };
  if (typeof mimeType !== "string" || !Object.hasOwn(extensions, mimeType)) fail("INVALID_EVIDENCE_MIME_TYPE");
  if (!extensions[mimeType].test(filename)) fail("INVALID_EVIDENCE_FILENAME");
}
function validateContent(content, mimeType) {
  if (typeof mimeType !== "string" || !Object.hasOwn(signatures, mimeType)) fail("INVALID_EVIDENCE_MIME_TYPE");
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_EVIDENCE_BYTES) fail("INVALID_EVIDENCE_SIZE");
  const signature = signatures[mimeType];
  // Signature matching is format identification, not parsing or malware scanning.
  if (!content.subarray(0, signature.length).equals(signature)) fail("EVIDENCE_MIME_MISMATCH");
}
function decodeEvidence(contentBase64, mimeType) {
  if (typeof contentBase64 !== "string" || !contentBase64.length ||
      contentBase64.length > 4 * Math.ceil(MAX_EVIDENCE_BYTES / 3) || contentBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) fail("INVALID_EVIDENCE_BASE64");
  const content = Buffer.from(contentBase64, "base64");
  if (content.toString("base64") !== contentBase64) fail("INVALID_EVIDENCE_BASE64");
  validateContent(content, mimeType);
  return content;
}

module.exports = { MAX_EVIDENCE_BYTES, sha256, validateFilename, validateContent, decodeEvidence };
