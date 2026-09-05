"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");
const { createProcurementStore } = require("../procurement-store");

const pool = "0x" + "11".repeat(20), supplier = Wallet.createRandom(), buyer = Wallet.createRandom();
const deliveryActor = { id: "delivery-1", organizationId: "supplier-org", wallet: supplier.address, role: "delivery" };
const acceptanceActor = { id: "inspector-1", organizationId: "inspection-org", wallet: Wallet.createRandom().address, role: "acceptance" };
const document = { termsText: "Deliver ten cases.", acceptanceText: "Inspect and count cases." };
const delivery = { id: "b1", contractId: "c1", quantity: 5, actor: deliveryActor };
const acceptance = { batchId: "b1", outcome: "ACCEPTED", acceptedQuantity: 5, actor: acceptanceActor };
const note = { statement: "Written statement about this batch." };
const MAX_BYTES = 5 * 1024 * 1024;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVb8AAAAASUVORK5CYII=", "base64");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const keccak = value => keccak256(toUtf8Bytes(value));
const normalizedActor = actor => ({ ...actor, wallet: actor.wallet.toLowerCase() });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-procurement-evidence-"));
  const file = path.join(dir, "platform.sqlite"), stores = [], connections = [];
  const open = () => {
    const store = createProcurementStore({ file, escrowContract: pool, clock: () => 123456789 });
    stores.push(store); return store;
  };
  const raw = () => { const db = new DatabaseSync(file); connections.push(db); return db; };
  t.after(() => {
    stores.forEach(store => store.close()); connections.forEach(db => db.close());
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("relief-procurement-evidence-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, open, raw };
}
function write(store, method, input, options = {}) {
  return store.execute({ method, input, actorId: input.actor ? input.actor.id : "operator",
    idempotencyKey: crypto.randomUUID(), expectedVersion: store.read().version, ...options });
}
async function contract(store, id = "c1", fund = true) {
  const quoteId = `${id}-quote`, reservationId = `${id}-reservation`;
  write(store, "addQuote", { id: quoteId, resourceId: "WATER", supplierOrganizationId: "supplier-org", supplierWallet: supplier.address,
    unitPriceWei: "12", availableQuantity: 10, validUntil: 5000, etaHours: 3 });
  write(store, "reserve", { id: reservationId, quoteId, taskId: "TASK-1", quantity: 10,
    buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now: 1000 });
  write(store, "createContract", { id, reservationId, termsHash: keccak(document.termsText), acceptanceCriteriaHash: keccak(document.acceptanceText),
    nonce: String(store.read().version), expiresAt: 4000, now: 1000 }, { document });
  const typed = store.getTypedData(id).data;
  for (const [party, signer] of [["buyer", buyer], ["supplier", supplier]]) {
    const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
    write(store, "signContract", { contractId: id, version: 1, party, signature, now: 1000 });
  }
  if (fund) lock(store, id);
}
function lock(store, id = "c1") {
  // Local trusted funding fixture; never submitted to a node or asserted as a production event.
  const txHash = keccak(`local funding fixture ${id}`), escrowBusinessId = `${id}-escrow`;
  write(store, "recordEscrowConfirmed", { contractId: id, version: 1, escrowBusinessId, txHash,
    receipt: { status: 1, transactionHash: txHash, chainId: "10143", escrowContract: pool, value: "120",
      escrowBusinessId, contractId: id, contractVersion: 1 } });
}
function input(overrides = {}) {
  return { id: "e1", contractId: "c1", contractVersion: 1, batchId: "b1", method: "deliverBatch",
    filename: "original.png", mimeType: "image/png", contentBase64: png.toString("base64"), ...overrides };
}
function upload(store, overrides = {}, actor = deliveryActor, idempotencyKey = overrides.id || "e1") {
  return store.putEvidence({ input: input(overrides), actor, idempotencyKey });
}
function attach(store, method = "deliverBatch", ids = ["e1"], overrides = {}) {
  return write(store, method, method === "deliverBatch" ? delivery : acceptance,
    { attestation: { ...note, evidenceIds: ids }, idempotencyKey: method, ...overrides });
}

test("upload returns exact metadata and original Buffer, survives restart without advancing business version", async t => {
  const f = fixture(t); let store = f.open(); await contract(store);
  const before = store.read(), result = upload(store, { filename: "\u539f\u4ef6.png" });
  const metadata = { id: "e1", contractId: "c1", contractVersion: 1, batchId: "b1", method: "deliverBatch",
    filename: "\u539f\u4ef6.png", mimeType: "image/png", sizeBytes: png.length, sha256: hash(png),
    actor: normalizedActor(deliveryActor), createdAt: 123456789 };
  assert.deepEqual(result, { data: metadata, replayed: false });
  assert.deepEqual(store.read(), before);
  assert.deepEqual(store.getEvidenceMetadata("e1"), { data: metadata });
  assert.deepEqual(store.getEvidence("e1"), { data: metadata, content: png });
  assert.ok(Buffer.isBuffer(store.getEvidence("e1").content));
  const copy = store.getEvidence("e1"); copy.content.fill(0); copy.data.actor.id = "forged";
  store.close(); store = f.open();
  assert.deepEqual(store.getEvidence("e1"), { data: metadata, content: png });
  assert.deepEqual(upload(store, { filename: "\u539f\u4ef6.png" }), { data: metadata, replayed: true });
  assert.deepEqual(store.read(), before);
  const raw = f.raw();
  assert.equal(raw.prepare("SELECT typeof(content) AS type FROM procurement_evidence").get().type, "blob");
  assert.equal(raw.prepare("SELECT schema_version FROM procurement_meta").get().schema_version, 3);
  for (const method of ["getEvidence", "getEvidenceMetadata"]) {
    assert.throws(() => store[method]("missing"), { code: "EVIDENCE_NOT_FOUND" });
  }
  store.close();
  for (const method of ["getEvidence", "getEvidenceMetadata"]) assert.throws(() => store[method]("e1"), { code: "STORE_CLOSED" });
  assert.throws(() => upload(store), { code: "STORE_CLOSED" });
});

test("canonical PNG/JPEG/PDF bytes are preserved including binary zeros and the 5 MiB boundary", async t => {
  const store = fixture(t).open(); await contract(store);
  const large = Buffer.alloc(MAX_BYTES, 0); png.copy(large);
  const files = [[png, "image/png", ".PNG"], [Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]), "image/jpeg", ".jpg"],
    [Buffer.from("%PDF-1.7\n\0\xff\n%%EOF", "latin1"), "application/pdf", ".PDF"], [large, "image/png", ".png"],
    [Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]), "image/jpeg", ".JPEG"]];
  for (const [index, [bytes, mimeType, extension]] of files.entries()) {
    const id = `format-${index}`;
    const result = upload(store, { id, mimeType, contentBase64: bytes.toString("base64"), filename: "x".repeat(120 - extension.length) + extension });
    assert.equal(result.data.sha256, hash(bytes)); assert.equal(result.data.sizeBytes, bytes.length);
    assert.deepEqual(store.getEvidence(id).content, bytes);
  }
});

test("invalid base64, sizes, magic, MIME, Unicode filenames, fields, IDs and versions are rejected", async t => {
  const f = fixture(t), store = f.open(); await contract(store); const before = store.read();
  const invalid = [
    { contentBase64: "" }, { contentBase64: "AAAA\n" }, { contentBase64: "AAAA " }, { contentBase64: "AA-_" },
    { contentBase64: "AA" }, { contentBase64: "AB==" }, { contentBase64: "AAA===" }, { contentBase64: "data:image/png;base64,AAAA" },
    { contentBase64: 12 }, { contentBase64: Buffer.alloc(MAX_BYTES + 1).toString("base64") },
    { contentBase64: Buffer.from("plain text").toString("base64") }, { mimeType: "image/jpeg", filename: "wrong.jpg" },
    { mimeType: "application/pdf", filename: "wrong.pdf" }, { mimeType: "image/svg+xml" },
    { mimeType: "image/PNG" }, { mimeType: "application/pdf; charset=utf-8" },
    ...["", " ", ".", "..", "../x.png", "x/y.png", "x\\y.png", "C:x.png", "x\0.png", "x\r\n.png", "x\u0085.png",
      "x\u202e.png", "x\ud800.png", "x\udc00.png", "x".repeat(117) + ".png", "payload.ps1", "payload.html", "wrong.pdf",
      "x.png.", "x.png ", 'x".png', "x<.png", "x>.png", "x|.png", "x?.png", "x*.png"].map(filename => ({ filename })),
    { id: " " }, { id: "x\ud800" }, { batchId: "" }, { contractId: " c1" }, { contractVersion: "1" }, { contractVersion: 0 },
    { method: "resolveDispute" }, { sha256: hash(png) }, { sizeBytes: png.length }, { content: png }
  ];
  for (const value of invalid) assert.throws(() => upload(store, value), `must reject ${JSON.stringify(value).slice(0, 100)}`);
  for (const actor of [null, { ...deliveryActor, role: "acceptance" }, { ...deliveryActor, wallet: "0x00" },
    { ...deliveryActor, id: "" }, { ...deliveryActor, extra: true }]) assert.throws(() => upload(store, {}, actor));
  assert.throws(() => upload(store, {}, deliveryActor, ""), { code: "IDEMPOTENCY_KEY_REQUIRED" });
  assert.deepEqual(store.read(), before);
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM procurement_evidence").get().n, 0);
});

test("upload enforces funding, current version, supplier scope, and draft delivery batch association", async t => {
  const store = fixture(t).open(); await contract(store, "c1", false);
  assert.throws(() => upload(store), { code: "FUNDS_RESERVED_REQUIRED" });
  lock(store);
  assert.throws(() => upload(store, { contractVersion: 2 }), { code: "VERSION_MISMATCH" });
  assert.throws(() => upload(store, { contractId: "missing" }), { code: "NOT_FOUND" });
  assert.throws(() => upload(store, {}, { ...deliveryActor, organizationId: "other", wallet: buyer.address }), { code: "SUPPLIER_SCOPE_REQUIRED" });
  upload(store);
  attach(store);
  assert.throws(() => upload(store, { id: "late" }), { code: "DUPLICATE_ID" });
  assert.equal(upload(store, { id: "draft", batchId: "draft-batch" }).replayed, false);
});

test("acceptance upload requires same-contract DELIVERED batch and domain separation of duties", async t => {
  const store = fixture(t).open(); await contract(store); await contract(store, "c2");
  const acceptFile = { id: "accept-file", method: "acceptBatch" };
  assert.throws(() => upload(store, acceptFile, acceptanceActor), { code: "NOT_FOUND" });
  write(store, "deliverBatch", delivery, { attestation: note });
  assert.throws(() => upload(store, { ...acceptFile, contractId: "c2" }, acceptanceActor), { code: "EVIDENCE_SCOPE_MISMATCH" });
  for (const actor of [
    { ...acceptanceActor, wallet: buyer.address }, { ...acceptanceActor, wallet: supplier.address },
    { ...acceptanceActor, organizationId: "supplier-org" }, { ...acceptanceActor, id: deliveryActor.id }
  ]) assert.throws(() => upload(store, acceptFile, actor), { code: "SEPARATION_OF_DUTIES" });
  upload(store, acceptFile, acceptanceActor);
  attach(store, "acceptBatch", ["accept-file"]);
  assert.throws(() => upload(store, { ...acceptFile, id: "late" }, acceptanceActor), { code: "BATCH_ALREADY_ASSESSED" });
  assert.equal(upload(store, acceptFile, acceptanceActor).replayed, true);
});

test("a finance participant cannot upload acceptance originals for another batch", async t => {
  const store = fixture(t).open(); await contract(store);
  write(store, "deliverBatch", delivery); write(store, "acceptBatch", acceptance);
  const financeActor = { id: "finance-1", organizationId: "finance-org", wallet: Wallet.createRandom().address, role: "finance" };
  write(store, "markPaymentPending", { batchId: "b1", paymentBusinessId: "p1", actor: financeActor, onChainEscrowConfirmed: true });
  write(store, "deliverBatch", { ...delivery, id: "b2" });
  assert.throws(() => upload(store, { method: "acceptBatch", batchId: "b2" }, { ...financeActor, role: "acceptance" }), { code: "SEPARATION_OF_DUTIES" });
});

test("upload idempotency commits to every input and actor field; IDs cannot be overwritten", async t => {
  const store = fixture(t).open(); await contract(store); const first = upload(store);
  assert.deepEqual(upload(store), { ...first, replayed: true });
  for (const changed of [{ id: "e2" }, { contractId: "c2" }, { contractVersion: 2 }, { batchId: "b2" },
    { filename: "renamed.png" }, { contentBase64: Buffer.concat([png, Buffer.from([0])]).toString("base64") }])
    assert.throws(() => upload(store, changed, deliveryActor, "e1"), { code: "IDEMPOTENCY_KEY_REUSED" });
  for (const actor of [{ ...deliveryActor, organizationId: "changed" }, { ...deliveryActor, wallet: buyer.address }])
    assert.throws(() => upload(store, {}, actor), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.throws(() => upload(store, {}, deliveryActor, "other-key"), { code: "EVIDENCE_ID_CONFLICT" });
  assert.throws(() => upload(store, {}, { ...deliveryActor, id: "different-actor" }), { code: "EVIDENCE_ID_CONFLICT" });
  assert.deepEqual(store.getEvidence("e1").content, png);
});

test("100-file quota includes pending uploads and is shared across connections, actors and batch IDs", async t => {
  const f = fixture(t), store = f.open(), other = f.open(); await contract(store); await contract(store, "c2");
  const version = store.read().version;
  for (let index = 0; index < 100; index++) upload(index % 2 ? other : store, { id: `file-${index}`, batchId: `draft-${index}` });
  assert.equal(upload(other, { id: "file-0", batchId: "draft-0" }).replayed, true);
  assert.throws(() => upload(other, { id: "overflow", batchId: "draft-overflow" }, { ...deliveryActor, id: "another-supplier" }), { code: "EVIDENCE_QUOTA_EXCEEDED" });
  assert.equal(upload(other, { id: "different-contract", contractId: "c2" }).replayed, false);
  assert.equal(store.read().version, version);
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM procurement_evidence WHERE contract_id='c1'").get().n, 100);
});

test("50 MiB quota is inclusive and retries do not reserve storage twice", async t => {
  const f = fixture(t), store = f.open(); await contract(store);
  const bytes = Buffer.alloc(MAX_BYTES); png.copy(bytes); const contentBase64 = bytes.toString("base64");
  for (let index = 0; index < 10; index++) upload(store, { id: `large-${index}`, contentBase64 });
  assert.equal(upload(store, { id: "large-0", contentBase64 }).replayed, true);
  assert.throws(() => upload(store, { id: "over-quota" }), { code: "EVIDENCE_QUOTA_EXCEEDED" });
  assert.equal(f.raw().prepare("SELECT sum(size_bytes) AS bytes FROM procurement_evidence").get().bytes, 50 * 1024 * 1024);
});

test("binding returns ordered metadata, persists, and keeps statement-only hashes compatible", async t => {
  const f = fixture(t); let store = f.open(); await contract(store);
  const original = [upload(store), upload(store, { id: "e2" })];
  const delivered = attach(store, "deliverBatch", ["e2", "e1"]);
  const accepted = write(store, "acceptBatch", acceptance, { attestation: note, idempotencyKey: "legacy-accept" });
  const before = store.getAttestations("c1");
  assert.deepEqual(before.data[0].evidence, [original[1].data, original[0].data]);
  assert.deepEqual(before.data[1].evidence, []);
  assert.equal(before.version, accepted.version);
  store.close(); store = f.open(); assert.deepEqual(store.getAttestations("c1"), before);
  assert.deepEqual(attach(store, "deliverBatch", ["e2", "e1"], { expectedVersion: 0 }), { ...delivered, replayed: true });
  assert.deepEqual(write(store, "acceptBatch", acceptance, { attestation: note, idempotencyKey: "legacy-accept", expectedVersion: 0 }), { ...accepted, replayed: true });
  for (const evidenceIds of [["e1", "e2"], ["e1"]])
    assert.throws(() => attach(store, "deliverBatch", evidenceIds), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.throws(() => write(store, "deliverBatch", delivery, { attestation: note, idempotencyKey: "deliverBatch" }), { code: "IDEMPOTENCY_KEY_REUSED" });
});

test("binding rejects malformed ID lists, missing files and incorrect associations without partial writes", async t => {
  const f = fixture(t), store = f.open(); await contract(store); await contract(store, "c2");
  upload(store);
  upload(store, { id: "other-contract", contractId: "c2" });
  upload(store, { id: "other-batch", batchId: "b2" });
  upload(store, { id: "other-actor" }, { ...deliveryActor, id: "supplier-2" });
  const before = store.read();
  for (const ids of [[], ["e1", "e1"], Array.from({ length: 7 }, (_, i) => `e${i}`), "e1", [""], [undefined], new Array(1)])
    assert.throws(() => attach(store, "deliverBatch", ids));
  assert.throws(() => attach(store, "deliverBatch", ["missing"]), { code: "EVIDENCE_NOT_FOUND" });
  for (const id of ["other-contract", "other-batch", "other-actor"])
    assert.throws(() => attach(store, "deliverBatch", ["e1", id]), { code: "EVIDENCE_SCOPE_MISMATCH" });
  assert.deepEqual(store.read(), before); assert.deepEqual(store.getAttestations("c1").data, []);
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM procurement_attestation_evidence").get().n, 0);
  attach(store);
  const acceptFile = upload(store, { id: "accept-original", method: "acceptBatch" }, acceptanceActor);
  assert.throws(() => attach(store, "acceptBatch", ["other-batch"]), { code: "EVIDENCE_SCOPE_MISMATCH" });
  assert.throws(() => attach(store, "acceptBatch", ["e1"]), { code: "EVIDENCE_ALREADY_BOUND" });
  attach(store, "acceptBatch", ["accept-original"]);
  assert.deepEqual(store.getAttestations("c1").data[1].evidence, [acceptFile.data]);
});

test("six originals bind once and statement-free historical commands still work", async t => {
  const f = fixture(t), store = f.open(); await contract(store);
  const ids = Array.from({ length: 6 }, (_, i) => `e${i}`);
  for (const id of ids) upload(store, { id });
  attach(store, "deliverBatch", ids);
  write(store, "acceptBatch", acceptance);
  assert.equal(store.getAttestations("c1").data[0].evidence.length, 6);
  const raw = f.raw(); raw.exec("PRAGMA foreign_keys=ON");
  assert.throws(() => raw.exec("INSERT INTO procurement_attestation_evidence SELECT * FROM procurement_attestation_evidence LIMIT 1"), /UNIQUE/);
  assert.throws(() => raw.exec("UPDATE procurement_attestation_evidence SET evidence_id='missing' WHERE position=0"), /FOREIGN KEY/);
});

test("failed upload insert rolls back idempotency and quota without changing the business version", async t => {
  const f = fixture(t), store = f.open(); await contract(store); const raw = f.raw(), before = store.read();
  raw.exec("CREATE TRIGGER deny_original BEFORE INSERT ON procurement_evidence BEGIN SELECT RAISE(ABORT,'injected original insert failure'); END");
  assert.throws(() => upload(store), /injected original insert failure/);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_evidence").get().n, 0);
  assert.deepEqual(store.read(), before);
  raw.exec("DROP TRIGGER deny_original");
  assert.equal(upload(store).replayed, false);
});

test("link insert failure rolls back all links, statement, journal and domain state for delivery and acceptance", async t => {
  const f = fixture(t), store = f.open(); await contract(store); const raw = f.raw();
  for (const [method, actor] of [["deliverBatch", deliveryActor], ["acceptBatch", acceptanceActor]]) {
    const ids = [`${method}-one`, `${method}-two`];
    for (const id of ids) upload(store, { id, method }, actor);
    const before = store.read(), statements = store.getAttestations("c1"), links = raw.prepare("SELECT * FROM procurement_attestation_evidence").all();
    raw.exec("CREATE TRIGGER deny_second_link BEFORE INSERT ON procurement_attestation_evidence WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'injected link insert failure'); END");
    assert.throws(() => attach(store, method, ids), /injected link insert failure/);
    assert.deepEqual(store.read(), before); assert.deepEqual(store.getAttestations("c1"), statements);
    assert.deepEqual(raw.prepare("SELECT * FROM procurement_attestation_evidence").all(), links);
    for (const id of ids) assert.deepEqual(store.getEvidence(id).content, png);
    raw.exec("DROP TRIGGER deny_second_link");
    assert.equal(attach(store, method, ids).replayed, false);
  }
});

test("metadata reads verify the upload commitment without exposing or reading corrupted binary data", async t => {
  const f = fixture(t), store = f.open(); await contract(store); const original = upload(store);
  f.raw().prepare("UPDATE procurement_evidence SET content=? WHERE id=?").run(Buffer.concat([png, Buffer.from([255])]), "e1");
  assert.deepEqual(store.getEvidenceMetadata("e1"), { data: original.data });
  assert.throws(() => store.getEvidence("e1"), { code: "EVIDENCE_CONTENT_MISMATCH" });
  assert.throws(() => upload(store), { code: "EVIDENCE_CONTENT_MISMATCH" });
  assert.throws(() => attach(store), { code: "EVIDENCE_CONTENT_MISMATCH" });
  assert.deepEqual(store.getAttestations("c1").data, []);
});

test("metadata changes fail both metadata and content reads before any file can be bound", async t => {
  const updates = [
    ["filename", "renamed.png"], ["filename", "payload.ps1"], ["mime_type", "image/jpeg"], ["size_bytes", png.length + 1],
    ["sha256", "00".repeat(32)], ["contract_id", "different-contract"], ["contract_version", 2], ["batch_id", "different-batch"],
    ["method", "acceptBatch"], ["actor_id", "forged"], ["actor_json", JSON.stringify({ ...normalizedActor(deliveryActor), id: "forged" })],
    ["created_at", 0], ["request_key", "forged-key"], ["request_hash", "forged-hash"]
  ];
  for (const [column, value] of updates) await t.test(`${column}: ${String(value).slice(0, 30)}`, async t => {
    const f = fixture(t), store = f.open(); await contract(store); upload(store);
    f.raw().prepare(`UPDATE procurement_evidence SET ${column}=? WHERE id='e1'`).run(value);
    assert.throws(() => store.getEvidenceMetadata("e1"));
    assert.throws(() => store.getEvidence("e1"));
    assert.throws(() => attach(store));
    assert.equal(store.read().batches.length, 0);
  });
});

test("bound file and link corruption fail closed on reads, command retries and continued business", async t => {
  const mutations = [
    ["raw BLOB update", raw => raw.prepare("UPDATE procurement_evidence SET content=? WHERE id=?").run(Buffer.alloc(png.length), "e1")],
    ["content and digest together", raw => {
      const changed = Buffer.concat([png, Buffer.from([0])]);
      raw.prepare("UPDATE procurement_evidence SET content=?,sha256=?,size_bytes=? WHERE id='e1'").run(changed, hash(changed), changed.length);
    }],
    ["metadata filename", raw => raw.exec("UPDATE procurement_evidence SET filename='forged.png' WHERE id='e1'")],
    ["deleted original", raw => raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM procurement_evidence WHERE id='e1'")],
    ["deleted first link", raw => raw.exec("DELETE FROM procurement_attestation_evidence WHERE evidence_id='e1'")],
    ["deleted last link", raw => raw.exec("DELETE FROM procurement_attestation_evidence WHERE evidence_id='e2'")],
    ["deleted all links", raw => raw.exec("DELETE FROM procurement_attestation_evidence")],
    ["deleted links and originals", raw => raw.exec("DELETE FROM procurement_attestation_evidence; DELETE FROM procurement_evidence")],
    ["replaced link ID", raw => raw.exec("UPDATE procurement_attestation_evidence SET evidence_id='e3' WHERE evidence_id='e1'")],
    ["reordered links", raw => raw.exec("UPDATE procurement_attestation_evidence SET position=5 WHERE position=0; UPDATE procurement_attestation_evidence SET position=0 WHERE position=1; UPDATE procurement_attestation_evidence SET position=1 WHERE position=5")],
    ["orphan command association", raw => raw.exec("PRAGMA foreign_keys=OFF; UPDATE procurement_attestation_evidence SET command_sequence=999 WHERE evidence_id='e1'")],
    ["missing statement", raw => raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM procurement_attestations")]
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const f = fixture(t), store = f.open(); await contract(store);
    for (const id of ["e1", "e2", "e3"]) upload(store, { id });
    attach(store, "deliverBatch", ["e1", "e2"]);
    mutate(f.raw());
    assert.throws(() => store.getAttestations("c1"));
    assert.throws(() => attach(store, "deliverBatch", ["e1", "e2"]));
    assert.throws(() => write(store, "acceptBatch", acceptance, { attestation: note }));
    assert.throws(() => upload(store, { id: "new-upload", batchId: "b2" }));
    assert.equal(store.read().batches[0].status, "DELIVERED");
    store.close(); const restarted = f.open();
    assert.throws(() => restarted.getAttestations("c1"));
  });
});

test("request hashes distinguish an invented link from historical statement-only data", async t => {
  const f = fixture(t), store = f.open(); await contract(store); upload(store);
  const result = write(store, "deliverBatch", delivery, { attestation: note });
  assert.deepEqual(store.getAttestations("c1").data[0].evidence, []);
  f.raw().prepare("INSERT INTO procurement_attestation_evidence(command_sequence,evidence_id,position) VALUES(?,?,0)").run(result.version, "e1");
  assert.throws(() => store.getAttestations("c1"), { code: "ATTESTATION_COMMAND_MISMATCH" });
});

test("schema v2 statement-only database adds empty original tables without altering the journal", async t => {
  const f = fixture(t); let store = f.open(); await contract(store);
  write(store, "deliverBatch", delivery, { attestation: note });
  const before = store.read(), expected = store.getAttestations("c1");
  store.close(); const raw = f.raw();
  raw.exec("DROP TABLE procurement_attestation_evidence; DROP TABLE procurement_evidence; UPDATE procurement_meta SET schema_version=2");
  const journal = raw.prepare("SELECT * FROM procurement_commands ORDER BY sequence").all();
  store = f.open();
  assert.deepEqual(store.read(), before); assert.deepEqual(store.getAttestations("c1"), expected);
  assert.deepEqual(expected.data[0].evidence, []);
  assert.deepEqual(raw.prepare("SELECT * FROM procurement_commands ORDER BY sequence").all(), journal);
  assert.equal(raw.prepare("SELECT schema_version FROM procurement_meta").get().schema_version, 3);
});
