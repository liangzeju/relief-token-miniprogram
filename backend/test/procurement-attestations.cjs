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

const pool = "0x" + "11".repeat(20);
const supplier = Wallet.createRandom(), buyer = Wallet.createRandom(), inspector = Wallet.createRandom();
const deliveryActor = { id: "delivery-1", organizationId: "supplier-org", wallet: supplier.address, role: "delivery" };
const acceptanceActor = { id: "acceptance-1", organizationId: "inspection-org", wallet: inspector.address, role: "acceptance" };
const document = { termsText: "Deliver ten sealed cases.", acceptanceText: "Inspect packaging and count cases." };
const delivery = { id: "b1", contractId: "c1", quantity: 5, actor: deliveryActor };
const acceptance = { batchId: "b1", outcome: "ACCEPTED", acceptedQuantity: 5, actor: acceptanceActor };
const deliveryNote = { statement: "Supplier's written delivery statement.\nFive sealed cases listed." };
const acceptanceNote = { statement: "Inspector's written acceptance statement for five cases." };
const digest = text => keccak256(toUtf8Bytes(text));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-procurement-attestations-"));
  const file = path.join(dir, "platform.sqlite"), stores = [], connections = [];
  const open = () => {
    const store = createProcurementStore({ file, escrowContract: pool, clock: () => 123456789 });
    stores.push(store); return store;
  };
  const raw = () => { const db = new DatabaseSync(file); connections.push(db); return db; };
  t.after(() => {
    stores.forEach(store => store.close()); connections.forEach(db => db.close());
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("relief-procurement-attestations-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, open, raw };
}

function write(store, method, input, options = {}) {
  return store.execute({ method, input, actorId: input.actor ? input.actor.id : "operator-1",
    idempotencyKey: crypto.randomUUID(), expectedVersion: store.read().version, ...options });
}

async function funded(store, id = "c1") {
  const quoteId = `${id}-q`, reservationId = `${id}-r`;
  write(store, "addQuote", { id: quoteId, resourceId: "MAT-WATER", supplierOrganizationId: "supplier-org",
    supplierWallet: supplier.address, unitPriceWei: "12", availableQuantity: 10, validUntil: 5000, etaHours: 3 });
  write(store, "reserve", { id: reservationId, quoteId, taskId: "TASK-001", quantity: 10,
    buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now: 1000 });
  write(store, "createContract", { id, reservationId, termsHash: digest(document.termsText),
    acceptanceCriteriaHash: digest(document.acceptanceText), nonce: String(store.read().version), expiresAt: 4000, now: 1000 }, { document });
  const typed = store.getTypedData(id).data;
  for (const [party, signer] of [["buyer", buyer], ["supplier", supplier]]) {
    const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
    write(store, "signContract", { contractId: id, version: 1, party, signature, now: 1000 });
  }
  // Trusted local funding fixture only: no RPC, transaction broadcast, or production chain event.
  const txHash = digest(`local funding fixture ${id}`), escrowBusinessId = `${id}-escrow`;
  write(store, "recordEscrowConfirmed", { contractId: id, version: 1, escrowBusinessId, txHash,
    receipt: { status: 1, transactionHash: txHash, chainId: "10143", escrowContract: pool, value: "120",
      escrowBusinessId, contractId: id, contractVersion: 1 } });
}

test("written statements link to domain results and command actors, persist, and remain independent copies", async t => {
  const f = fixture(t); let store = f.open(); await funded(store); await funded(store, "c2");
  const delivered = write(store, "deliverBatch", delivery, { attestation: deliveryNote });
  const accepted = write(store, "acceptBatch", acceptance, { attestation: acceptanceNote });
  const expected = { data: [
    { commandSequence: delivered.version, contractId: "c1", contractVersion: 1, batchId: "b1", method: "deliverBatch",
      actorId: deliveryActor.id, ...deliveryNote, statementHash: digest(deliveryNote.statement), createdAt: 123456789, actor: deliveryActor, evidence: [] },
    { commandSequence: accepted.version, contractId: "c1", contractVersion: 1, batchId: "b1", method: "acceptBatch",
      actorId: acceptanceActor.id, ...acceptanceNote, statementHash: digest(acceptanceNote.statement), createdAt: 123456789, actor: acceptanceActor, evidence: [] }
  ], version: accepted.version };
  assert.deepEqual(store.getAttestations("c1"), expected);
  assert.deepEqual(store.getAttestations("c2"), { data: [], version: accepted.version });
  assert.throws(() => store.getAttestations("missing"), { code: "NOT_FOUND" });
  const raw = f.raw();
  assert.equal(raw.prepare("SELECT schema_version FROM procurement_meta").get().schema_version, 3);
  assert.equal(raw.prepare("PRAGMA foreign_key_list(procurement_attestations)").get().from, "command_sequence");
  assert.throws(() => raw.exec("INSERT INTO procurement_attestations SELECT * FROM procurement_attestations LIMIT 1"), /UNIQUE/);
  raw.exec("PRAGMA foreign_keys=ON");
  assert.throws(() => raw.exec("UPDATE procurement_attestations SET command_sequence=9999 WHERE method='deliverBatch'"), /FOREIGN KEY/);
  const copy = store.getAttestations("c1"); copy.data[0].statement = "changed"; copy.data[0].actor.id = "forged";
  assert.deepEqual(store.getAttestations("c1"), expected);
  store.close(); assert.throws(() => store.getAttestations("c1"), { code: "STORE_CLOSED" });
  store = f.open(); assert.deepEqual(store.getAttestations("c1"), expected);
});

test("large Unicode uses UTF-16 length limits and exact UTF-8 hashes without normalization", async t => {
  const store = fixture(t).open(); await funded(store);
  const statement = "\u{1f4e6}\u4ea4\u4ed8e\u0301\n".repeat(2285) + "\u{1f4e6}\u{1f4e6}x";
  assert.equal(statement.length, 16000);
  assert.ok(toUtf8Bytes(statement).length > 16000);
  write(store, "deliverBatch", delivery, { attestation: { statement } });
  write(store, "acceptBatch", acceptance, { attestation: { statement: "\u{1f4e6}" } });
  const rows = store.getAttestations("c1").data;
  assert.equal(rows[0].statement, statement); assert.equal(rows[0].statementHash, digest(statement));
  assert.notEqual(rows[0].statementHash, digest(statement.normalize("NFC")));
  assert.equal(rows[1].statementHash, digest("\u{1f4e6}"));
});

test("both methods replay after restart and reject changed or omitted statements", async t => {
  const f = fixture(t); let store = f.open(); await funded(store);
  const attempts = [["deliverBatch", delivery, deliveryNote], ["acceptBatch", acceptance, acceptanceNote]];
  const results = attempts.map(([method, input, attestation]) => write(store, method, input, { idempotencyKey: method, attestation }));
  store.close(); store = f.open();
  for (const [index, [method, input, attestation]] of attempts.entries()) {
    const retry = options => write(store, method, input, { idempotencyKey: method, expectedVersion: 0, ...options });
    assert.deepEqual(retry({ attestation }), { ...results[index], replayed: true });
    assert.throws(() => retry({ attestation: { statement: attestation.statement + " " } }), { code: "IDEMPOTENCY_KEY_REUSED" });
    assert.throws(() => retry({}), { code: "IDEMPOTENCY_KEY_REUSED" });
  }
  assert.equal(store.getAttestations("c1").data.length, 2);
  assert.equal(store.read().version, results[1].version);
});

test("existing schema v2 journals with no statements remain compatible without invented records", async t => {
  const f = fixture(t); let store = f.open(); await funded(store);
  const oldOptions = { actorId: "historical-operator", idempotencyKey: "legacy-delivery" };
  const delivered = write(store, "deliverBatch", delivery, oldOptions);
  write(store, "acceptBatch", acceptance, { actorId: "historical-operator" });
  const before = store.read(); store.close();
  const raw = f.raw(); raw.exec("DROP TABLE procurement_attestations; UPDATE procurement_meta SET schema_version=2");
  const commands = raw.prepare("SELECT * FROM procurement_commands ORDER BY sequence").all();
  store = f.open();
  assert.deepEqual(store.read(), before);
  assert.deepEqual(store.getAttestations("c1"), { data: [], version: before.version });
  assert.deepEqual(write(store, "deliverBatch", delivery, oldOptions), { ...delivered, replayed: true });
  assert.throws(() => write(store, "deliverBatch", delivery, { idempotencyKey: "legacy-delivery",
    actorId: "historical-operator", attestation: deliveryNote }), { code: "ATTESTATION_ACTOR_MISMATCH" });
  assert.deepEqual(raw.prepare("SELECT * FROM procurement_commands ORDER BY sequence").all(), commands);
  assert.equal(raw.prepare("SELECT schema_version FROM procurement_meta").get().schema_version, 3);
});

test("invalid statements, client association fields, wrong methods and actor mismatches never write", async t => {
  const f = fixture(t), store = f.open(); await funded(store);
  const before = store.read();
  const invalid = [null, [], "text", {}, { statement: 22 }, { statement: 22n }, { statement: "" },
    { statement: "x" }, { statement: " \n x \u3000" }, { statement: " \n\t\u3000" },
    { statement: "x".repeat(16001) }, { statement: "\u{1f4e6}".repeat(8001) },
    { statement: "x\ud800" }, { statement: "\udc00x" }, { statement: "x\ud800y" },
    { statement: "valid", [Symbol("extra")]: 1 }, new String("valid"),
    Object.create({ statement: "inherited" }), { get statement() { throw new Error("must not invoke getters"); } }];
  for (const field of ["contractId", "contractVersion", "batchId", "method", "actorId", "actor", "statementHash", "commandSequence", "createdAt", "extra"])
    invalid.push({ statement: "valid", [field]: "forged" });
  for (const attestation of invalid) {
    for (const [method, input] of [["deliverBatch", delivery], ["acceptBatch", acceptance]])
      assert.throws(() => write(store, method, input, { attestation }), { code: "INVALID_ATTESTATION" });
  }
  for (const method of ["addQuote", "reserve", "createContract", "reviseContract", "signContract", "recordEscrowConfirmed",
    "assignReviewer", "derivePayable", "markPaymentPending", "confirmPayment"])
    assert.throws(() => write(store, method, {}, { attestation: deliveryNote }), { code: "ATTESTATION_NOT_ALLOWED" });
  for (const input of [delivery, { ...delivery, actor: undefined }])
    assert.throws(() => write(store, "deliverBatch", input.actor ? input : { id: "b1", contractId: "c1", quantity: 5 },
      { actorId: "forged", attestation: deliveryNote }), { code: "ATTESTATION_ACTOR_MISMATCH" });
  assert.throws(() => write(store, "deliverBatch", { ...delivery, contractVersion: 999 }, { attestation: deliveryNote }), { code: "UNKNOWN_FIELD" });
  assert.deepEqual(store.read(), before);
  assert.deepEqual(store.getAttestations("c1"), { data: [], version: before.version });
});

test("attestation insert failures roll back domain state, command, version, and retry key for both methods", async t => {
  const f = fixture(t), store = f.open(); await funded(store); const raw = f.raw();
  for (const [method, input, attestation] of [["deliverBatch", delivery, deliveryNote], ["acceptBatch", acceptance, acceptanceNote]]) {
    const before = store.read(), previous = store.getAttestations("c1");
    const attempt = () => write(store, method, input, { attestation, idempotencyKey: method, expectedVersion: before.version });
    raw.exec("CREATE TRIGGER deny_attestation BEFORE INSERT ON procurement_attestations BEGIN SELECT RAISE(ABORT,'injected attestation insert failure'); END");
    assert.throws(attempt, /injected attestation insert failure/);
    assert.deepEqual(store.read(), before); assert.deepEqual(store.getAttestations("c1"), previous);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_commands WHERE request_key=?").get(method).n, 0);
    raw.exec("DROP TRIGGER deny_attestation");
    const result = attempt(); assert.equal(result.replayed, false); assert.equal(result.version, before.version + 1);
    assert.equal(store.getAttestations("c1").data.length, previous.data.length + 1);
  }
});

test("domain failures and stale versions leave no statements", async t => {
  const f = fixture(t), store = f.open(); await funded(store); const before = store.read();
  assert.throws(() => write(store, "deliverBatch", { ...delivery, quantity: 11 }, { attestation: deliveryNote }), { code: "CONTRACT_QUANTITY_EXCEEDED" });
  assert.throws(() => write(store, "deliverBatch", delivery, { attestation: deliveryNote, expectedVersion: 0 }), { code: "VERSION_CONFLICT" });
  assert.deepEqual(store.read(), before); assert.equal(store.getAttestations("c1").data.length, 0);
});

test("tampered or missing statements and command associations fail reads and idempotent replay", async t => {
  const mutations = [
    ["HTTP raw statement update", raw => raw.prepare("UPDATE procurement_attestations SET statement=? WHERE batch_id=? AND method=?").run("tampered text", "b1", "deliverBatch")],
    ["digest", raw => raw.exec("UPDATE procurement_attestations SET statement_hash='0x00' WHERE method='deliverBatch'")],
    ["text and digest together", raw => raw.prepare("UPDATE procurement_attestations SET statement=?, statement_hash=? WHERE method='deliverBatch'").run("tampered text", digest("tampered text"))],
    ["record deletion", raw => raw.exec("DELETE FROM procurement_attestations WHERE method='deliverBatch'")],
    ["contract", raw => raw.exec("UPDATE procurement_attestations SET contract_id='another-contract' WHERE method='deliverBatch'")],
    ["contract version", raw => raw.exec("UPDATE procurement_attestations SET contract_version=2 WHERE method='deliverBatch'")],
    ["batch", raw => raw.exec("UPDATE procurement_attestations SET batch_id='another-batch' WHERE method='deliverBatch'")],
    ["method", raw => raw.exec("UPDATE procurement_attestations SET method='acceptBatch' WHERE method='deliverBatch'")],
    ["actor", raw => raw.exec("UPDATE procurement_attestations SET actor_id='forged' WHERE method='deliverBatch'")],
    ["timestamp", raw => raw.exec("UPDATE procurement_attestations SET created_at=0 WHERE method='deliverBatch'")],
    ["orphan sequence", raw => raw.exec("PRAGMA foreign_keys=OFF; UPDATE procurement_attestations SET command_sequence=9999 WHERE method='deliverBatch'")],
    ["unrelated command", raw => raw.exec("UPDATE procurement_attestations SET command_sequence=1 WHERE method='deliverBatch'")],
    ["command actor", raw => raw.exec("UPDATE procurement_commands SET actor_id='forged' WHERE method='acceptBatch'")],
    ["command request digest", raw => raw.exec("UPDATE procurement_commands SET request_hash='forged' WHERE method='acceptBatch'")],
    ["command result", raw => raw.exec("UPDATE procurement_commands SET result_json='{}' WHERE method='acceptBatch'")],
    ["command input actor", raw => {
      const row = raw.prepare("SELECT input_json FROM procurement_commands WHERE method='acceptBatch'").get();
      const input = JSON.parse(row.input_json); input.actor.id = "other-inspector";
      raw.prepare("UPDATE procurement_commands SET input_json=? WHERE method='acceptBatch'").run(JSON.stringify(input));
    }],
    ["missing command", raw => raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM procurement_commands WHERE method='acceptBatch'")],
    ["fabricated historical record", raw => {
      raw.exec("DELETE FROM procurement_attestations WHERE method='deliverBatch'");
      const sorted = value => value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
      const requestHash = crypto.createHash("sha256").update(JSON.stringify(sorted({ method: "deliverBatch", input: delivery }))).digest("hex");
      raw.prepare("UPDATE procurement_commands SET request_hash=? WHERE method='deliverBatch'").run(requestHash);
      raw.prepare(`INSERT INTO procurement_attestations SELECT sequence,'c1',1,'b1',method,actor_id,?,?,created_at
        FROM procurement_commands WHERE method='deliverBatch'`).run(deliveryNote.statement, digest(deliveryNote.statement));
    }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const f = fixture(t), store = f.open(); await funded(store);
    write(store, "deliverBatch", delivery, { attestation: deliveryNote, idempotencyKey: "delivery" });
    write(store, "acceptBatch", acceptance, { attestation: acceptanceNote, idempotencyKey: "acceptance" });
    mutate(f.raw());
    assert.throws(() => store.getAttestations("c1"));
    assert.throws(() => write(store, "deliverBatch", delivery, { attestation: deliveryNote, idempotencyKey: "delivery" }));
  });
});
