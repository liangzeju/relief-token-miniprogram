"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");
const { readJsonBody } = require("../json-body");
function request(headers = {}) { const req = new PassThrough(); req.headers = headers; return req; }

test("JSON preserves UTF-8 characters split across every byte boundary", async () => {
  const input = { text: "救援交付与验收\ud83d\udc9a", amountWei: "12000000000000000001" };
  const bytes = Buffer.from(JSON.stringify(input));
  for (let split = 1; split < bytes.length; split++) {
    const req = request(), result = readJsonBody(req);
    req.write(bytes.subarray(0, split)); req.end(bytes.subarray(split));
    assert.deepEqual(await result, input);
  }
});
test("byte limits count UTF-8 bytes, including requests without a Content-Length header", async () => {
  const req = request(), result = readJsonBody(req, 5);
  req.end('"救援"'); await assert.rejects(result, { status: 413, code: "BODY_TOO_LARGE" });
});
test("oversized declared length fails before retaining request data", async () => {
  const req = request({ "content-length": "9999999999999999999999999999" });
  const result = readJsonBody(req); req.end("{}");
  await assert.rejects(result, { status: 413, code: "BODY_TOO_LARGE" });
});
test("empty requests retain compatibility, invalid JSON and invalid UTF-8 do not", async () => {
  for (const bytes of [Buffer.from("{"), Buffer.from([0x22, 0xc3, 0x28, 0x22])]) {
    const req = request(), result = readJsonBody(req); req.end(bytes);
    await assert.rejects(result, { status: 400, code: "INVALID_JSON" });
  }
  const req = request(), result = readJsonBody(req); req.end(); assert.deepEqual(await result, {});
});
test("aborted and failed streams settle rather than waiting indefinitely", async () => {
  for (const event of ["aborted", "error"]) {
    const req = request(), result = readJsonBody(req); req.emit(event, new Error("interrupted"));
    await assert.rejects(result, { status: 400, code: event === "aborted" ? "BODY_ABORTED" : "BODY_READ_FAILED" });
    req.end();
  }
});
test("compressed requests and invalid length declarations fail explicitly", async () => {
  for (const [headers, code] of [[{ "content-encoding": "gzip" }, "BODY_ENCODING_UNSUPPORTED"], [{ "content-length": "-1" }, "INVALID_CONTENT_LENGTH"]]) {
    const req = request(headers), result = readJsonBody(req); req.end("{}");
    await assert.rejects(result, { code });
  }
});
test("upload route may request 8 MiB while ordinary JSON retains 2 MiB default", async () => {
  const bytes = Buffer.from(JSON.stringify({ payload: "a".repeat(2 * 1024 * 1024) }));
  const upload = request(), result = readJsonBody(upload, 8 * 1024 * 1024); upload.end(bytes);
  assert.equal((await result).payload.length, 2 * 1024 * 1024);
  const ordinary = request(), rejected = readJsonBody(ordinary); ordinary.end(bytes);
  await assert.rejects(rejected, { code: "BODY_TOO_LARGE" });
});
