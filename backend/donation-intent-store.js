"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { getAddress } = require("ethers");

const PROFILE_FIELDS = ["id", "name", "email", "organization", "wallet", "registeredAt", "emailVerified",
  "emailTestVerified", "emailTestVerifiedAt", "emailVerificationMode"];
const TERM_FIELDS = ["donationId", "purpose", "projectId", "amountWei", "gasReservedWei", "nonce", "deadline",
  "authorizationEpoch", "feePolicyHash", "registrar"];
const DOMAIN = "ReliefDonationIntent:private-registration:v1";
const SCHEMA = [
  ["table", "donation_intent_meta", `CREATE TABLE donation_intent_meta (
    id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, chain_id TEXT NOT NULL, pool_address TEXT NOT NULL
  )`],
  ["table", "donation_intents", `CREATE TABLE donation_intents (
    donation_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, wallet TEXT NOT NULL, nonce TEXT NOT NULL,
    registration_hash TEXT NOT NULL, created_at INTEGER NOT NULL, record_json TEXT NOT NULL,
    UNIQUE(wallet, nonce)
  )`],
  ["trigger", "donation_intents_no_update", `CREATE TRIGGER donation_intents_no_update BEFORE UPDATE ON donation_intents
    BEGIN SELECT RAISE(ABORT,'DONATION_INTENT_IMMUTABLE'); END`],
  ["trigger", "donation_intents_no_delete", `CREATE TRIGGER donation_intents_no_delete BEFORE DELETE ON donation_intents
    BEGIN SELECT RAISE(ABORT,'DONATION_INTENT_IMMUTABLE'); END`],
  ["trigger", "donation_intents_no_replace", `CREATE TRIGGER donation_intents_no_replace BEFORE INSERT ON donation_intents
    WHEN EXISTS(SELECT 1 FROM donation_intents WHERE donation_id=NEW.donation_id OR (wallet=NEW.wallet AND nonce=NEW.nonce))
    BEGIN SELECT RAISE(ABORT,'DONATION_INTENT_IMMUTABLE'); END`]
];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value, code) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
}
function pick(value, fields, code, exact = false) {
  object(value, code);
  if (exact && (Reflect.ownKeys(value).length !== fields.length || Reflect.ownKeys(value).some(key => !fields.includes(key)))) fail(code);
  const result = {};
  for (const field of fields) {
    const item = Object.getOwnPropertyDescriptor(value, field);
    if (!item || !item.enumerable || !Object.hasOwn(item, "value")) fail(code);
    result[field] = item.value;
  }
  return result;
}
function text(value, maximum, code, optional = false) {
  if (typeof value !== "string" || value.length > maximum || !value.isWellFormed() ||
      (!optional && !value.trim()) || /[<>\p{Cc}]/u.test(value)) fail(code);
  return value.trim();
}
function address(value, code) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) fail(code);
  try { return getAddress(value).toLowerCase(); } catch { fail(code); }
}
function userId(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) fail(code);
  return value;
}
function bytes32(value, code, zero = false) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || (!zero && /^0x0{64}$/i.test(value))) fail(code);
  return value.toLowerCase();
}
function uint256(value, code, positive = false) {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value) ||
      BigInt(value) >= (1n << 256n) || (positive && value === "0")) fail(code);
  return value;
}
function iso(value) {
  if (typeof value !== "string" || value.length > 30 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail("INVALID_DONATION_PROFILE");
  return value;
}
function normalizeProfile(value) {
  const code = "INVALID_DONATION_PROFILE", p = pick(value, PROFILE_FIELDS, code);
  const email = text(p.email, 254, code).toLowerCase(), parts = email.split("@");
  if (parts.length !== 2 || parts[0].length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0]) ||
      parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..") || !parts[1].includes(".") ||
      parts[1].split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail(code);
  if (p.emailVerified !== false || typeof p.emailTestVerified !== "boolean" ||
      !["local-test", "disabled"].includes(p.emailVerificationMode) ||
      (p.emailTestVerified ? typeof p.emailTestVerifiedAt !== "string" : p.emailTestVerifiedAt !== null)) fail(code);
  const registeredAt = iso(p.registeredAt), emailTestVerifiedAt = p.emailTestVerified ? iso(p.emailTestVerifiedAt) : null;
  if (emailTestVerifiedAt && Date.parse(emailTestVerifiedAt) < Date.parse(registeredAt)) fail(code);
  return { id: userId(p.id, code), name: text(p.name, 120, code), email,
    organization: text(p.organization, 160, code, true), wallet: address(p.wallet, code), registeredAt,
    emailVerified: false, emailTestVerified: p.emailTestVerified, emailTestVerifiedAt, emailVerificationMode: p.emailVerificationMode };
}
function normalizeTerms(value) {
  const code = "INVALID_DONATION_TERMS", t = pick(value, TERM_FIELDS, code, true);
  if (!Number.isInteger(t.purpose) || t.purpose < 0 || t.purpose > 5) fail(code);
  const result = { donationId: bytes32(t.donationId, code), purpose: t.purpose, projectId: bytes32(t.projectId, code, true),
    amountWei: uint256(t.amountWei, code, true), gasReservedWei: uint256(t.gasReservedWei, code),
    nonce: uint256(t.nonce, code), deadline: uint256(t.deadline, code, true), authorizationEpoch: uint256(t.authorizationEpoch, code),
    feePolicyHash: bytes32(t.feePolicyHash, code), registrar: address(t.registrar, code) };
  if (BigInt(result.gasReservedWei) > BigInt(result.amountWei)) fail(code);
  return result;
}
function commitment(config, profile, terms, salt, createdAt) {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify({ domain: DOMAIN, schemaVersion: 1,
    chainId: config.chainId, poolAddress: config.poolAddress, profile, terms, salt, createdAt }), "utf8").digest("hex");
}
function makeRecord(config, profile, terms, salt, createdAt) {
  const registrationHash = commitment(config, profile, terms, salt, createdAt);
  return { schemaVersion: 1, chainId: config.chainId, poolAddress: config.poolAddress, userId: profile.id, wallet: profile.wallet,
    registrationHash, permit: { donationId: terms.donationId, donor: profile.wallet, purpose: terms.purpose, projectId: terms.projectId,
      amountWei: terms.amountWei, gasReservedWei: terms.gasReservedWei, registrationHash, nonce: terms.nonce,
      deadline: terms.deadline, authorizationEpoch: terms.authorizationEpoch, feePolicyHash: terms.feePolicyHash, registrar: terms.registrar },
    profile, salt, createdAt };
}
const sqlShape = sql => sql.trim().replace(/\s+/g, " ");

// Private prepared intents only. This module neither signs nor confirms donations.
function createDonationIntentStore({ file, chainId, poolAddress, clock = Date.now }) {
  const configCode = "INVALID_DONATION_STORE_CONFIG";
  if (typeof file !== "string" || !file || file === ":memory:" || typeof clock !== "function" ||
      (typeof chainId === "number" && !Number.isSafeInteger(chainId)) || !["number", "bigint", "string"].includes(typeof chainId)) fail(configCode);
  const config = { chainId: uint256(String(chainId), configCode, true), poolAddress: address(poolAddress, configCode) };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { const fd = fs.openSync(file, "wx", 0o600); fs.closeSync(fd); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("DONATION_INTENT_FILE_INVALID");
  const mayInitialize = info.size === 0;
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  let closed = false;
  try {
    db.exec("PRAGMA busy_timeout=3000");
    // Inspect ownership before changing journal mode or creating any schema.
    checkSchema(mayInitialize);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      if (!checkSchema(mayInitialize)) {
        for (const [, , sql] of SCHEMA) db.exec(sql);
        db.prepare("INSERT INTO donation_intent_meta VALUES(1,1,?,?)").run(config.chainId, config.poolAddress);
      }
      readAll();
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { db.close(); closed = true; throw error; }

  function checkSchema(allowEmpty = false) {
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    if (!objects.length && allowEmpty) return false;
    if (objects.length !== SCHEMA.length || SCHEMA.some(([type, name, sql]) =>
      !objects.some(item => item.type === type && item.name === name && sqlShape(item.sql) === sqlShape(sql)))) fail("DONATION_INTENT_SCHEMA_MISMATCH");
    const rows = db.prepare("SELECT * FROM donation_intent_meta").all(), meta = rows[0];
    if (rows.length !== 1 || meta.id !== 1) fail("DONATION_INTENT_SCHEMA_MISMATCH");
    if (meta.schema_version !== 1) fail("DONATION_INTENT_SCHEMA_UNSUPPORTED");
    if (meta.chain_id !== config.chainId || meta.pool_address !== config.poolAddress) fail("DONATION_INTENT_CONFIG_MISMATCH");
    return true;
  }
  function validateRow(row) {
    try {
      if (typeof row.record_json !== "string" || row.record_json.length > 16000) fail("DONATION_INTENT_CORRUPT");
      const saved = JSON.parse(row.record_json), profile = normalizeProfile(saved.profile);
      const terms = normalizeTerms(pick(saved.permit, TERM_FIELDS, "DONATION_INTENT_CORRUPT"));
      if (typeof saved.salt !== "string" || !/^0x[0-9a-f]{64}$/.test(saved.salt) ||
          !Number.isSafeInteger(saved.createdAt) || saved.createdAt < 0) fail("DONATION_INTENT_CORRUPT");
      const record = makeRecord(config, profile, terms, saved.salt, saved.createdAt);
      if (JSON.stringify(record) !== row.record_json || row.donation_id !== record.permit.donationId || row.user_id !== record.userId ||
          row.wallet !== record.wallet || row.nonce !== record.permit.nonce || row.registration_hash !== record.registrationHash ||
          row.created_at !== record.createdAt) fail("DONATION_INTENT_CORRUPT");
      return record;
    } catch { fail("DONATION_INTENT_CORRUPT"); }
  }
  function readAll() {
    checkSchema();
    // O(n) integrity scan before filtering: corrupted lookup fields cannot hide records.
    return db.prepare("SELECT * FROM donation_intents ORDER BY created_at,donation_id").all().map(validateRow);
  }
  function transaction(action, write = false) {
    if (closed) fail("STORE_CLOSED");
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    prepare({ profile, terms }) {
      if (closed) fail("STORE_CLOSED");
      const snapshot = normalizeProfile(profile), normalizedTerms = normalizeTerms(terms);
      return transaction(() => {
        const records = readAll(), previous = records.find(record => record.permit.donationId === normalizedTerms.donationId);
        if (previous) {
          const retry = makeRecord(config, snapshot, normalizedTerms, previous.salt, previous.createdAt);
          if (JSON.stringify(retry) !== JSON.stringify(previous)) fail("DONATION_INTENT_CONFLICT");
          return previous;
        }
        if (records.some(record => record.wallet === snapshot.wallet && record.permit.nonce === normalizedTerms.nonce)) fail("DONATION_INTENT_NONCE_CONFLICT");
        const createdAt = clock();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail("INVALID_DONATION_INTENT_TIME");
        const salt = "0x" + crypto.randomBytes(32).toString("hex"), record = makeRecord(config, snapshot, normalizedTerms, salt, createdAt);
        db.prepare(`INSERT INTO donation_intents(donation_id,user_id,wallet,nonce,registration_hash,created_at,record_json)
          VALUES(?,?,?,?,?,?,?)`).run(record.permit.donationId, record.userId, record.wallet, record.permit.nonce,
          record.registrationHash, record.createdAt, JSON.stringify(record));
        return record;
      }, true);
    },
    get(donationId) {
      if (closed) fail("STORE_CLOSED");
      const id = bytes32(donationId, "INVALID_DONATION_ID");
      return transaction(() => readAll().find(record => record.permit.donationId === id) || null);
    },
    listForUser(idValue) {
      if (closed) fail("STORE_CLOSED");
      const id = userId(idValue, "INVALID_DONATION_USER_ID");
      return transaction(() => readAll().filter(record => record.userId === id));
    },
    list() { return transaction(() => readAll()); },
    close() { if (!closed) { db.close(); closed = true; } }
  };
}

module.exports = { createDonationIntentStore };
