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
const now = 1000;
const document = { termsText: "Deliver ten sealed cases of drinking water.\nKeep the original packaging.", acceptanceText: "Count all cases and inspect seals before accepting." };
function contractInput(id = "c1", text = document) {
  return { id, reservationId: "r1", termsHash: keccak256(toUtf8Bytes(text.termsText)),
    acceptanceCriteriaHash: keccak256(toUtf8Bytes(text.acceptanceText)), nonce: "1", expiresAt: 4000, now };
}
function reserve(store) {
  write(store, "addQuote", quote());
  write(store, "reserve", { id: "r1", quoteId: "q1", taskId: "TASK-001", quantity: 10, buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now });
}
function quote(id = "q1") { return { id, resourceId: "MAT-WATER", supplierOrganizationId: "supplier-org", supplierWallet: supplier.address, unitPriceWei: "12000000000000000000", availableQuantity: 10, validUntil: 5000, etaHours: 3 }; }
function fixture(t, escrowContract = pool) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-procurement-store-")), file = path.join(dir, "platform.sqlite");
  const stores = [];
  const open = (address = escrowContract) => { const store = createProcurementStore({ file, escrowContract: address }); stores.push(store); return store; };
  t.after(() => { stores.forEach(store => store.close()); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("relief-procurement-store-")); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, open };
}
function write(store, method, input, idempotencyKey = crypto.randomUUID(), expectedVersion = store.read().version, document) {
  return store.execute({ method, input, document, actorId: "operator-1", idempotencyKey, expectedVersion });
}

test("SQLite journal persists genuine typed-data signatures and replays them after restart", async t => {
  const f = fixture(t); let store = f.open();
  write(store, "addQuote", quote());
  write(store, "reserve", { id: "r1", quoteId: "q1", taskId: "TASK-001", quantity: 10, buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now });
  write(store, "createContract", contractInput(), "contract", 2, document);
  const typed = store.getTypedData("c1").data;
  for (const [party, signer] of [["buyer", buyer], ["supplier", supplier]]) {
    const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
    write(store, "signContract", { contractId: "c1", version: 1, party, signature, now });
  }
  const before = store.read();
  assert.equal(before.contracts[0].status, "FUNDS_RESERVABLE");
  store.close(); store = f.open();
  assert.deepEqual(store.read(), before);
  assert.deepEqual(store.getDocument("c1"), { data: { contractId: "c1", version: 1, ...document,
    termsHash: contractInput().termsHash, acceptanceCriteriaHash: contractInput().acceptanceCriteriaHash } });
  const copy = store.read(); copy.contracts[0].status = "PAID";
  assert.equal(store.read().contracts[0].status, "FUNDS_RESERVABLE");
});

test("idempotency survives restart and changed payload cannot reuse a key", t => {
  const f = fixture(t); let store = f.open();
  const first = write(store, "addQuote", quote(), "same-key", 0);
  store.close(); store = f.open();
  const retry = write(store, "addQuote", quote(), "same-key", 0);
  assert.deepEqual(retry.data, first.data); assert.equal(retry.replayed, true);
  assert.throws(() => write(store, "addQuote", quote("q2"), "same-key"), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.equal(store.read().quotes.length, 1);
});

test("two SQLite connections cannot reserve beyond a shared quote", t => {
  const f = fixture(t), a = f.open(), b = f.open();
  write(a, "addQuote", quote());
  const input = { id: "r1", quoteId: "q1", taskId: "TASK-001", quantity: 8, buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now };
  write(a, "reserve", input, "a", 1);
  assert.throws(() => write(b, "reserve", { ...input, id: "r2" }, "b", 1), { code: "VERSION_CONFLICT" });
  assert.throws(() => write(b, "reserve", { ...input, id: "r2" }, "b", 2), { code: "INSUFFICIENT_AVAILABILITY" });
  assert.equal(b.read().quotes[0].availableQuantity, 2);
});

test("failed SQLite commit rolls back state and idempotency together", t => {
  const f = fixture(t), store = f.open(), raw = new DatabaseSync(f.file);
  try {
    raw.exec("CREATE TRIGGER deny_procurement BEFORE INSERT ON procurement_commands BEGIN SELECT RAISE(ABORT,'test disk failure'); END;");
    assert.throws(() => write(store, "addQuote", quote(), "retry"));
    assert.equal(store.read().version, 0); assert.equal(store.read().quotes.length, 0);
    raw.exec("DROP TRIGGER deny_procurement");
    assert.equal(write(store, "addQuote", quote(), "retry", 0).version, 1);
  } finally { raw.close(); }
});

test("a pool can be configured before contracts, but existing configuration cannot be silently replaced", t => {
  const f = fixture(t, null), initial = f.open();
  write(initial, "addQuote", quote()); initial.close();
  const configured = f.open(pool); assert.equal(configured.read().configuration.signingReady, true); configured.close();
  assert.throws(() => f.open("0x" + "44".repeat(20)), { code: "PROCUREMENT_CONFIG_MISMATCH" });
  assert.throws(() => f.open(null), { code: "PROCUREMENT_CONFIG_MISMATCH" });
});

test("corrupt persisted commands fail startup rather than replacing procurement state", t => {
  const f = fixture(t), store = f.open(); write(store, "addQuote", quote()); store.close();
  const raw = new DatabaseSync(f.file);
  raw.prepare("UPDATE procurement_commands SET input_json=?").run("{broken"); raw.close();
  assert.throws(() => f.open());
  const check = new DatabaseSync(f.file);
  try { assert.equal(check.prepare("SELECT input_json FROM procurement_commands").get().input_json, "{broken"); }
  finally { check.close(); }
});

test("contract documents and journal roll back together on domain and SQLite failures", t => {
  const f = fixture(t), store = f.open(), raw = new DatabaseSync(f.file);
  try {
    reserve(store);
    const attempt = input => write(store, "createContract", input, "contract", 2, document);
    assert.throws(() => attempt({ ...contractInput(), expiresAt: now }), { code: "EXPIRED" });
    assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_documents").get().n, 0);
    raw.exec("CREATE TRIGGER deny_document BEFORE INSERT ON procurement_documents BEGIN SELECT RAISE(ABORT,'document disk failure'); END;");
    assert.throws(() => attempt(contractInput()));
    assert.equal(store.read().version, 2);
    assert.equal(store.read().reservations[0].status, "RESERVED");
    assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_documents").get().n, 0);
    raw.exec("DROP TRIGGER deny_document");
    raw.exec("CREATE TRIGGER deny_contract BEFORE INSERT ON procurement_commands WHEN NEW.method='createContract' BEGIN SELECT RAISE(ABORT,'journal disk failure'); END;");
    assert.throws(() => attempt(contractInput()));
    assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_documents").get().n, 0);
    assert.equal(store.read().contracts.length, 0);
    raw.exec("DROP TRIGGER deny_contract");
    assert.equal(attempt(contractInput()).version, 3);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_documents").get().n, 1);
  } finally { raw.close(); }
});

test("document validation, exact-text idempotency and restart replay", t => {
  const f = fixture(t); let store = f.open(); reserve(store);
  assert.throws(() => write(store, "addQuote", quote("q2"), "bad-method", 2, document), { code: "DOCUMENT_NOT_ALLOWED" });
  for (const invalid of [null, {}, { ...document, termsText: "x" }, { ...document, acceptanceText: "x".repeat(16001) }, { ...document, extra: true }]) {
    assert.throws(() => write(store, "createContract", contractInput(), "invalid", 2, invalid), { code: "INVALID_DOCUMENT" });
  }
  assert.throws(() => write(store, "createContract", { ...contractInput(), termsHash: "0x" + "ab".repeat(32) }, "hash", 2, document), { code: "DOCUMENT_HASH_MISMATCH" });
  const first = write(store, "createContract", contractInput(), "contract", 2, document);
  store.close(); store = f.open();
  const replay = write(store, "createContract", { ...contractInput(), now: now + 1 }, "contract", 2, document);
  assert.deepEqual(replay.data, first.data); assert.equal(replay.replayed, true);
  for (const field of ["termsText", "acceptanceText"]) {
    const changed = { ...document, [field]: document[field] + " " };
    assert.throws(() => write(store, "createContract", contractInput("c1", changed), "contract", 2, changed), { code: "IDEMPOTENCY_KEY_REUSED" });
  }
  assert.throws(() => write(store, "createContract", contractInput(), "contract", 2), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.equal(store.read().version, 3);
});

test("schema v1 migration does not invent historical text or allow signatures without it", async t => {
  const f = fixture(t); let store = f.open(); reserve(store);
  write(store, "createContract", contractInput());
  store.close();
  const raw = new DatabaseSync(f.file);
  raw.exec("DROP TABLE procurement_documents; UPDATE procurement_meta SET schema_version=1;");
  raw.close();
  store = f.open();
  assert.equal(store.read().contracts.length, 1);
  for (const read of [() => store.getDocument("c1"), () => store.getTypedData("c1")]) assert.throws(read, { code: "CONTRACT_DOCUMENT_MISSING" });
  const { buildTypedData } = require("../procurement-domain");
  const typed = buildTypedData(store.read().contracts[0].versions[0]);
  const signature = await buyer.signTypedData(typed.domain, typed.types, typed.value);
  assert.throws(() => write(store, "signContract", { contractId: "c1", version: 1, party: "buyer", signature, now }), { code: "CONTRACT_DOCUMENT_MISSING" });
  assert.equal(store.read().version, 3);
  const check = new DatabaseSync(f.file);
  try {
    assert.equal(check.prepare("SELECT schema_version FROM procurement_meta").get().schema_version, 3);
    assert.equal(check.prepare("SELECT count(*) AS n FROM procurement_documents").get().n, 0);
  } finally { check.close(); }
});

test("a newer hash-only version cannot sign using the prior version's document", t => {
  const f = fixture(t), store = f.open(); reserve(store);
  write(store, "createContract", contractInput(), "contract", 2, document);
  write(store, "reviseContract", { contractId: "c1", nonce: "2", expiresAt: 4001, now });
  assert.throws(() => store.getDocument("c1"), { code: "CONTRACT_DOCUMENT_MISSING" });
  assert.throws(() => store.getTypedData("c1"), { code: "CONTRACT_DOCUMENT_MISSING" });
});

test("tampered or missing text cannot produce typed data, signatures or signature replays", async t => {
  const f = fixture(t), store = f.open(); reserve(store);
  write(store, "createContract", contractInput(), "contract", 2, document);
  const typed = store.getTypedData("c1").data;
  const signature = await buyer.signTypedData(typed.domain, typed.types, typed.value);
  const input = { contractId: "c1", version: 1, party: "buyer", signature, now };
  write(store, "signContract", input, "signature", 3);
  const raw = new DatabaseSync(f.file);
  try {
    raw.prepare("UPDATE procurement_documents SET terms_text=?").run(document.termsText + " changed");
    assert.throws(() => store.getDocument("c1"), { code: "DOCUMENT_HASH_MISMATCH" });
    assert.throws(() => store.getTypedData("c1"), { code: "DOCUMENT_HASH_MISMATCH" });
    assert.throws(() => write(store, "signContract", input, "signature", 3), { code: "DOCUMENT_HASH_MISMATCH" });
    raw.exec("DELETE FROM procurement_documents");
    assert.throws(() => write(store, "signContract", input, "signature", 3), { code: "CONTRACT_DOCUMENT_MISSING" });
    assert.equal(store.read().version, 4);
  } finally { raw.close(); }
});

test("unconfigured chain cannot create documents, sign or pay", t => {
  const f = fixture(t, null), store = f.open(); reserve(store);
  assert.throws(() => write(store, "createContract", contractInput(), "contract", 2, document), { code: "CHAIN_CONFIGURATION_REQUIRED" });
  assert.equal(store.read().configuration.signingReady, false);
  assert.equal(store.read().contracts.length, 0);
  assert.throws(() => store.getTypedData("c1"), { code: "NOT_FOUND" });
  assert.throws(() => write(store, "signContract", { contractId: "c1", version: 1, party: "buyer", signature: "0xab", now }), { code: "NOT_FOUND" });
  assert.throws(() => write(store, "markPaymentPending", { batchId: "b1", paymentBusinessId: "p1", onChainEscrowConfirmed: false }), { code: "ESCROW_NOT_CONFIRMED" });
  assert.equal(store.read().payments.length, 0);
});
