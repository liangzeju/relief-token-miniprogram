"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { fixture, evidencePng } = require("./helpers/fulfillment-fixture.cjs");

test("private original attachments are required and bound to the authenticated batch, phase and version", { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const input = { id: "E-HTTP", contractVersion: 1, batchId: "B-E", method: "deliverBatch", filename: "现场照片.png", mimeType: "image/png", contentBase64: evidencePng.toString("base64") };
  const uploadPath = "/v1/platform/contracts/C-F/evidence";
  const post = (actor, body = input, key = crypto.randomUUID()) => f.request(actor, uploadPath, body, key);
  await t.test("unlocked contracts, unauthenticated users, admin and other organizations cannot upload", async () => {
    for (const actor of [null, f.admin, f.finance, f.outsider]) assert.ok([401, 403].includes((await post(actor)).status));
    assert.equal((await post(f.supplier)).json.error.code, "FUNDS_RESERVED_REQUIRED");
    assert.equal((await f.read()).batches.length, 0);
  });
  f.seedLock();
  let evidence;
  await t.test("upload persists exact bytes with server-derived actor and idempotency without changing business version", async () => {
    const version = (await f.read()).version;
    evidence = f.data(await post(f.supplier, input, "stable-upload"), 201);
    assert.equal(evidence.sha256, crypto.createHash("sha256").update(evidencePng).digest("hex"));
    assert.equal(evidence.sizeBytes, evidencePng.length); assert.equal(evidence.actor.id, f.supplier.user.id);
    assert.equal(evidence.filename, input.filename); assert.equal((await f.read()).version, version);
    const repeated = await post(f.supplier, input, "stable-upload"); f.data(repeated, 201); assert.equal(repeated.json.replayed, true);
    assert.equal((await post(f.supplier, { ...input, filename: "changed.png" }, "stable-upload")).json.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await post(f.supplier, { ...input, actor: { id: "pretend" } })).status, 400);
  });
  await t.test("downloads are scoped attachments, not executable inline or anonymously published data", async () => {
    const url = f.base + "/v1/platform/evidence/" + evidence.id + "/content";
    for (const actor of [f.supplier, f.acceptance, f.admin]) {
      const response = await fetch(url, { headers: { Cookie: actor.cookie, ...(actor.admin ? { "X-Relief-Actor": "admin" } : {}) } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/octet-stream");
      assert.match(response.headers.get("content-disposition"), /^attachment;/);
      assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy"), /sandbox/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-sha256"), evidence.sha256);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), evidencePng);
    }
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie: f.outsider.cookie } })).status, 403);
    assert.equal((await fetch(f.base + "/data/platform.sqlite")).status, 404);
    assert.ok(!JSON.stringify(f.data(await f.request(null, "/v1/platform/catalog"))).includes(evidence.filename));
  });
  await t.test("bad MIME, filenames, version, base64, role and size cannot become attachments", async () => {
    for (const patch of [{ mimeType: "text/html" }, { filename: "../outside.png" }, { filename: "bad\r\nheader.png" }, { filename: "payload.ps1" }, { contentBase64: "%%%" }, { mimeType: "application/pdf" }, { contractVersion: 2 }]) {
      assert.notEqual((await post(f.supplier, { ...input, id: crypto.randomUUID(), ...patch })).status, 201);
    }
    assert.equal((await post(f.acceptance, { ...input, id: "E-WRONG" })).status, 403);
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 0); evidencePng.copy(bytes);
    assert.notEqual((await post(f.supplier, { ...input, id: "E-LARGE", contentBase64: bytes.toString("base64") })).status, 201);
    const huge = await post(f.supplier, { ...input, id: "E-JSON-LARGE", contentBase64: "A".repeat(8 * 1024 * 1024) });
    assert.equal(huge.status, 413); assert.equal(huge.json.error.code, "BODY_TOO_LARGE");
  });
  const delivery = { id: "B-E", contractId: "C-F", quantity: 2, statement: "Two water cases delivered with batch photographs." };
  await t.test("text alone or foreign-batch evidence cannot advance delivery, while matching originals bind atomically", async () => {
    assert.equal((await f.mutate(f.supplier, "/v1/platform/deliveries", delivery)).json.error.code, "EVIDENCE_REQUIRED");
    assert.notEqual((await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, id: "B-WRONG", evidenceIds: [evidence.id] })).status, 201);
    assert.equal((await f.read()).batches.length, 0);
    f.data(await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, evidenceIds: [evidence.id] }), 201);
    const records = f.data(await f.request(f.acceptance, "/v1/platform/contracts/C-F/attestations"));
    assert.equal(records.length, 1); assert.deepEqual(records[0].evidence.map(item => item.id), [evidence.id]);
  });
  await t.test("acceptance must have its own original attachments, cannot borrow a supplier's file", async () => {
    const assessment = { outcome: "ACCEPTED", acceptedQuantity: 2, statement: "Count and packaging checked against contract." };
    assert.equal((await f.mutate(f.acceptance, "/v1/platform/batches/B-E/acceptance", assessment)).json.error.code, "EVIDENCE_REQUIRED");
    assert.notEqual((await f.mutate(f.acceptance, "/v1/platform/batches/B-E/acceptance", { ...assessment, evidenceIds: [evidence.id] })).status, 201);
    const acceptedEvidence = await f.upload(f.acceptance, "B-E", "acceptBatch", { filename: "acceptance.png" });
    f.data(await f.mutate(f.acceptance, "/v1/platform/batches/B-E/acceptance", { ...assessment, evidenceIds: [acceptedEvidence.id] }), 201);
    const payable = f.data(await f.mutate(f.finance, "/v1/platform/batches/B-E/payable", {}), 201);
    assert.equal(payable.amountWei, "24000000000000000002"); assert.equal((await f.read()).payments.length, 0);
  });
  await t.test("revoked user cannot download original materials even with a known URL", async () => {
    f.data(await f.request(f.admin, `/v1/platform/operators/${f.supplier.user.id}/revoke`, {}));
    const response = await fetch(f.base + "/v1/platform/evidence/" + evidence.id + "/content", { headers: { Cookie: f.supplier.cookie } });
    assert.equal(response.status, 403);
  });
  await t.test("original content corruption prevents download and subsequent financial preparation", async () => {
    const raw = new DatabaseSync(f.file);
    try { raw.prepare("UPDATE procurement_evidence SET content=? WHERE id=?").run(Buffer.from("tampered original"), evidence.id); }
    finally { raw.close(); }
    const response = await fetch(f.base + "/v1/platform/evidence/" + evidence.id + "/content", { headers: { Cookie: f.finance.cookie } });
    assert.notEqual(response.status, 200);
    assert.notEqual((await f.request(f.finance, "/v1/platform/contracts/C-F/attestations")).status, 200);
    assert.notEqual((await f.mutate(f.finance, "/v1/platform/batches/B-E/payable", {})).status, 201);
  });
});
