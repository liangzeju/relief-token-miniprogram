"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { verifyTypedData, keccak256, toUtf8Bytes } = require("ethers");
const { createProcurementDomain } = require("./procurement-domain");
const { MAX_EVIDENCE_BYTES, sha256, validateFilename, validateContent, decodeEvidence } = require("./evidence-content");

function fail(code) { throw Object.assign(new Error(code), { code }); }
function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID_DATA");
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function encoded(value) { return JSON.stringify(canonical(value)); }
function key(value, code) { if (typeof value !== "string" || !value.trim() || value.length > 160) fail(code); return value; }
const attestationMethods = new Set(["deliverBatch", "acceptBatch", "resolveDispute"]);
function record(value, allowed, required, code) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      required.some(name => !Object.hasOwn(value, name))) fail(code);
  for (const name of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!allowed.includes(name) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}
function evidenceKey(value) {
  key(value, "INVALID_EVIDENCE_ID");
  if (!value.isWellFormed() || value.trim() !== value || /\p{Cc}/u.test(value)) fail("INVALID_EVIDENCE_ID");
}
function evidenceActor(value, method) {
  const fields = ["id", "organizationId", "wallet", "role"];
  record(value, fields, fields, "INVALID_EVIDENCE_ACTOR");
  evidenceKey(value.id); evidenceKey(value.organizationId);
  if (value.role !== ({ deliverBatch: "delivery", acceptBatch: "acceptance", resolveDispute: "reviewer" })[method] ||
      typeof value.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.wallet) || /^0x0{40}$/i.test(value.wallet)) fail("INVALID_EVIDENCE_ACTOR");
  return { id: value.id, organizationId: value.organizationId, wallet: value.wallet.toLowerCase(), role: value.role };
}
function validateAttestation(value) {
  record(value, ["statement", "evidenceIds"], ["statement"], "INVALID_ATTESTATION");
  const descriptor = Object.getOwnPropertyDescriptor(value, "statement");
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("INVALID_ATTESTATION");
  const statement = descriptor.value;
  // Match HTTP/textarea UTF-16 limits; ethers alone permits isolated low surrogates.
  if (typeof statement !== "string" || !statement.isWellFormed() ||
      statement.trim().length < 2 || statement.length > 16000) fail("INVALID_ATTESTATION");
  if (Object.hasOwn(value, "evidenceIds")) {
    const ids = value.evidenceIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 ||
        Reflect.ownKeys(ids).length !== ids.length + 1) fail("INVALID_ATTESTATION_EVIDENCE");
    for (let i = 0; i < ids.length; i++) {
      const item = Object.getOwnPropertyDescriptor(ids, String(i));
      if (!item || !item.enumerable || !Object.hasOwn(item, "value")) fail("INVALID_ATTESTATION_EVIDENCE");
      evidenceKey(item.value);
    }
    if (new Set(ids).size !== ids.length) fail("INVALID_ATTESTATION_EVIDENCE");
  }
  try { return keccak256(toUtf8Bytes(statement)); } catch { fail("INVALID_ATTESTATION"); }
}
function hashRequest(method, input, document, attestation) {
  // Server-supplied time changes on retries; signed expiry and all business fields do not.
  const { now, ...businessInput } = input;
  return crypto.createHash("sha256").update(encoded({ method, input: businessInput,
    ...(document === undefined ? {} : { document }),
    ...(attestation === undefined ? {} : { attestation }) })).digest("hex");
}
function validateDocument(document, input) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).some(name => !["termsText", "acceptanceText"].includes(name))) fail("INVALID_DOCUMENT");
  for (const name of ["termsText", "acceptanceText"]) {
    if (typeof document[name] !== "string" || document[name].length < 2 || document[name].length > 16000) fail("INVALID_DOCUMENT");
  }
  let termsHash, acceptanceCriteriaHash;
  try {
    termsHash = keccak256(toUtf8Bytes(document.termsText));
    acceptanceCriteriaHash = keccak256(toUtf8Bytes(document.acceptanceText));
  } catch { fail("INVALID_DOCUMENT"); }
  if (typeof input.termsHash !== "string" || typeof input.acceptanceCriteriaHash !== "string" ||
      termsHash !== input.termsHash.toLowerCase() || acceptanceCriteriaHash !== input.acceptanceCriteriaHash.toLowerCase()) fail("DOCUMENT_HASH_MISMATCH");
}

function attestationSchema(table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    command_sequence INTEGER NOT NULL UNIQUE REFERENCES procurement_commands(sequence),
    contract_id TEXT NOT NULL, contract_version INTEGER NOT NULL CHECK(contract_version > 0),
    batch_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('deliverBatch','acceptBatch','resolveDispute')),
    actor_id TEXT NOT NULL, statement TEXT NOT NULL, statement_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`;
}
function evidenceSchema(table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY NOT NULL, contract_id TEXT NOT NULL, contract_version INTEGER NOT NULL CHECK(contract_version > 0),
    batch_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('deliverBatch','acceptBatch','resolveDispute')),
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 5242880),
    sha256 TEXT NOT NULL, actor_id TEXT NOT NULL, actor_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL, content BLOB NOT NULL, review_assignment_id TEXT,
    UNIQUE(actor_id, request_key), CHECK((method='resolveDispute' AND review_assignment_id IS NOT NULL AND length(review_assignment_id)>0)
      OR (method!='resolveDispute' AND review_assignment_id IS NULL))
  )`;
}

function createProcurementStore({ file, chainId = "10143", escrowContract = null, clock = Date.now }) {
  if (escrowContract !== null && typeof escrowContract !== "string") fail("INVALID_ESCROW_CONTRACT");
  const config = { chainId: String(chainId), escrowContract: escrowContract ? escrowContract.toLowerCase() : null };
  const domainOptions = { chainId: config.chainId, verifyTypedData, ...(config.escrowContract ? { escrowContract: config.escrowContract } : {}) };
  const methods = new Set(Object.keys(createProcurementDomain(undefined, domainOptions)).filter(name => !name.startsWith("get") && !["snapshot", "exportState"].includes(name)));
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let closed = false;
  try {
    db.exec("PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    // SQLite requires disabling FK enforcement outside the schema transaction.
    // References are checked before commit and enforcement is restored afterward.
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS procurement_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, config_json TEXT NOT NULL)");
      const prior = db.prepare("SELECT * FROM procurement_meta WHERE id=1").get();
      if (prior && ![1, 2, 3].includes(prior.schema_version)) fail("PROCUREMENT_SCHEMA_UNSUPPORTED");
      if (prior?.schema_version === 3) assertCurrentSchema();
      db.exec(`CREATE TABLE IF NOT EXISTS procurement_commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, input_json TEXT NOT NULL,
        actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(actor_id, request_key)
      )`);
      if (!prior) db.prepare("INSERT INTO procurement_meta VALUES(1, 3, ?)").run(encoded(config));
      else if (prior.config_json !== encoded(config)) {
        const saved = JSON.parse(prior.config_json);
        const hasContracts = db.prepare("SELECT 1 FROM procurement_commands WHERE method='createContract' LIMIT 1").get();
        if (saved.chainId !== config.chainId || saved.escrowContract !== null || !config.escrowContract || hasContracts) fail("PROCUREMENT_CONFIG_MISMATCH");
        db.prepare("UPDATE procurement_meta SET config_json=? WHERE id=1").run(encoded(config));
      }
      db.exec(`CREATE TABLE IF NOT EXISTS procurement_documents (
        contract_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
        command_sequence INTEGER NOT NULL UNIQUE REFERENCES procurement_commands(sequence),
        terms_text TEXT NOT NULL, acceptance_text TEXT NOT NULL,
        PRIMARY KEY(contract_id, version)
      );
      ${attestationSchema("procurement_attestations")};
      ${evidenceSchema("procurement_evidence")};
      CREATE TABLE IF NOT EXISTS procurement_attestation_evidence (
        command_sequence INTEGER NOT NULL REFERENCES procurement_attestations(command_sequence),
        evidence_id TEXT PRIMARY KEY NOT NULL REFERENCES procurement_evidence(id),
        position INTEGER NOT NULL CHECK(position >= 0 AND position < 6), UNIQUE(command_sequence, position)
      );`);
      for (const [table, schema] of [["procurement_attestations", attestationSchema], ["procurement_evidence", evidenceSchema]]) {
        const saved = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
        if (saved.sql.includes("'resolveDispute'") && (table !== "procurement_evidence" || columns.includes("review_assignment_id"))) continue;
        const dependent = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
        const replacement = `${table}_review_migration`;
        db.exec(schema(replacement));
        const names = columns.map(name => `"${name.replaceAll('"', '""')}"`).join(",");
        db.exec(`INSERT INTO ${replacement}(rowid,${names}) SELECT rowid,${names} FROM ${table};
          DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table}`);
        for (const item of dependent) db.exec(item.sql);
      }
      assertCurrentSchema();
      if (prior && prior.schema_version !== 3) {
        if (db.prepare("PRAGMA foreign_key_check").all().length) fail("PROCUREMENT_FOREIGN_KEY_MISMATCH");
        verifiedAttestations();
        for (const row of db.prepare("SELECT id FROM procurement_evidence").all()) evidenceFor(row.id, true);
      }
      db.exec("UPDATE procurement_meta SET schema_version=3 WHERE id=1");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("PRAGMA foreign_keys=ON");
    hydrate();
  } catch (error) { db.close(); closed = true; throw error; }

  function assertCurrentSchema() {
    const required = {
      procurement_commands: "sequence method input_json actor_id request_key request_hash result_json created_at",
      procurement_documents: "contract_id version command_sequence terms_text acceptance_text",
      procurement_attestations: "command_sequence contract_id contract_version batch_id method actor_id statement statement_hash created_at",
      procurement_evidence: "id contract_id contract_version batch_id method filename mime_type size_bytes sha256 actor_id actor_json created_at request_key request_hash content review_assignment_id",
      procurement_attestation_evidence: "command_sequence evidence_id position"
    };
    for (const [table, names] of Object.entries(required)) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      if (columns.length !== names.split(" ").length || names.split(" ").some(name => !columns.includes(name))) fail("PROCUREMENT_SCHEMA_MISMATCH");
      if (["procurement_attestations", "procurement_evidence"].includes(table)) {
        const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!sql.includes("'resolveDispute'")) fail("PROCUREMENT_SCHEMA_MISMATCH");
      }
    }
  }

  function hydrate() {
    const rows = db.prepare("SELECT sequence, method, input_json FROM procurement_commands ORDER BY sequence").all();
    const domain = createProcurementDomain({ schemaVersion: 1, commands: rows.map(row => ({ method: row.method, input: JSON.parse(row.input_json) })) }, domainOptions);
    return { domain, version: rows.length ? rows[rows.length - 1].sequence : 0 };
  }
  function evidenceRequestHash(metadata, requestKey) {
    return sha256(encoded({ metadata, idempotencyKey: requestKey }));
  }
  function evidenceMetadata(row) {
    if (!row) fail("EVIDENCE_NOT_FOUND");
    const actor = JSON.parse(row.actor_json);
    const metadata = { id: row.id, contractId: row.contract_id, contractVersion: row.contract_version,
      batchId: row.batch_id, method: row.method, filename: row.filename, mimeType: row.mime_type,
      sizeBytes: row.size_bytes, sha256: row.sha256, actor, createdAt: row.created_at };
    if (row.method === "resolveDispute") {
      evidenceKey(row.review_assignment_id);
      metadata.reviewAssignmentId = row.review_assignment_id;
    } else if (row.review_assignment_id !== null) fail("EVIDENCE_METADATA_MISMATCH");
    for (const value of [metadata.id, metadata.contractId, metadata.batchId]) evidenceKey(value);
    validateFilename(metadata.filename, metadata.mimeType);
    if (!attestationMethods.has(metadata.method) || !Number.isSafeInteger(metadata.contractVersion) || metadata.contractVersion < 1 ||
        !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1 || metadata.sizeBytes > MAX_EVIDENCE_BYTES ||
        !["image/png", "image/jpeg", "application/pdf"].includes(metadata.mimeType) || !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
        !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0 || row.actor_id !== actor.id ||
        encoded(evidenceActor(actor, metadata.method)) !== encoded(actor) ||
        evidenceRequestHash(metadata, row.request_key) !== row.request_hash) fail("EVIDENCE_METADATA_MISMATCH");
    return metadata;
  }
  function evidenceFor(id, withContent = false) {
    evidenceKey(id);
    const row = db.prepare(`SELECT id,contract_id,contract_version,batch_id,method,filename,mime_type,size_bytes,
      sha256,actor_id,actor_json,created_at,request_key,request_hash,review_assignment_id${withContent ? ",content" : ""}
      FROM procurement_evidence WHERE id=?`).get(id);
    const data = evidenceMetadata(row);
    if (!withContent) return { data };
    if (!(row.content instanceof Uint8Array)) fail("EVIDENCE_CONTENT_MISMATCH");
    const content = Buffer.from(row.content);
    if (content.length !== data.sizeBytes || sha256(content) !== data.sha256) fail("EVIDENCE_CONTENT_MISMATCH");
    validateContent(content, data.mimeType);
    return { data, content };
  }
  function validateEvidenceScope(metadata, method, result, actor, reviewAssignmentId) {
    if (metadata.contractId !== result.contractId || metadata.contractVersion !== result.contractVersion ||
        metadata.batchId !== result.id || metadata.method !== method ||
        (method === "resolveDispute" && (metadata.reviewAssignmentId !== reviewAssignmentId ||
          metadata.reviewAssignmentId !== result.reviewAssignments?.at(-1)?.id)) ||
        encoded(metadata.actor) !== encoded(evidenceActor(actor, method))) fail("EVIDENCE_SCOPE_MISMATCH");
  }
  function uploadGate(domain, input, actor) {
    const contract = domain.getContract(input.contractId);
    if (contract.currentVersion !== input.contractVersion) fail("VERSION_MISMATCH");
    if (!["FUNDS_RESERVED", "IN_FULFILLMENT"].includes(contract.status)) fail("FUNDS_RESERVED_REQUIRED");
    const terms = contract.versions[contract.currentVersion - 1];
    const escrow = domain.getEscrow(contract.escrowBusinessId);
    if (escrow.status !== "CONFIRMED" || escrow.contractId !== contract.id || escrow.contractVersion !== terms.version ||
        escrow.chainId !== terms.chainId || escrow.escrowContract !== terms.escrowContract ||
        escrow.value !== (BigInt(terms.unitPriceWei) * BigInt(terms.quantity)).toString()) fail("ESCROW_NOT_CONFIRMED");
    // Run the existing domain authority checks on this disposable replay, never
    // append these probes to the stored business journal.
    if (input.method === "deliverBatch") {
      domain.deliverBatch({ id: input.batchId, contractId: input.contractId, quantity: 1, actor });
    } else {
      const batch = domain.getBatch(input.batchId);
      if (batch.contractId !== input.contractId || batch.contractVersion !== input.contractVersion) fail("EVIDENCE_SCOPE_MISMATCH");
      if (input.method === "resolveDispute") {
        const assignment = batch.reviewAssignments?.at(-1);
        if (!assignment || input.reviewAssignmentId !== assignment.id) fail("REVIEW_ASSIGNMENT_MISMATCH");
        domain.resolveDispute({ batchId: input.batchId, acceptedQuantity: 0, actor, reviewAssignmentId: assignment.id });
      } else {
        domain.acceptBatch({ batchId: input.batchId, outcome: "REJECTED", acceptedQuantity: 0, actor });
      }
    }
  }
  function putEvidence({ input, actor, idempotencyKey }) {
    if (closed) fail("STORE_CLOSED");
    const fields = ["id", "contractId", "contractVersion", "batchId", "method", "filename", "mimeType", "contentBase64"];
    record(input, [...fields, "reviewAssignmentId"], fields, "INVALID_EVIDENCE");
    for (const value of [input.id, input.contractId, input.batchId]) evidenceKey(value);
    key(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
    if (!attestationMethods.has(input.method)) fail("EVIDENCE_METHOD_NOT_ALLOWED");
    if (input.method === "resolveDispute") evidenceKey(input.reviewAssignmentId);
    else if (Object.hasOwn(input, "reviewAssignmentId")) fail("INVALID_EVIDENCE");
    if (!Number.isSafeInteger(input.contractVersion) || input.contractVersion < 1) fail("INVALID_EVIDENCE_VERSION");
    validateFilename(input.filename, input.mimeType);
    const uploadActor = evidenceActor(actor, input.method), content = decodeEvidence(input.contentBase64, input.mimeType);
    const metadata = { id: input.id, contractId: input.contractId, contractVersion: input.contractVersion,
      batchId: input.batchId, method: input.method, filename: input.filename, mimeType: input.mimeType,
      sizeBytes: content.length, sha256: sha256(content), actor: uploadActor };
    if (input.method === "resolveDispute") metadata.reviewAssignmentId = input.reviewAssignmentId;
    db.exec("BEGIN IMMEDIATE");
    try {
      const { domain } = verifiedAttestations();
      const previous = db.prepare("SELECT id FROM procurement_evidence WHERE actor_id=? AND request_key=?").get(uploadActor.id, idempotencyKey);
      if (previous) {
        const { data } = evidenceFor(previous.id, true);
        if (encoded({ ...metadata, createdAt: data.createdAt }) !== encoded(data)) fail("IDEMPOTENCY_KEY_REUSED");
        db.exec("COMMIT"); return { data, replayed: true };
      }
      if (db.prepare("SELECT 1 FROM procurement_evidence WHERE id=?").get(input.id)) fail("EVIDENCE_ID_CONFLICT");
      uploadGate(domain, input, uploadActor);
      // Validate committed metadata before counting; pending uploads consume quota too.
      const saved = db.prepare(`SELECT id,contract_id,contract_version,batch_id,method,filename,mime_type,size_bytes,
        sha256,actor_id,actor_json,created_at,request_key,request_hash,review_assignment_id FROM procurement_evidence`).all().map(evidenceMetadata);
      const contractFiles = saved.filter(item => item.contractId === input.contractId);
      if (contractFiles.length >= 100 || contractFiles.reduce((sum, item) => sum + item.sizeBytes, content.length) > 50 * 1024 * 1024)
        fail("EVIDENCE_QUOTA_EXCEEDED");
      metadata.createdAt = clock();
      if (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0) fail("INVALID_EVIDENCE_TIMESTAMP");
      const requestHash = evidenceRequestHash(metadata, idempotencyKey);
      db.prepare(`INSERT INTO procurement_evidence(id,contract_id,contract_version,batch_id,method,filename,mime_type,
        size_bytes,sha256,actor_id,actor_json,created_at,request_key,request_hash,content,review_assignment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(metadata.id, metadata.contractId, metadata.contractVersion, metadata.batchId, metadata.method, metadata.filename,
          metadata.mimeType, metadata.sizeBytes, metadata.sha256, uploadActor.id, encoded(uploadActor), metadata.createdAt,
          idempotencyKey, requestHash, content, metadata.reviewAssignmentId ?? null);
      db.exec("COMMIT"); return { data: metadata, replayed: false };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function verifiedAttestations() {
    const rows = new Map(db.prepare("SELECT * FROM procurement_attestations ORDER BY command_sequence").all()
      .map(row => [row.command_sequence, row]));
    const commands = db.prepare("SELECT * FROM procurement_commands ORDER BY sequence").all();
    const links = new Map();
    for (const link of db.prepare("SELECT * FROM procurement_attestation_evidence ORDER BY command_sequence,position").all()) {
      if (!links.has(link.command_sequence)) links.set(link.command_sequence, []);
      links.get(link.command_sequence).push(link);
    }
    const domain = createProcurementDomain(undefined, domainOptions), data = [];
    for (const command of commands) {
      const input = JSON.parse(command.input_json);
      if (!methods.has(command.method)) fail("ATTESTATION_COMMAND_MISMATCH");
      const result = domain[command.method](input), row = rows.get(command.sequence);
      if (command.method === "assignReviewer" && (command.request_hash !== hashRequest(command.method, input) ||
          encoded(JSON.parse(command.result_json)) !== encoded(result))) fail("REVIEW_ASSIGNMENT_COMMAND_MISMATCH");
      if (!row && !attestationMethods.has(command.method)) continue;
      // The original request hash commits to presence as well as exact text, so
      // deleting a new record cannot turn it into a historical text-free command.
      if (!row) {
        if (command.request_hash !== hashRequest(command.method, input)) fail("ATTESTATION_MISSING");
        continue;
      }
      const attached = links.get(command.sequence) || [];
      if (attached.some((link, index) => link.position !== index)) fail("ATTESTATION_EVIDENCE_MISMATCH");
      const attestation = { statement: row.statement,
        ...(attached.length ? { evidenceIds: attached.map(link => link.evidence_id) } : {}) };
      if (validateAttestation(attestation) !== row.statement_hash) fail("ATTESTATION_HASH_MISMATCH");
      if (!attestationMethods.has(command.method) || row.method !== command.method ||
          command.request_hash !== hashRequest(command.method, input, undefined, attestation) ||
          encoded(JSON.parse(command.result_json)) !== encoded(result) ||
          row.contract_id !== result.contractId || row.contract_version !== result.contractVersion ||
          row.batch_id !== result.id || row.actor_id !== input.actor.id || row.actor_id !== command.actor_id ||
          row.created_at !== command.created_at) fail("ATTESTATION_COMMAND_MISMATCH");
      const evidence = attached.map(link => {
        const { data } = evidenceFor(link.evidence_id, true);
        validateEvidenceScope(data, command.method, result, input.actor, input.reviewAssignmentId);
        return data;
      });
      data.push({ commandSequence: row.command_sequence, contractId: row.contract_id,
        contractVersion: row.contract_version, batchId: row.batch_id, method: row.method, actorId: row.actor_id,
        statement: row.statement, statementHash: row.statement_hash, createdAt: row.created_at,
        actor: { ...input.actor }, evidence });
      rows.delete(command.sequence);
      links.delete(command.sequence);
    }
    if (rows.size) fail("ATTESTATION_COMMAND_MISSING");
    if (links.size) fail("ATTESTATION_EVIDENCE_MISMATCH");
    return { domain, data, version: commands.length ? commands[commands.length - 1].sequence : 0 };
  }
  function execute({ method, input, actorId, idempotencyKey, expectedVersion, document, attestation }) {
    if (closed) fail("STORE_CLOSED");
    if (!methods.has(method)) fail("UNKNOWN_COMMAND");
    key(actorId, "INVALID_ACTOR"); key(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail("EXPECTED_VERSION_REQUIRED");
    const commandInput = canonical(input);
    const commandDocument = document === undefined ? undefined : canonical(document);
    if (commandDocument !== undefined) {
      if (method !== "createContract") fail("DOCUMENT_NOT_ALLOWED");
      validateDocument(commandDocument, commandInput);
    }
    let commandAttestation, statementHash;
    if (attestation !== undefined) {
      if (!attestationMethods.has(method)) fail("ATTESTATION_NOT_ALLOWED");
      statementHash = validateAttestation(attestation);
      commandAttestation = { statement: attestation.statement,
        ...(Object.hasOwn(attestation, "evidenceIds") ? { evidenceIds: [...attestation.evidenceIds] } : {}) };
      if (!commandInput.actor || commandInput.actor.id !== actorId) fail("ATTESTATION_ACTOR_MISMATCH");
    }
    const requestHash = hashRequest(method, commandInput, commandDocument, commandAttestation);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (method === "signContract") documentFor(hydrate().domain.getContract(commandInput.contractId));
      const previous = db.prepare("SELECT * FROM procurement_commands WHERE actor_id=? AND request_key=?").get(actorId, idempotencyKey);
      if (previous) {
        if (previous.request_hash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED");
        if (attestationMethods.has(method) || method === "assignReviewer") verifiedAttestations();
        const result = JSON.parse(previous.result_json);
        db.exec("COMMIT");
        return { data: result, version: previous.sequence, replayed: true };
      }
      const { domain, version } = verifiedAttestations();
      if (expectedVersion !== version) fail("VERSION_CONFLICT");
      const result = domain[method](commandInput);
      const evidenceIds = commandAttestation?.evidenceIds || [];
      for (const id of evidenceIds) {
        const { data } = evidenceFor(id, true);
        if (db.prepare("SELECT 1 FROM procurement_attestation_evidence WHERE evidence_id=?").get(id)) fail("EVIDENCE_ALREADY_BOUND");
        validateEvidenceScope(data, method, result, commandInput.actor, commandInput.reviewAssignmentId);
      }
      const createdAt = clock();
      const row = db.prepare("INSERT INTO procurement_commands(method,input_json,actor_id,request_key,request_hash,result_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(method, encoded(commandInput), actorId, idempotencyKey, requestHash, encoded(result), createdAt);
      if (commandDocument !== undefined) {
        db.prepare("INSERT INTO procurement_documents(contract_id,version,command_sequence,terms_text,acceptance_text) VALUES(?,?,?,?,?)")
          .run(result.id, result.currentVersion, row.lastInsertRowid, commandDocument.termsText, commandDocument.acceptanceText);
      }
      if (commandAttestation !== undefined) {
        db.prepare(`INSERT INTO procurement_attestations(command_sequence,contract_id,contract_version,batch_id,method,actor_id,statement,statement_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(row.lastInsertRowid, result.contractId, result.contractVersion,
          result.id, method, commandInput.actor.id, commandAttestation.statement, statementHash, createdAt);
        for (const [position, id] of evidenceIds.entries()) {
          db.prepare("INSERT INTO procurement_attestation_evidence(command_sequence,evidence_id,position) VALUES(?,?,?)")
            .run(row.lastInsertRowid, id, position);
        }
      }
      db.exec("COMMIT");
      return { data: result, version: Number(row.lastInsertRowid), replayed: false };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function read() {
    if (closed) fail("STORE_CLOSED");
    const { domain, version } = hydrate();
    return { version, ...domain.snapshot(), configuration: { ...config, signingReady: !!config.escrowContract } };
  }
  function documentFor(contract) {
    const terms = contract.versions[contract.currentVersion - 1];
    const row = db.prepare("SELECT terms_text, acceptance_text FROM procurement_documents WHERE contract_id=? AND version=?")
      .get(contract.id, terms.version);
    if (!row) fail("CONTRACT_DOCUMENT_MISSING");
    const document = { termsText: row.terms_text, acceptanceText: row.acceptance_text };
    validateDocument(document, terms);
    return { contractId: contract.id, version: terms.version, ...document,
      termsHash: terms.termsHash, acceptanceCriteriaHash: terms.acceptanceCriteriaHash };
  }
  return {
    execute, read, putEvidence,
    getEvidenceMetadata(id) {
      if (closed) fail("STORE_CLOSED");
      return evidenceFor(id);
    },
    getEvidence(id) {
      if (closed) fail("STORE_CLOSED");
      return evidenceFor(id, true);
    },
    getParticipantActorIds(id) {
      if (closed) fail("STORE_CLOSED");
      db.exec("BEGIN");
      try {
        const { domain } = verifiedAttestations(), contract = domain.getContract(id);
        const quoteIds = new Set(contract.versions.map(terms => terms.quoteId));
        const reservationIds = new Set(contract.versions.map(terms => terms.reservationId));
        const batchIds = new Set(domain.snapshot().batches.filter(batch => batch.contractId === id).map(batch => batch.id));
        const participants = new Set();
        for (const row of db.prepare("SELECT method,input_json,actor_id FROM procurement_commands ORDER BY sequence").all()) {
          const input = JSON.parse(row.input_json);
          const relevant = (row.method === "addQuote" && quoteIds.has(input.id)) ||
            (row.method === "reserve" && reservationIds.has(input.id)) ||
            (row.method === "createContract" && input.id === id) ||
            (["reviseContract", "signContract", "deliverBatch"].includes(row.method) && input.contractId === id) ||
            (["acceptBatch", "markPaymentPending", "derivePayable"].includes(row.method) && batchIds.has(input.batchId));
          if (relevant) participants.add(key(row.actor_id, "INVALID_ACTOR"));
        }
        db.exec("COMMIT"); return { data: [...participants] };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    getAttestations(id) {
      if (closed) fail("STORE_CLOSED");
      // Keep journal replay and record validation on the same SQLite snapshot.
      db.exec("BEGIN");
      try {
        const { domain, data, version } = verifiedAttestations();
        domain.getContract(id);
        db.exec("COMMIT");
        return { data: data.filter(row => row.contractId === id), version };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    getDocument(id) {
      if (closed) fail("STORE_CLOSED");
      const { domain } = hydrate(); return { data: documentFor(domain.getContract(id)) };
    },
    getTypedData(id) {
      if (closed) fail("STORE_CLOSED");
      const { domain, version } = hydrate();
      documentFor(domain.getContract(id));
      return { data: domain.getTypedData(id), version };
    },
    close() { if (!closed) { db.close(); closed = true; } }
  };
}

module.exports = { createProcurementStore };
