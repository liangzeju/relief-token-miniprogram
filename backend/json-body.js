"use strict";

const DEFAULT_LIMIT = 2 * 1024 * 1024;
const MAX_LIMIT = 8 * 1024 * 1024;
function readJsonBody(req, limit = DEFAULT_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return Promise.reject(new TypeError("Invalid body limit"));
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const timer = setTimeout(() => fail(408, "BODY_TIMEOUT", "请求内容接收超时"), 30000);
    timer.unref();
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.removeListener("data", onData); req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted); req.removeListener("error", onError);
      chunks = [];
      if (error) {
        // Drain rejected requests without retaining their bytes or destroying the
        // socket before the HTTP layer can return a stable error response.
        req.once("error", () => {}); req.resume(); reject(error);
      } else resolve(value);
    }
    function fail(status, code, message) { finish(Object.assign(new Error(message), { status, code })); }
    function onData(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) { fail(413, "BODY_TOO_LARGE", "请求内容超过大小限制"); return; }
      chunks.push(bytes);
    }
    function onEnd() {
      try {
        const bytes = Buffer.concat(chunks, size);
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        finish(null, text ? JSON.parse(text) : {});
      } catch { fail(400, "INVALID_JSON", "请求须为有效 UTF-8 JSON"); }
    }
    function onAborted() { fail(400, "BODY_ABORTED", "请求内容接收中断"); }
    function onError() { fail(400, "BODY_READ_FAILED", "请求内容读取失败"); }
    req.on("data", onData); req.once("end", onEnd); req.once("aborted", onAborted); req.once("error", onError);
    if (req.aborted || req.destroyed || req.readableEnded) { onAborted(); return; }
    const length = req.headers?.["content-length"], encoding = req.headers?.["content-encoding"];
    if (encoding && encoding !== "identity") { fail(415, "BODY_ENCODING_UNSUPPORTED", "暂不支持压缩请求内容"); return; }
    if (length !== undefined) {
      if (typeof length !== "string" || !/^(0|[1-9][0-9]*)$/.test(length)) { fail(400, "INVALID_CONTENT_LENGTH", "请求长度无效"); return; }
      if (BigInt(length) > BigInt(limit)) fail(413, "BODY_TOO_LARGE", "请求内容超过大小限制");
    }
  });
}

module.exports = { readJsonBody };
