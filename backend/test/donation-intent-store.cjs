"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { getAddress } = require("ethers");
const { createDonationIntentStore } = require("../donation-intent-store");

const pool = "0x" + "ab".repeat(20), wallet = "0x" + "cd".repeat(20), registrar = "0x" + "ef".repeat(20);
const id = "0x" + "12".repeat(32), otherId = "0x" + "34".repeat(32), zero = "0x" + "00".repeat(32);
const clock = () => 1700000000123;
const profile = (changes = {}) => ({ id: "user-1", name: "Test Donor", email: "donor@example.test", organization: "Test Organization",
  wallet, registeredAt: "2023-01-01T00:00:00.000Z", emailVerified: false, emailTestVerified: false,
  emailTestVerifiedAt: null, emailVerificationMode: "disabled", ...changes });
const terms = (changes = {}) => ({ donationId: id, purpose: 0, projectId: zero, amountWei: "1000000000000000000",
  gasReservedWei: "1000", nonce: "0", deadline: "1800000000", authorizationEpoch: "0",
  feePolicyHash: "0x" + "56".repeat(32), registrar, ...changes });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-donation-intents-")), file = path.join(dir, "intents.sqlite");
  const stores = [], databases = [];
  const open = (options = {}) => {
    const store = createDonationIntentStore({ file, chainId: "10143", poolAddress: pool, clock, ...options });
    stores.push(store); return store;
  };
  const raw = () => { const db = new DatabaseSync(file); databases.push(db); return db; };
  t.after(() => {
    stores.forEach(store => store.close()); databases.forEach(db => db.close());
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("relief-donation-intents-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, open, raw };
}
function prepare(store, profileChanges = {}, termChanges = {}) {
  return store.prepare({ profile: profile(profileChanges), terms: terms(termChanges) });
}
function mutate(raw, action) {
  const guards = raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  for (const guard of guards) raw.exec(`DROP TRIGGER ${guard.name}`);
  try { action(); } finally { for (const guard of guards) raw.exec(guard.sql); }
}
function schema(raw) { return raw.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(); }

test("prepares a salted immutable private record with the exact permit and verifies its deterministic commitment", t => {
  const f = fixture(t), store = f.open(), result = prepare(store);
  assert.deepEqual(Object.keys(result), ["schemaVersion", "chainId", "poolAddress", "userId", "wallet", "registrationHash", "permit", "profile", "salt", "createdAt"]);
  assert.equal(result.schemaVersion, 1); assert.equal(result.chainId, "10143"); assert.equal(result.poolAddress, pool);
  assert.equal(result.userId, "user-1"); assert.equal(result.wallet, wallet); assert.equal(result.createdAt, clock());
  assert.match(result.salt, /^0x[0-9a-f]{64}$/); assert.match(result.registrationHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(result.permit, { donationId: id, donor: wallet, purpose: 0, projectId: zero, amountWei: terms().amountWei,
    gasReservedWei: "1000", registrationHash: result.registrationHash, nonce: "0", deadline: "1800000000", authorizationEpoch: "0",
    feePolicyHash: terms().feePolicyHash, registrar });
  const expected = "0x" + crypto.createHash("sha256").update(JSON.stringify({ domain: "ReliefDonationIntent:private-registration:v1",
    schemaVersion: 1, chainId: "10143", poolAddress: pool, profile: profile(), terms: terms(), salt: result.salt, createdAt: clock() })).digest("hex");
  assert.equal(result.registrationHash, expected);
  assert.deepEqual(store.get(id), result); assert.deepEqual(store.listForUser("user-1"), [result]);
  assert.equal(store.get(otherId), null); assert.deepEqual(store.listForUser("unknown"), []);
  const raw = f.raw();
  assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(raw.prepare("SELECT count(*) AS n FROM donation_intents").get().n, 1);
  assert.ok(!JSON.stringify(result).includes("confirmed"));
});

test("normalization, exact retries, restart, independent connections and returned copies preserve original salt", t => {
  const f = fixture(t); let store = f.open();
  const result = prepare(store, { name: " Test Donor ", email: "DONOR@EXAMPLE.TEST", wallet: "0x" + "CD".repeat(20) },
    { registrar: "0x" + "EF".repeat(20), feePolicyHash: "0x" + "56".repeat(32) });
  assert.deepEqual(result.profile, profile()); assert.deepEqual(prepare(store), result);
  assert.deepEqual(prepare(f.open()), result);
  const snapshot = structuredClone(result);
  result.profile.name = "changed"; result.permit.amountWei = "1"; result.salt = zero;
  store.listForUser("user-1")[0].profile.id = "different";
  assert.deepEqual(store.get(id), snapshot);
  store.close(); store = f.open({ chainId: 10143, poolAddress: "0x" + "AB".repeat(20), clock: () => 999 });
  assert.deepEqual(prepare(store), snapshot);
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM donation_intents").get().n, 1);
});

test("the same donation ID cannot change normalized terms, profile or ownership", t => {
  const store = fixture(t).open(), original = prepare(store);
  for (const changes of [{ purpose: 5 }, { projectId: otherId }, { amountWei: "2000000000000000000" }, { gasReservedWei: "0" },
    { nonce: "1" }, { deadline: "1800000001" }, { authorizationEpoch: "1" }, { feePolicyHash: otherId }, { registrar: pool }])
    assert.throws(() => prepare(store, {}, changes), { code: "DONATION_INTENT_CONFLICT" });
  for (const changes of [{ id: "other-user" }, { name: "Other Name" }, { email: "other@example.test" }, { organization: "Other Org" },
    { wallet: pool }, { registeredAt: "2022-01-01T00:00:00.000Z" }, { emailVerificationMode: "local-test" },
    { emailVerificationMode: "local-test", emailTestVerified: true, emailTestVerifiedAt: "2023-01-02T00:00:00.000Z" }])
    assert.throws(() => prepare(store, changes), { code: "DONATION_INTENT_CONFLICT" });
  assert.deepEqual(store.get(id), original);
});

test("donor plus nonce is unique across IDs and users in the configured chain and pool", t => {
  const f = fixture(t), store = f.open(); prepare(store);
  assert.throws(() => prepare(f.open(), {}, { donationId: otherId }), { code: "DONATION_INTENT_NONCE_CONFLICT" });
  assert.throws(() => prepare(store, { id: "user-2" }, { donationId: otherId }), { code: "DONATION_INTENT_NONCE_CONFLICT" });
  const next = prepare(store, {}, { donationId: otherId, nonce: "1" });
  assert.equal(store.listForUser("user-1").length, 2);
  assert.notEqual(next.salt, store.get(id).salt); assert.notEqual(next.registrationHash, store.get(id).registrationHash);
  const third = prepare(store, { id: "user-2", wallet: pool }, { donationId: "0x" + "78".repeat(32) });
  assert.deepEqual(store.listForUser("user-2"), [third]);
});

test("profile whitelist never persists passwords, sessions, executable extras or unrelated metadata", t => {
  const f = fixture(t), store = f.open(); let accessed = false;
  const privateProfile = profile({ password: "password-secret", passwordHash: "hash-secret", passwordSalt: "salt-secret",
    session: { token: "session-secret" }, extra: { circular: null }, registrationHash: zero, donor: pool });
  privateProfile.extra.circular = privateProfile.extra;
  Object.defineProperty(privateProfile, "refreshToken", { get() { accessed = true; throw new Error("must not read extras"); } });
  const result = store.prepare({ profile: privateProfile, terms: terms() });
  assert.deepEqual(result.profile, profile()); assert.equal(accessed, false);
  assert.deepEqual(store.prepare({ profile: profile({ password: "changed-but-ignored" }), terms: terms() }), result);
  const stored = f.raw().prepare("SELECT record_json FROM donation_intents").get().record_json;
  for (const secret of ["password", "session", "secret", "refreshToken", "circular"]) assert.ok(!stored.includes(secret));
  for (const extra of [{ donor: pool }, { registrationHash: zero }, { profile: privateProfile }])
    assert.throws(() => store.prepare({ profile: profile(), terms: { ...terms(), ...extra } }), { code: "INVALID_DONATION_TERMS" });
});

test("profile consistency rejects invalid identity, Unicode, email and verification claims", t => {
  const store = fixture(t).open();
  const bad = [{ id: "" }, { id: "x".repeat(161) }, { name: " " }, { name: "x\ud800" }, { name: "<script>" },
    { name: "x\n" }, { organization: null }, { email: "bad" }, { email: "a..b@example.test" }, { email: "a@-bad.test" },
    { wallet: null }, { wallet: "0x" + "00".repeat(20) }, { registeredAt: "2023-01-01" }, { registeredAt: "invalid" },
    { emailVerified: true }, { emailTestVerified: 1 }, { emailTestVerified: true }, { emailTestVerifiedAt: "2023-01-02T00:00:00.000Z" },
    { emailTestVerified: true, emailTestVerifiedAt: "2022-01-01T00:00:00.000Z" }, { emailVerificationMode: "verified" }];
  for (const changes of bad) assert.throws(() => prepare(store, changes), { code: "INVALID_DONATION_PROFILE" });
  const getter = profile(); Object.defineProperty(getter, "name", { enumerable: true, get() { throw new Error("getter"); } });
  assert.throws(() => store.prepare({ profile: getter, terms: terms() }), { code: "INVALID_DONATION_PROFILE" });
  const missing = profile(); delete missing.emailTestVerifiedAt;
  assert.throws(() => store.prepare({ profile: missing, terms: terms() }), { code: "INVALID_DONATION_PROFILE" });
  const valid = prepare(store, { name: "\u6350\u8d60\u8005", organization: "", emailVerificationMode: "local-test",
    emailTestVerified: true, emailTestVerifiedAt: "2023-01-02T00:00:00.000Z" });
  assert.equal(valid.profile.emailVerified, false); assert.equal(valid.profile.emailTestVerified, true);
});

test("terms enforce canonical uint256 decimal strings, bytes32, addresses and allowed purpose", t => {
  const store = fixture(t).open(), uintFields = ["amountWei", "gasReservedWei", "nonce", "deadline", "authorizationEpoch"];
  for (const field of uintFields) for (const value of [0, 1n, "-1", "01", "1.0", "1e3", " 1", "", (1n << 256n).toString(), "9".repeat(1000)])
    assert.throws(() => prepare(store, {}, { [field]: value }), { code: "INVALID_DONATION_TERMS" });
  for (const changes of [{ amountWei: "0" }, { amountWei: "1", gasReservedWei: "2" }, { deadline: "0" },
    { purpose: -1 }, { purpose: 6 }, { purpose: "1" }, { purpose: 1.5 }, { donationId: zero }, { projectId: "0x00" },
    { feePolicyHash: zero }, { registrar: "0x" + "00".repeat(20) }, { registrar: "garbage" }])
    assert.throws(() => prepare(store, {}, changes), { code: "INVALID_DONATION_TERMS" });
  const maximum = ((1n << 256n) - 1n).toString();
  const valid = prepare(store, {}, { amountWei: maximum, gasReservedWei: maximum, nonce: maximum, deadline: maximum, authorizationEpoch: maximum, purpose: 5 });
  assert.equal(valid.permit.amountWei, maximum);
});

test("SQL mutation and replacement are denied, even with recursive triggers disabled", t => {
  const f = fixture(t), store = f.open(); const result = prepare(store), raw = f.raw();
  for (const sql of ["UPDATE donation_intents SET user_id='forged'", "DELETE FROM donation_intents",
    "INSERT OR REPLACE INTO donation_intents SELECT * FROM donation_intents"]) assert.throws(() => raw.exec(sql), /DONATION_INTENT_IMMUTABLE/);
  assert.deepEqual(store.get(id), result);
});

test("tampered record commitments and every SQL lookup index fail reads, lists and startup", async t => {
  const cases = [
    ["donation_id", otherId], ["user_id", "hidden-user"], ["wallet", pool], ["nonce", "99"],
    ["registration_hash", zero], ["created_at", 1], ["record_json", "{broken"]
  ];
  for (const [column, value] of cases) await t.test(column, t => {
    const f = fixture(t), store = f.open(); prepare(store); const raw = f.raw();
    mutate(raw, () => raw.prepare(`UPDATE donation_intents SET ${column}=?`).run(value));
    assert.throws(() => store.get(id), { code: "DONATION_INTENT_CORRUPT" });
    assert.throws(() => store.listForUser("user-1"), { code: "DONATION_INTENT_CORRUPT" });
    assert.throws(() => prepare(store), { code: "DONATION_INTENT_CORRUPT" });
    assert.throws(() => f.open(), { code: "DONATION_INTENT_CORRUPT" });
    assert.equal(raw.prepare("SELECT count(*) AS n FROM donation_intents").get().n, 1);
  });
  for (const field of ["profile", "salt", "permit", "chainId", "poolAddress", "schemaVersion", "extra"]) await t.test(`record ${field}`, t => {
    const f = fixture(t), store = f.open(), record = prepare(store), raw = f.raw();
    if (field === "profile") record.profile.name = "forged";
    else if (field === "permit") record.permit.donor = pool;
    else record[field] = field === "schemaVersion" ? 2 : "changed";
    mutate(raw, () => raw.prepare("UPDATE donation_intents SET record_json=?").run(JSON.stringify(record)));
    assert.throws(() => store.get(id), { code: "DONATION_INTENT_CORRUPT" });
  });
});

test("configuration and schema mismatches fail without silently repairing an existing database", async t => {
  const cases = [
    ["missing guard", raw => raw.exec("DROP TRIGGER donation_intents_no_update"), "DONATION_INTENT_SCHEMA_MISMATCH"],
    ["missing intents", raw => raw.exec("DROP TABLE donation_intents"), "DONATION_INTENT_SCHEMA_MISMATCH"],
    ["missing meta row", raw => raw.exec("DELETE FROM donation_intent_meta"), "DONATION_INTENT_SCHEMA_MISMATCH"],
    ["future schema", raw => raw.exec("UPDATE donation_intent_meta SET schema_version=2"), "DONATION_INTENT_SCHEMA_UNSUPPORTED"],
    ["changed config", raw => raw.exec("UPDATE donation_intent_meta SET chain_id='1'"), "DONATION_INTENT_CONFIG_MISMATCH"],
    ["unknown extra table", raw => raw.exec("CREATE TABLE unrelated(value TEXT)"), "DONATION_INTENT_SCHEMA_MISMATCH"]
  ];
  for (const [name, alter, code] of cases) await t.test(name, t => {
    const f = fixture(t), store = f.open(); prepare(store); const raw = f.raw(); alter(raw); const before = schema(raw);
    assert.throws(() => store.get(id), { code }); assert.throws(() => f.open(), { code });
    assert.deepEqual(schema(raw), before);
  });
  const f = fixture(t), store = f.open(); prepare(store);
  for (const options of [{ chainId: "1" }, { poolAddress: wallet }]) assert.throws(() => f.open(options), { code: "DONATION_INTENT_CONFIG_MISMATCH" });
  assert.ok(store.get(id));
});

test("a nonempty unknown database is not adopted or initialized", t => {
  const f = fixture(t), raw = f.raw(); raw.exec("CREATE TABLE private_other_store(value TEXT); INSERT INTO private_other_store VALUES('keep me')");
  const before = schema(raw);
  assert.throws(() => f.open(), { code: "DONATION_INTENT_SCHEMA_MISMATCH" });
  assert.deepEqual(schema(raw), before); assert.equal(raw.prepare("SELECT value FROM private_other_store").get().value, "keep me");
});

test("failed commit rolls back the new record, donation ID and nonce reservation together", t => {
  const f = fixture(t), store = f.open(), originalExec = DatabaseSync.prototype.exec;
  let failOnce = true;
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
    if (sql === "COMMIT" && failOnce) { failOnce = false; throw new Error("injected commit failure"); }
    return originalExec.call(this, sql);
  });
  assert.throws(() => prepare(store), /injected commit failure/); mock.mock.restore();
  assert.equal(store.get(id), null); assert.deepEqual(store.listForUser("user-1"), []);
  assert.equal(prepare(store).permit.nonce, "0");
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM donation_intents").get().n, 1);
});

test("initial schema failure rolls back all tables without adopting the remaining nonempty SQLite header", t => {
  const f = fixture(t), originalExec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
    if (sql.startsWith("CREATE TRIGGER donation_intents_no_delete")) throw new Error("injected schema failure");
    return originalExec.call(this, sql);
  });
  assert.throws(() => f.open(), /injected schema failure/); mock.mock.restore();
  assert.deepEqual(schema(f.raw()), []);
  // SQLite may retain an empty header after rollback; it must not be mistaken for an owned store.
  assert.throws(() => f.open(), { code: "DONATION_INTENT_SCHEMA_MISMATCH" });
});

test("invalid configuration, clock, lookup arguments and use-after-close are rejected", t => {
  const f = fixture(t);
  for (const config of [{ chainId: "01" }, { chainId: 1.5 }, { chainId: 0 }, { chainId: (1n << 256n).toString() },
    { poolAddress: "0x" + "00".repeat(20) }, { clock: null }, { file: ":memory:" }]) assert.throws(() => f.open(config), { code: "INVALID_DONATION_STORE_CONFIG" });
  const invalidClock = f.open({ clock: () => 1.5 });
  assert.throws(() => prepare(invalidClock), { code: "INVALID_DONATION_INTENT_TIME" });
  assert.equal(invalidClock.get(id), null);
  const store = f.open(); prepare(store);
  assert.throws(() => store.get("invalid"), { code: "INVALID_DONATION_ID" });
  assert.throws(() => store.listForUser(""), { code: "INVALID_DONATION_USER_ID" });
  store.close(); store.close();
  for (const action of [() => prepare(store), () => store.get(id), () => store.listForUser("user-1")]) assert.throws(action, { code: "STORE_CLOSED" });
});

test("profile and lookup owner IDs follow receipt verifier syntax and mixed-case addresses require valid checksums", t => {
  const f = fixture(t), store = f.open();
  for (const idValue of [" ", " user-1", "user-1 ", "user/name", "user@name", "\u7528\u6237", "-user", "a".repeat(161)]) {
    assert.throws(() => prepare(store, { id: idValue }), { code: "INVALID_DONATION_PROFILE" });
    assert.throws(() => store.listForUser(idValue), { code: "INVALID_DONATION_USER_ID" });
  }
  const checksum = getAddress(wallet), invalid = checksum.slice(0, 2) +
    (checksum[2] === checksum[2].toUpperCase() ? checksum[2].toLowerCase() : checksum[2].toUpperCase()) + checksum.slice(3);
  assert.throws(() => prepare(store, { wallet: invalid }), { code: "INVALID_DONATION_PROFILE" });
  assert.throws(() => prepare(store, {}, { registrar: invalid }), { code: "INVALID_DONATION_TERMS" });
  assert.throws(() => f.open({ poolAddress: invalid }), { code: "INVALID_DONATION_STORE_CONFIG" });
  const result = prepare(store, { id: "A.user_1:donor-test", wallet: checksum });
  assert.equal(result.wallet, wallet);
  assert.deepEqual(store.listForUser("A.user_1:donor-test"), [result]);
});
