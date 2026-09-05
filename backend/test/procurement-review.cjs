"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { Wallet, verifyTypedData, keccak256, toUtf8Bytes } = require("ethers");
const { createProcurementStore } = require("../procurement-store");
const { createProcurementDomain } = require("../procurement-domain");

const pool = "0x" + "11".repeat(20), supplier = Wallet.createRandom(), buyer = Wallet.createRandom();
const identity = (id, organizationId, role, wallet = Wallet.createRandom().address) => ({ id, organizationId, wallet, role });
const deliveryActor = identity("supplier-user", "supplier-org", "delivery", supplier.address);
const assessor = identity("assessor", "buyer-org", "acceptance");
const reviewer = identity("reviewer", "review-org", "reviewer");
const reviewer2 = identity("reviewer-2", "review-org-2", "reviewer");
const finance = identity("finance", "buyer-org", "finance");
const normalized = actor => ({ ...actor, wallet: actor.wallet.toLowerCase() });
const document = { termsText: "Deliver ten cases.", acceptanceText: "Inspect seals and count cases." };
const note = { statement: "Written batch statement." };
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const digest = value => keccak256(toUtf8Bytes(value));
const assignment = (overrides = {}) => ({ batchId: "b1", id: "case-assignment-1", assignmentId: "registry-binding-1",
  reviewer, assignedBy: "admin-user", reason: "Independent inspection required.", assignedAt: 1700000000000, ...overrides });
const resolution = (overrides = {}) => ({ batchId: "b1", acceptedQuantity: 2, actor: reviewer,
  reviewAssignmentId: "case-assignment-1", ...overrides });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-procurement-review-"));
  const file = path.join(dir, "platform.sqlite"), stores = [], connections = [];
  const open = () => {
    const store = createProcurementStore({ file, escrowContract: pool, clock: () => 1700000000123 });
    stores.push(store); return store;
  };
  const raw = () => { const db = new DatabaseSync(file); connections.push(db); return db; };
  t.after(() => {
    stores.forEach(store => store.close()); connections.forEach(db => db.close());
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("relief-procurement-review-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, open, raw };
}
function write(store, method, input, options = {}) {
  return store.execute({ method, input, actorId: input.actor?.id || input.assignedBy || "operator",
    idempotencyKey: crypto.randomUUID(), expectedVersion: store.read().version, ...options });
}
function upload(store, id = "review-file", overrides = {}, actor = reviewer) {
  return store.putEvidence({ input: { id, contractId: "c1", contractVersion: 1, batchId: "b1", method: "resolveDispute",
    filename: "original.png", mimeType: "image/png", contentBase64: png.toString("base64"),
    ...((overrides.method || "resolveDispute") === "resolveDispute" ? { reviewAssignmentId: "case-assignment-1" } : {}),
    ...overrides }, actor, idempotencyKey: id });
}
function review(store, input = resolution(), ids = ["review-file"], options = {}) {
  return write(store, "resolveDispute", input, { idempotencyKey: "resolve", attestation: { ...note, evidenceIds: ids }, ...options });
}
async function seed(store, withFiles = false) {
  write(store, "addQuote", { id: "q1", resourceId: "WATER", supplierOrganizationId: "supplier-org", supplierWallet: supplier.address,
    unitPriceWei: "12", availableQuantity: 10, validUntil: 5000, etaHours: 3 }, { actorId: "quote-author" });
  write(store, "reserve", { id: "r1", quoteId: "q1", taskId: "TASK-1", quantity: 10,
    buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now: 1000 }, { actorId: "former-dispatcher" });
  write(store, "createContract", { id: "c1", reservationId: "r1", termsHash: digest(document.termsText),
    acceptanceCriteriaHash: digest(document.acceptanceText), nonce: "1", expiresAt: 4000, now: 1000 }, { document, actorId: "contract-author" });
  const typed = store.getTypedData("c1").data;
  for (const [party, signer] of [["buyer", buyer], ["supplier", supplier]]) {
    const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
    write(store, "signContract", { contractId: "c1", version: 1, party, signature, now: 1000 }, { actorId: `${party}-signer` });
  }
  // Offline trusted fixture only; no production funding event or network call.
  const txHash = digest("local review test funding");
  write(store, "recordEscrowConfirmed", { contractId: "c1", version: 1, escrowBusinessId: "escrow-1", txHash,
    receipt: { status: 1, transactionHash: txHash, chainId: "10143", escrowContract: pool, value: "120",
      escrowBusinessId: "escrow-1", contractId: "c1", contractVersion: 1 } }, { actorId: "trusted-indexer" });
  for (const [id, quantity] of [["b1", 4], ["b2", 3], ["b3", 3]]) {
    if (withFiles && id === "b1") upload(store, "delivery-file", { method: "deliverBatch" }, deliveryActor);
    write(store, "deliverBatch", { id, contractId: "c1", quantity, actor: deliveryActor },
      { attestation: withFiles && id === "b1" ? { ...note, evidenceIds: ["delivery-file"] } : note });
    if (id === "b3") continue;
    if (withFiles && id === "b1") upload(store, "acceptance-file", { method: "acceptBatch" }, assessor);
    write(store, "acceptBatch", { batchId: id, outcome: id === "b1" ? "DISPUTED" : "ACCEPTED", acceptedQuantity: id === "b1" ? 0 : quantity, actor: assessor },
      { attestation: withFiles && id === "b1" ? { ...note, evidenceIds: ["acceptance-file"] } : note });
  }
}
function domainFrom(raw) {
  const commands = raw.prepare("SELECT method,input_json FROM procurement_commands ORDER BY sequence").all()
    .map(row => ({ method: row.method, input: JSON.parse(row.input_json) }));
  return createProcurementDomain({ schemaVersion: 1, commands }, { chainId: "10143", escrowContract: pool, verifyTypedData });
}
function unchanged(domain, action, code) {
  const before = domain.exportState();
  assert.throws(action, code ? { code } : undefined);
  assert.deepEqual(domain.exportState(), before);
}

test("domain assignment history is append-only, isolated, globally unique and restricted to disputes", async t => {
  const f = fixture(t), store = f.open(); await seed(store); const domain = domainFrom(f.raw());
  const before = domain.getBatch("b2"), first = domain.assignReviewer(assignment());
  const { batchId, ...expected } = assignment(); expected.reviewer = normalized(reviewer);
  assert.deepEqual(first.reviewAssignments, [expected]);
  assert.equal(first.status, "DISPUTED"); assert.deepEqual(domain.getBatch("b2"), before);
  first.reviewAssignments[0].reason = "forged";
  const second = domain.assignReviewer(assignment({ id: "case-assignment-2", reviewer: reviewer2, assignmentId: "registry-binding-2" }));
  assert.deepEqual(second.reviewAssignments[0], expected);
  assert.equal(second.reviewAssignments[1].id, "case-assignment-2");
  unchanged(domain, () => domain.assignReviewer(assignment()), "DUPLICATE_REVIEW_ASSIGNMENT_ID");
  unchanged(domain, () => domain.assignReviewer(assignment({ batchId: "b2", id: "new" })), "BATCH_NOT_DISPUTED");
  domain.acceptBatch({ batchId: "b3", outcome: "DISPUTED", acceptedQuantity: 0, actor: assessor });
  unchanged(domain, () => domain.assignReviewer(assignment({ batchId: "b3" })), "DUPLICATE_REVIEW_ASSIGNMENT_ID");
  const restored = createProcurementDomain(domain.exportState(), { chainId: "10143", escrowContract: pool, verifyTypedData });
  assert.deepEqual(restored.snapshot(), domain.snapshot());
});

test("assignment validates reason, audit time, identities and independent reviewer without admin wallet fabrication", async t => {
  const f = fixture(t), store = f.open(); await seed(store); const domain = domainFrom(f.raw());
  for (const changes of [{ reason: "x" }, { reason: " x " }, { reason: " " }, { reason: "x".repeat(2001) },
    { reason: "x\ud800" }, { assignedAt: -1 }, { assignedAt: 1.5 }, { assignedAt: "1" }, { assignedAt: undefined },
    { assignedBy: "" }, { assignmentId: "" }, { id: "" }, { extra: true }, { reviewer: { ...reviewer, role: "finance" } }])
    unchanged(domain, () => domain.assignReviewer(assignment(changes)));
  for (const changes of [{ wallet: buyer.address }, { organizationId: "buyer-org" }, { wallet: supplier.address },
    { organizationId: "supplier-org" }, { id: deliveryActor.id }, { wallet: deliveryActor.wallet },
    { id: assessor.id }, { wallet: assessor.wallet }])
    unchanged(domain, () => domain.assignReviewer(assignment({ reviewer: { ...reviewer, ...changes } })), "REVIEWER_NOT_INDEPENDENT");
  const result = domain.assignReviewer(assignment({ reason: "\u4e89\u8bae".repeat(1000), assignedAt: 0 }));
  assert.equal(result.reviewAssignments[0].reason.length, 2000);
  assert.equal(result.reviewAssignments[0].assignedBy, "admin-user");
  assert.equal(Object.hasOwn(result.reviewAssignments[0], "adminWallet"), false);
});

test("prior finance participants cannot be assigned or resolve after becoming finance participants", async t => {
  const f = fixture(t), store = f.open(); await seed(store);
  write(store, "markPaymentPending", { batchId: "b2", paymentBusinessId: "pay-2", actor: finance, onChainEscrowConfirmed: true });
  const domain = domainFrom(f.raw());
  for (const changes of [{ id: finance.id }, { wallet: finance.wallet }])
    unchanged(domain, () => domain.assignReviewer(assignment({ reviewer: { ...reviewer, ...changes } })), "SEPARATION_OF_DUTIES");
  domain.assignReviewer(assignment());
  domain.acceptBatch({ batchId: "b3", outcome: "ACCEPTED", acceptedQuantity: 3, actor: assessor });
  domain.markPaymentPending({ batchId: "b3", paymentBusinessId: "pay-3", actor: { ...reviewer, role: "finance" }, onChainEscrowConfirmed: true });
  unchanged(domain, () => domain.resolveDispute(resolution()), "SEPARATION_OF_DUTIES");
});

test("resolution matches latest assignment ID and every normalized reviewer field", async t => {
  const f = fixture(t), store = f.open(); await seed(store); const domain = domainFrom(f.raw());
  domain.assignReviewer(assignment());
  for (const reviewAssignmentId of [undefined, "registry-binding-1", "stale"])
    unchanged(domain, () => domain.resolveDispute(resolution({ reviewAssignmentId } )));
  for (const changes of [{ id: "other-reviewer" }, { organizationId: "other-org" }, { wallet: reviewer2.wallet }, { role: "finance" }])
    unchanged(domain, () => domain.resolveDispute(resolution({ actor: { ...reviewer, ...changes } })));
  domain.assignReviewer(assignment({ id: "case-assignment-2", reviewer: reviewer2, assignmentId: "registry-binding-2" }));
  unchanged(domain, () => domain.resolveDispute(resolution()), "REVIEW_ASSIGNMENT_MISMATCH");
  assert.equal(domain.resolveDispute(resolution({ actor: reviewer2, reviewAssignmentId: "case-assignment-2" })).review.reviewAssignmentId, "case-assignment-2");
});

test("legacy unassigned trusted journals still replay, but cannot invent a review assignment reference", async t => {
  const f = fixture(t), store = f.open(); await seed(store);
  const domain = domainFrom(f.raw());
  unchanged(domain, () => domain.resolveDispute(resolution()), "REVIEW_ASSIGNMENT_REQUIRED");
  const legacy = { batchId: "b1", actor: reviewer, acceptedQuantity: 1 };
  const result = write(store, "resolveDispute", legacy);
  assert.equal(result.data.status, "PARTIAL");
  assert.equal(Object.hasOwn(result.data.review, "reviewAssignmentId"), false);
  const before = store.read(); store.close();
  assert.deepEqual(f.open().read(), before);
});

test("rejection, partial and full review retain original assessment, siblings and proportional payable", async t => {
  for (const [quantity, status] of [[0, "REJECTED"], [2, "PARTIAL"], [4, "ACCEPTED"]]) await t.test(status, async t => {
    const f = fixture(t), store = f.open(); await seed(store);
    const before = store.read(), original = before.batches[0].acceptance;
    write(store, "assignReviewer", assignment()); upload(store);
    const result = review(store, resolution({ acceptedQuantity: quantity }));
    assert.equal(result.data.status, status); assert.equal(result.data.acceptedQuantity, quantity);
    assert.deepEqual(result.data.acceptance, original);
    assert.deepEqual(store.read().batches.slice(1), before.batches.slice(1));
    if (!quantity) assert.throws(() => write(store, "derivePayable", { batchId: "b1" }), { code: "BATCH_NOT_PAYABLE" });
    else assert.equal(write(store, "derivePayable", { batchId: "b1" }).data.amountWei, String(12 * quantity));
    assert.throws(() => write(store, "assignReviewer", assignment({ id: "late" })), { code: "BATCH_NOT_DISPUTED" });
  });
});

test("assignment store retries commit assignedAt and all business fields to the stable idempotency key", async t => {
  const f = fixture(t); let store = f.open(); await seed(store);
  const first = write(store, "assignReviewer", assignment(), { idempotencyKey: "assign" });
  store.close(); store = f.open();
  assert.deepEqual(write(store, "assignReviewer", assignment(), { idempotencyKey: "assign", expectedVersion: 0 }), { ...first, replayed: true });
  for (const changes of [{ assignedAt: 1700000000001 }, { reason: "Different reason." }, { assignmentId: "different-binding" },
    { reviewer: reviewer2 }, { id: "different-case-id" }, { assignedBy: "different-admin" }])
    assert.throws(() => write(store, "assignReviewer", assignment(changes), { actorId: "admin-user", idempotencyKey: "assign" }), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.equal(store.read().batches[0].reviewAssignments.length, 1);
});

test("review originals require current assignment, matching actor and disputed batch; ordinary metadata stays unchanged", async t => {
  const f = fixture(t), store = f.open(); await seed(store);
  assert.throws(() => upload(store), { code: "REVIEW_ASSIGNMENT_MISMATCH" });
  write(store, "assignReviewer", assignment());
  for (const changes of [{ reviewAssignmentId: "stale" }, { batchId: "b2" }, { reviewAssignmentId: undefined }])
    assert.throws(() => upload(store, "invalid", changes));
  assert.throws(() => upload(store, "wrong-person", {}, reviewer2), { code: "REVIEWER_ASSIGNMENT_MISMATCH" });
  const version = store.read().version, original = upload(store);
  assert.equal(original.data.reviewAssignmentId, "case-assignment-1");
  assert.equal(store.read().version, version);
  assert.deepEqual(store.getEvidenceMetadata("review-file"), { data: original.data });
  const result = review(store), record = store.getAttestations("c1").data.at(-1);
  assert.equal(record.method, "resolveDispute"); assert.equal(record.batchId, "b1");
  assert.deepEqual(record.evidence, [original.data]);
  store.close(); const restarted = f.open();
  assert.deepEqual(restarted.getEvidence("review-file").content, png);
  assert.deepEqual(review(restarted), { ...result, replayed: true });
  assert.throws(() => upload(restarted, "late"), { code: "BATCH_NOT_DISPUTED" });
});

test("same-person reassignment at the same timestamp invalidates old originals and old review IDs", async t => {
  const f = fixture(t), store = f.open(); await seed(store);
  write(store, "assignReviewer", assignment()); upload(store);
  write(store, "assignReviewer", assignment({ id: "case-assignment-2" }));
  assert.throws(() => upload(store, "stale-upload"), { code: "REVIEW_ASSIGNMENT_MISMATCH" });
  assert.throws(() => review(store), { code: "REVIEW_ASSIGNMENT_MISMATCH" });
  assert.throws(() => review(store, resolution({ reviewAssignmentId: "case-assignment-2" })), { code: "EVIDENCE_SCOPE_MISMATCH" });
  upload(store, "new-original", { reviewAssignmentId: "case-assignment-2" });
  assert.equal(review(store, resolution({ reviewAssignmentId: "case-assignment-2" }), ["new-original"]).data.status, "PARTIAL");
  assert.equal(store.read().batches[0].reviewAssignments.length, 2);
});

test("assignment, review statement and evidence links roll back with failing SQLite inserts", async t => {
  const f = fixture(t), store = f.open(); await seed(store); const raw = f.raw(), before = store.read();
  raw.exec("CREATE TRIGGER deny_assignment BEFORE INSERT ON procurement_commands WHEN NEW.method='assignReviewer' BEGIN SELECT RAISE(ABORT,'assignment failure'); END");
  assert.throws(() => write(store, "assignReviewer", assignment(), { idempotencyKey: "assign" }), /assignment failure/);
  assert.deepEqual(store.read(), before); raw.exec("DROP TRIGGER deny_assignment");
  write(store, "assignReviewer", assignment(), { idempotencyKey: "assign" }); upload(store); upload(store, "review-file-2");
  for (const [table, condition] of [["procurement_attestations", "NEW.method='resolveDispute'"], ["procurement_attestation_evidence", "NEW.position=1"]]) {
    const prior = store.read(), statements = store.getAttestations("c1");
    raw.exec(`CREATE TRIGGER deny_review BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'review failure'); END`);
    assert.throws(() => review(store, resolution(), ["review-file", "review-file-2"]), /review failure/);
    assert.deepEqual(store.read(), prior); assert.deepEqual(store.getAttestations("c1"), statements);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_attestation_evidence WHERE evidence_id LIKE 'review-file%'").get().n, 0);
    raw.exec("DROP TRIGGER deny_review");
  }
  assert.equal(review(store, resolution(), ["review-file", "review-file-2"]).replayed, false);
});

const evidenceColumns = "id,contract_id,contract_version,batch_id,method,filename,mime_type,size_bytes,sha256,actor_id,actor_json,created_at,request_key,request_hash,content";
function downgradeToV2(raw) {
  raw.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    CREATE TABLE old_attestations (
      command_sequence INTEGER NOT NULL UNIQUE REFERENCES procurement_commands(sequence),
      contract_id TEXT NOT NULL, contract_version INTEGER NOT NULL CHECK(contract_version > 0),
      batch_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('deliverBatch','acceptBatch')),
      actor_id TEXT NOT NULL, statement TEXT NOT NULL, statement_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO old_attestations SELECT * FROM procurement_attestations;
    DROP TABLE procurement_attestations;
    ALTER TABLE old_attestations RENAME TO procurement_attestations;
    CREATE TABLE old_evidence (
      id TEXT PRIMARY KEY NOT NULL, contract_id TEXT NOT NULL, contract_version INTEGER NOT NULL CHECK(contract_version > 0),
      batch_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('deliverBatch','acceptBatch')),
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 5242880),
      sha256 TEXT NOT NULL, actor_id TEXT NOT NULL, actor_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      request_key TEXT NOT NULL, request_hash TEXT NOT NULL, content BLOB NOT NULL, UNIQUE(actor_id, request_key)
    );
    INSERT INTO old_evidence SELECT ${evidenceColumns} FROM procurement_evidence;
    DROP TABLE procurement_evidence;
    ALTER TABLE old_evidence RENAME TO procurement_evidence;
    CREATE INDEX old_evidence_contract ON procurement_evidence(contract_id);
    CREATE TRIGGER old_evidence_guard BEFORE INSERT ON procurement_evidence WHEN NEW.filename='blocked.png'
      BEGIN SELECT RAISE(ABORT,'preserved guard'); END;
    UPDATE procurement_meta SET schema_version=2;
    COMMIT; PRAGMA foreign_keys=ON;`);
}
function persisted(raw) {
  return {
    commands: raw.prepare("SELECT * FROM procurement_commands ORDER BY sequence").all(),
    statements: raw.prepare("SELECT * FROM procurement_attestations ORDER BY command_sequence").all(),
    documents: raw.prepare("SELECT * FROM procurement_documents ORDER BY command_sequence").all(),
    links: raw.prepare("SELECT * FROM procurement_attestation_evidence ORDER BY command_sequence,position").all(),
    originals: raw.prepare(`SELECT ${evidenceColumns} FROM procurement_evidence ORDER BY id`).all(),
    sequence: raw.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
    meta: raw.prepare("SELECT * FROM procurement_meta").all()
  };
}
function schema(raw) {
  return raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}

test("nonempty schema2 CHECK migration preserves all journals, BLOBs, links, sequence, indexes and triggers", async t => {
  const f = fixture(t); let store = f.open(); await seed(store, true);
  const before = store.read(), statements = store.getAttestations("c1"), metadata = store.getEvidenceMetadata("delivery-file");
  store.close(); const raw = f.raw(); downgradeToV2(raw);
  const old = persisted(raw), previousSchema = schema(raw);
  assert.throws(() => raw.prepare("UPDATE procurement_attestations SET method='resolveDispute' WHERE command_sequence=?").run(old.statements[0].command_sequence), /CHECK/);
  store = f.open();
  assert.deepEqual(persisted(raw), { ...old, meta: old.meta.map(row => Object.assign(Object.create(null), row, { schema_version: 3 })) });
  assert.deepEqual(store.read(), before); assert.deepEqual(store.getAttestations("c1"), statements);
  assert.deepEqual(store.getEvidenceMetadata("delivery-file"), metadata);
  assert.equal(Object.hasOwn(metadata.data, "reviewAssignmentId"), false);
  assert.deepEqual(store.getEvidence("delivery-file").content, png);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  for (const item of previousSchema.filter(item => ["old_evidence_contract", "old_evidence_guard"].includes(item.name)))
    assert.deepEqual(schema(raw).find(saved => saved.name === item.name), item);
  write(store, "assignReviewer", assignment());
  assert.throws(() => upload(store, "blocked", { filename: "blocked.png" }), /preserved guard/);
  upload(store); const result = review(store);
  assert.equal(result.version, before.version + 2);
  assert.equal(store.getAttestations("c1").data.at(-1).method, "resolveDispute");
  store.close(); const migratedSchema = schema(raw);
  assert.equal(f.open().read().batches[0].status, "PARTIAL");
  assert.deepEqual(schema(raw), migratedSchema);
});

test("failed evidence-table migration rolls back the already-rebuilt attestation table and every original row", async t => {
  const f = fixture(t), store = f.open(); await seed(store, true); store.close();
  const raw = f.raw(); downgradeToV2(raw);
  raw.exec("PRAGMA ignore_check_constraints=ON; UPDATE procurement_evidence SET size_bytes=0 WHERE id='delivery-file'; PRAGMA ignore_check_constraints=OFF");
  const before = persisted(raw), beforeSchema = schema(raw);
  assert.throws(() => f.open(), /CHECK/);
  assert.deepEqual(persisted(raw), before); assert.deepEqual(schema(raw), beforeSchema);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%review_migration%'").get().n, 0);
  raw.prepare("UPDATE procurement_evidence SET size_bytes=? WHERE id='delivery-file'").run(png.length);
  assert.equal(f.open().getAttestations("c1").data[0].evidence[0].id, "delivery-file");
});

test("migration rejects a dangling original link and restores the prior v2 schema transactionally", async t => {
  const f = fixture(t), store = f.open(); await seed(store, true); store.close();
  const raw = f.raw(); downgradeToV2(raw);
  raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM procurement_evidence WHERE id='delivery-file'");
  const before = persisted(raw), beforeSchema = schema(raw);
  assert.throws(() => f.open(), { code: "PROCUREMENT_FOREIGN_KEY_MISMATCH" });
  assert.deepEqual(persisted(raw), before); assert.deepEqual(schema(raw), beforeSchema);
});

test("review assignment metadata, statement, BLOB and link tampering fails reads and retries", async t => {
  const cases = [
    ["revision metadata", raw => raw.exec("UPDATE procurement_evidence SET review_assignment_id='another-revision' WHERE id='review-file'")],
    ["content", raw => raw.prepare("UPDATE procurement_evidence SET content=? WHERE id='review-file'").run(Buffer.alloc(png.length))],
    ["statement", raw => raw.exec("UPDATE procurement_attestations SET statement='forged statement' WHERE method='resolveDispute'")],
    ["deleted review link", raw => raw.exec("DELETE FROM procurement_attestation_evidence WHERE evidence_id='review-file'")],
    ["deleted original", raw => raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM procurement_evidence WHERE id='review-file'")],
    ["assignment reason", raw => {
      const input = JSON.parse(raw.prepare("SELECT input_json FROM procurement_commands WHERE method='assignReviewer'").get().input_json);
      input.reason = "Changed audit reason.";
      raw.prepare("UPDATE procurement_commands SET input_json=? WHERE method='assignReviewer'").run(JSON.stringify(input));
    }],
    ["assignment result", raw => raw.exec("UPDATE procurement_commands SET result_json='{}' WHERE method='assignReviewer'")]
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = fixture(t), store = f.open(); await seed(store); write(store, "assignReviewer", assignment()); upload(store); review(store);
    mutate(f.raw());
    assert.throws(() => store.getAttestations("c1"));
    assert.throws(() => review(store));
    assert.throws(() => write(store, "derivePayable", { batchId: "b1" }));
    if (name === "revision metadata") assert.throws(() => store.getEvidenceMetadata("review-file"), { code: "EVIDENCE_METADATA_MISMATCH" });
  });
});

test("participant IDs retain dispatcher and finance journal provenance without exposing user data or review actors", async t => {
  const f = fixture(t), store = f.open(); await seed(store);
  write(store, "derivePayable", { batchId: "b2" }, { actorId: "payable-operator" });
  write(store, "markPaymentPending", { batchId: "b2", paymentBusinessId: "pay-2", actor: finance, onChainEscrowConfirmed: true });
  write(store, "assignReviewer", assignment()); upload(store); review(store);
  const result = store.getParticipantActorIds("c1");
  assert.deepEqual(result, { data: ["quote-author", "former-dispatcher", "contract-author", "buyer-signer", "supplier-signer",
    deliveryActor.id, assessor.id, "payable-operator", finance.id] });
  assert.equal(new Set(result.data).size, result.data.length);
  for (const id of ["trusted-indexer", "admin-user", reviewer.id]) assert.ok(!result.data.includes(id));
  result.data.length = 0;
  assert.ok(store.getParticipantActorIds("c1").data.includes("former-dispatcher"));
  assert.throws(() => store.getParticipantActorIds("missing"), { code: "NOT_FOUND" });
  store.close(); const reopened = f.open();
  assert.ok(reopened.getParticipantActorIds("c1").data.includes("former-dispatcher"));
  assert.throws(() => store.getParticipantActorIds("c1"), { code: "STORE_CLOSED" });
  f.raw().exec("UPDATE procurement_commands SET input_json='{broken' WHERE method='reserve'");
  assert.throws(() => reopened.getParticipantActorIds("c1"));
});

test("participant provenance traverses quote and reservation IDs from every contract version and excludes unrelated commands", async t => {
  const f = fixture(t), store = f.open(); await seed(store);
  for (const suffix of ["old", "new", "unrelated"]) {
    write(store, "addQuote", { id: `q-${suffix}`, resourceId: "WATER", supplierOrganizationId: "supplier-org", supplierWallet: supplier.address,
      unitPriceWei: "12", availableQuantity: 2, validUntil: 5000, etaHours: 3 }, { actorId: `${suffix}-quoter` });
    write(store, "reserve", { id: `r-${suffix}`, quoteId: `q-${suffix}`, taskId: "TASK-2", quantity: 2,
      buyerWallet: buyer.address, buyerOrganizationId: "buyer-org", now: 1000 }, { actorId: `${suffix}-dispatcher` });
  }
  write(store, "createContract", { id: "c2", reservationId: "r-old", termsHash: digest(document.termsText),
    acceptanceCriteriaHash: digest(document.acceptanceText), nonce: "2", expiresAt: 4000, now: 1000 }, { document, actorId: "second-author" });
  write(store, "reviseContract", { contractId: "c2", reservationId: "r-new", nonce: "3", expiresAt: 4000, now: 1000 }, { actorId: "reviser" });
  assert.deepEqual(store.getParticipantActorIds("c2"), { data: ["old-quoter", "old-dispatcher", "new-quoter", "new-dispatcher", "second-author", "reviser"] });
  assert.ok(!store.getParticipantActorIds("c1").data.includes("reviser"));
});

test("v2 corrupt statement or original prevents upgrade commit and preserves schema and version", async t => {
  for (const target of ["statement", "content", "request_hash"]) await t.test(target, async t => {
    const f = fixture(t), store = f.open(); await seed(store, true); store.close();
    const raw = f.raw(); downgradeToV2(raw);
    if (target === "statement") raw.exec("UPDATE procurement_attestations SET statement='tampered original statement' WHERE method='deliverBatch'");
    else if (target === "content") raw.prepare("UPDATE procurement_evidence SET content=? WHERE id='delivery-file'").run(Buffer.alloc(png.length));
    else raw.exec("UPDATE procurement_commands SET request_hash='tampered hash' WHERE method='acceptBatch'");
    const before = persisted(raw), beforeSchema = schema(raw);
    assert.throws(() => f.open());
    assert.deepEqual(persisted(raw), before); assert.deepEqual(schema(raw), beforeSchema);
    assert.equal(raw.prepare("SELECT schema_version FROM procurement_meta").get().schema_version, 2);
  });
});

test("damaged or unknown v3 schema fails instead of silently recreating tables or columns", async t => {
  const damage = [
    ["missing evidence table", raw => raw.exec("PRAGMA foreign_keys=OFF; DROP TABLE procurement_evidence")],
    ["missing commands", raw => raw.exec("PRAGMA foreign_keys=OFF; DROP TABLE procurement_commands")],
    ["missing statement column", raw => raw.exec("ALTER TABLE procurement_attestations DROP COLUMN statement_hash")],
    ["missing review column and old CHECK", raw => { downgradeToV2(raw); raw.exec("UPDATE procurement_meta SET schema_version=3"); }],
    ["future version", raw => raw.exec("UPDATE procurement_meta SET schema_version=4")]
  ];
  for (const [name, mutate] of damage) await t.test(name, async t => {
    const f = fixture(t), store = f.open(); await seed(store, true); store.close(); const raw = f.raw();
    mutate(raw); const beforeSchema = schema(raw);
    assert.throws(() => f.open(), { code: name === "future version" ? "PROCUREMENT_SCHEMA_UNSUPPORTED" : "PROCUREMENT_SCHEMA_MISMATCH" });
    assert.deepEqual(schema(raw), beforeSchema);
  });
});
