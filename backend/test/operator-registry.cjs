"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { Worker } = require("node:worker_threads");
const { getAddress } = require("ethers");
const { createOperatorRegistry } = require("../operator-registry");

const TTL = 86_400_000;
const START = 1_800_000_000_000;
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_WALLET = "0x2234567890abcdef1234567890abcdef12345678";
const ROLES = ["supplier", "dispatcher", "contract_approver", "acceptance", "finance",
  "reviewer", "official_verifier", "reporter", "auditor"];
const PUBLIC_KEYS = ["id", "invitationId", "userId", "email", "wallet", "organizationId",
  "role", "status", "assignedAt", "revokedAt", "revokedBy"].sort();
const invitationInput = overrides => ({
  email: "alice@example.test", organizationId: "org-1", role: "supplier", issuedBy: "admin-1", ...overrides
});
const userInput = overrides => ({ id: "user-1", email: "alice@example.test", wallet: WALLET, ...overrides });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "operator-registry-test-"));
  const file = path.join(directory, "nested", "operators.sqlite");
  const connections = [];
  let time = START;
  const open = () => {
    const registry = createOperatorRegistry({ file, clock: () => time });
    connections.push(registry);
    return registry;
  };
  const inspect = () => {
    const db = new DatabaseSync(file);
    connections.push(db);
    return db;
  };
  t.after(() => {
    for (const connection of connections.reverse()) connection.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("operator-registry-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { file, directory, open, inspect, registry: open(), setTime(value) { time = value; } };
}

function publicAssignment(value) {
  assert.deepEqual(Object.keys(value).sort(), PUBLIC_KEYS);
  assert.doesNotMatch(JSON.stringify(value), /code|hash/i);
}

function counts(db) {
  return ["operator_invitations", "operator_assignments", "operator_audit"].map(table =>
    db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}

test("issue and claim bind the matching email, fixed wallet, organization and single role", t => {
  const f = fixture(t);
  const invitation = f.registry.issue(invitationInput({ email: " ALICE@Example.Test " }));
  assert.deepEqual(Object.keys(invitation).sort(), ["id", "code", "email", "organizationId", "role", "expiresAt"].sort());
  assert.match(invitation.code, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(invitation.code, "hex").length, 32);
  assert.equal(invitation.email, "alice@example.test");
  assert.equal(invitation.expiresAt, START + TTL);
  assert.equal(f.registry.lookup("user-1"), null);
  assert.deepEqual(f.registry.list(), []);
  const user = userInput({ email: "Alice@EXAMPLE.TEST", role: "admin", organizationId: "untrusted" });
  const claimed = f.registry.claim({ code: invitation.code, user });
  publicAssignment(claimed);
  assert.deepEqual(claimed, {
    id: claimed.id, invitationId: invitation.id, userId: "user-1", email: invitation.email,
    wallet: getAddress(WALLET), organizationId: "org-1", role: "supplier", status: "active",
    assignedAt: START, revokedAt: null, revokedBy: null
  });
  user.wallet = OTHER_WALLET;
  claimed.role = "finance";
  const listing = f.registry.list();
  listing[0].wallet = OTHER_WALLET;
  const lookup = f.registry.lookup("user-1");
  assert.equal(lookup.wallet, getAddress(WALLET));
  assert.equal(lookup.role, "supplier");
  lookup.email = "other@example.test";
  assert.equal(f.registry.lookup("user-1").email, invitation.email);
  const db = f.inspect();
  const audit = db.prepare("SELECT action, actor_id, user_id FROM operator_audit ORDER BY rowid").all();
  assert.deepEqual(audit.map(row => ({ ...row })), [
    { action: "issue", actor_id: "admin-1", user_id: null },
    { action: "claim", actor_id: "user-1", user_id: "user-1" }
  ]);
});

test("wrong email or missing, zero, malformed or bad-checksum wallet never consumes an invitation", t => {
  const f = fixture(t);
  const { code } = f.registry.issue(invitationInput());
  assert.throws(() => f.registry.claim({ code, user: userInput({ email: "other@example.test" }) }), { code: "EMAIL_MISMATCH" });
  const checksummed = getAddress(WALLET);
  const wrongChecksum = checksummed.replace(/[A-F]/, letter => letter.toLowerCase());
  assert.notEqual(checksummed, wrongChecksum);
  for (const wallet of [undefined, null, "", 123, {}, "0x" + "0".repeat(40), "not-a-wallet",
    "0x" + "1".repeat(39), "0x" + "1".repeat(41), "0x" + "g".repeat(40), ` ${WALLET}`, wrongChecksum]) {
    assert.throws(() => f.registry.claim({ code, user: userInput({ wallet }) }), { code: "INVALID_WALLET" });
  }
  assert.deepEqual(f.registry.list(), []);
  assert.equal(f.inspect().prepare("SELECT claimed_at FROM operator_invitations").get().claimed_at, null);
  assert.equal(f.registry.claim({ code, user: userInput() }).status, "active");
});

test("all nine business roles work; administrators, arrays and unknown roles are rejected", t => {
  const f = fixture(t);
  for (const role of ["admin", "administrator", "platform_admin", "donor", "SUPPLIER", " supplier ",
    "supplier,finance", "", null, undefined, ["supplier"], ["supplier", "finance"], {}, "x".repeat(1000)]) {
    assert.throws(() => f.registry.issue(invitationInput({ role })), { code: "INVALID_ROLE" });
  }
  for (const role of ROLES) {
    const invitation = f.registry.issue(invitationInput({ role }));
    assert.equal(f.registry.claim({ code: invitation.code, user: userInput() }).role, role);
    f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" });
  }
  assert.equal(f.registry.list().length, ROLES.length);
});

test("expiry is exclusive at 24 hours; consumed, unknown and malformed codes cannot be claimed", t => {
  const f = fixture(t);
  const first = f.registry.issue(invitationInput());
  const second = f.registry.issue(invitationInput());
  f.setTime(START + TTL - 1);
  f.registry.claim({ code: first.code.toUpperCase(), user: userInput() });
  assert.throws(() => f.registry.claim({ code: first.code, user: userInput() }), { code: "INVITATION_UNAVAILABLE" });
  f.setTime(START + TTL);
  assert.throws(() => f.registry.claim({ code: second.code, user: userInput() }), { code: "INVITATION_UNAVAILABLE" });
  assert.throws(() => f.registry.claim({ code: "0".repeat(64), user: userInput() }), { code: "INVITATION_UNAVAILABLE" });
  for (const code of [undefined, null, 123, [], "", "a".repeat(63), "a".repeat(65), "z".repeat(64), ` ${first.code}`]) {
    assert.throws(() => f.registry.claim({ code, user: userInput() }), { code: "INVALID_CODE" });
  }
  assert.equal(f.registry.list().length, 1);
});

test("one active role per user or case-insensitive wallet; conflicts preserve the second invitation", t => {
  const f = fixture(t);
  const first = f.registry.issue(invitationInput());
  const second = f.registry.issue(invitationInput({ role: "finance", organizationId: "org-2" }));
  f.registry.claim({ code: first.code, user: userInput() });
  for (const user of [userInput(), userInput({ wallet: OTHER_WALLET }),
    userInput({ id: "user-2" }), userInput({ id: "user-2", wallet: getAddress(WALLET) })]) {
    assert.throws(() => f.registry.claim({ code: second.code, user }), { code: "ASSIGNMENT_CONFLICT" });
  }
  const db = f.inspect();
  assert.equal(db.prepare("SELECT claimed_at FROM operator_invitations WHERE id = ?").get(second.id).claimed_at, null);
  const claimed = f.registry.claim({ code: second.code, user: userInput({ id: "user-2", wallet: OTHER_WALLET }) });
  assert.equal(claimed.organizationId, "org-2");
  assert.equal(claimed.role, "finance");
  assert.equal(f.registry.list().length, 2);
});

test("revoke is audited and idempotent; a new invitation allows reassignment and releases the old wallet", t => {
  const f = fixture(t);
  const first = f.registry.issue(invitationInput());
  const claimed = f.registry.claim({ code: first.code, user: userInput() });
  f.setTime(START + 10);
  const revoked = f.registry.revoke({ userId: "user-1", revokedBy: "admin-2" });
  publicAssignment(revoked);
  assert.deepEqual(revoked, { ...claimed, status: "revoked", revokedAt: START + 10, revokedBy: "admin-2" });
  assert.equal(f.registry.lookup("user-1"), null);
  assert.equal(f.registry.revoke({ userId: "missing", revokedBy: "admin-1" }), null);
  f.setTime(START + 20);
  assert.deepEqual(f.registry.revoke({ userId: "user-1", revokedBy: "admin-3" }), revoked);
  const db = f.inspect();
  const audit = db.prepare("SELECT * FROM operator_audit WHERE action = 'revoke'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, "admin-2");
  assert.equal(audit[0].user_id, "user-1");
  assert.equal(audit[0].invitation_id, first.id);
  assert.equal(audit[0].assignment_id, claimed.id);
  assert.equal(audit[0].occurred_at, START + 10);
  assert.throws(() => f.registry.claim({ code: first.code, user: userInput() }), { code: "INVITATION_UNAVAILABLE" });
  const second = f.registry.issue(invitationInput({ role: "finance", organizationId: "org-2" }));
  const active = f.registry.claim({ code: second.code, user: userInput() });
  assert.notEqual(active.id, revoked.id);
  assert.equal(active.role, "finance");
  assert.deepEqual(f.registry.list(), [revoked, active]);
  assert.deepEqual(f.registry.lookup("user-1"), active);
  f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" });
  const third = f.registry.issue(invitationInput({ email: "bob@example.test" }));
  assert.equal(f.registry.claim({ code: third.code, user: userInput({ id: "user-2", email: "bob@example.test" }) }).userId, "user-2");
});

test("restart preserves pending invitations, active and revoked assignments, audits and replay protection", t => {
  const f = fixture(t);
  const first = f.registry.issue(invitationInput());
  f.registry.claim({ code: first.code, user: userInput() });
  f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" });
  const second = f.registry.issue(invitationInput());
  const active = f.registry.claim({ code: second.code, user: userInput() });
  const pending = f.registry.issue(invitationInput({ email: "bob@example.test", role: "auditor" }));
  const expected = f.registry.list();
  f.registry.close();
  const restarted = f.open();
  assert.deepEqual(restarted.list(), expected);
  assert.deepEqual(restarted.lookup("user-1"), active);
  assert.throws(() => restarted.claim({ code: first.code, user: userInput() }), { code: "INVITATION_UNAVAILABLE" });
  assert.throws(() => restarted.claim({ code: second.code, user: userInput() }), { code: "INVITATION_UNAVAILABLE" });
  restarted.claim({ code: pending.code, user: userInput({ id: "user-2", email: "bob@example.test", wallet: OTHER_WALLET }) });
  assert.deepEqual(counts(f.inspect()), [3, 3, 7]);
});

test("only three tables are created, code hashes stay private, and no plaintext code reaches database or WAL", t => {
  const f = fixture(t);
  const invitation = f.registry.issue(invitationInput());
  const another = f.registry.issue(invitationInput());
  assert.notEqual(invitation.code, another.code);
  const db = f.inspect();
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name),
    ["operator_assignments", "operator_audit", "operator_invitations"]);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  const stored = db.prepare("SELECT * FROM operator_invitations WHERE id = ?").get(invitation.id);
  assert.equal(stored.code_hash, createHash("sha256").update(Buffer.from(invitation.code, "hex")).digest("hex"));
  assert.equal(stored.code, undefined);
  const active = f.registry.claim({ code: invitation.code, user: userInput() });
  const revoked = f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" });
  for (const snapshot of [active, revoked, ...f.registry.list()]) {
    publicAssignment(snapshot);
    assert.ok(!JSON.stringify(snapshot).includes(stored.code_hash));
    assert.ok(!JSON.stringify(snapshot).includes(invitation.code));
  }
  const rows = ["operator_invitations", "operator_assignments", "operator_audit"].flatMap(table => db.prepare(`SELECT * FROM ${table}`).all());
  assert.ok(!JSON.stringify(rows).includes(invitation.code));
  function scanFiles() {
    for (const name of fs.readdirSync(path.dirname(f.file))) {
      const bytes = fs.readFileSync(path.join(path.dirname(f.file), name));
      for (const { code } of [invitation, another]) {
        assert.equal(bytes.includes(Buffer.from(code)), false, name);
        assert.equal(bytes.includes(Buffer.from(code, "hex")), false, name);
      }
    }
  }
  scanFiles();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  scanFiles();
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
  }
});

test("audit write failures roll back issuance, consumption, binding and revocation without swallowing errors", t => {
  const f = fixture(t);
  const db = f.inspect();
  db.exec(`CREATE TRIGGER operator_test_failure BEFORE INSERT ON operator_audit
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
  assert.throws(() => f.registry.issue(invitationInput()), /injected audit failure/);
  assert.deepEqual(counts(db), [0, 0, 0]);
  db.exec("DROP TRIGGER operator_test_failure");
  const invitation = f.registry.issue(invitationInput());
  db.exec(`CREATE TRIGGER operator_test_failure BEFORE INSERT ON operator_audit
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
  assert.throws(() => f.registry.claim({ code: invitation.code, user: userInput() }), /injected audit failure/);
  assert.equal(f.registry.lookup("user-1"), null);
  assert.deepEqual(counts(db), [1, 0, 1]);
  const pending = db.prepare("SELECT claimed_at, claimed_by FROM operator_invitations").get();
  assert.equal(pending.claimed_at, null);
  assert.equal(pending.claimed_by, null);
  db.exec("DROP TRIGGER operator_test_failure");
  const active = f.registry.claim({ code: invitation.code, user: userInput() });
  db.exec(`CREATE TRIGGER operator_test_failure BEFORE INSERT ON operator_audit
    BEGIN SELECT RAISE(ROLLBACK, 'injected transaction rollback'); END;`);
  assert.throws(() => f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" }), /injected transaction rollback/);
  assert.deepEqual(f.registry.lookup("user-1"), active);
  assert.deepEqual(counts(db), [1, 1, 2]);
  db.exec("DROP TRIGGER operator_test_failure");
  assert.equal(f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" }).status, "revoked");
  assert.deepEqual(counts(db), [1, 1, 3]);
});

test("input type and length boundaries are enforced without changing stored state", t => {
  const f = fixture(t);
  for (const value of [undefined, null, 1, "input", [], new Date()]) {
    for (const operation of ["issue", "claim", "revoke"]) {
      assert.throws(() => f.registry[operation](value), { code: "INVALID_INPUT" });
    }
  }
  for (const [field, maximum] of [["organizationId", 160], ["issuedBy", 128]]) {
    for (const value of [undefined, null, 7, [], {}, "", " ", "bad\nvalue", "<script>", "x".repeat(maximum + 1)]) {
      assert.throws(() => f.registry.issue(invitationInput({ [field]: value })), { code: "INVALID_INPUT" });
    }
    for (const length of [1, maximum]) f.registry.issue(invitationInput({ [field]: "x".repeat(length) }));
  }
  const email254 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  assert.equal(email254.length, 254);
  for (const email of [undefined, null, 3, "", "a@b", "@example.test", "a..b@example.test", ".a@example.test",
    "a.@example.test", "a@example..test", "a@-example.test", "a b@example.test", "a@b.test\n",
    `${"a".repeat(65)}@example.test`, `a@${"b".repeat(64)}.test`, `${email254}e`]) {
    assert.throws(() => f.registry.issue(invitationInput({ email })), { code: "INVALID_INPUT" });
  }
  const invitation = f.registry.issue(invitationInput({ email: email254 }));
  for (const id of [undefined, null, 0, [], "", " ", "x".repeat(129), "user\0id"]) {
    assert.throws(() => f.registry.lookup(id), { code: "INVALID_INPUT" });
    assert.throws(() => f.registry.revoke({ userId: id, revokedBy: "admin" }), { code: "INVALID_INPUT" });
    assert.throws(() => f.registry.claim({ code: invitation.code, user: userInput({ id, email: email254 }) }), { code: "INVALID_INPUT" });
  }
  for (const revokedBy of [undefined, null, 3, [], "", "x".repeat(129)]) {
    assert.throws(() => f.registry.revoke({ userId: "user-1", revokedBy }), { code: "INVALID_INPUT" });
  }
  for (const user of [undefined, null, [], new Date()]) {
    assert.throws(() => f.registry.claim({ code: invitation.code, user }), { code: "INVALID_INPUT" });
  }
  assert.deepEqual(f.registry.list(), []);
  const maxId = "u".repeat(128);
  f.registry.claim({ code: invitation.code, user: userInput({ id: maxId, email: email254 }) });
  assert.equal(f.registry.lookup(maxId).email, email254);
  assert.equal(f.registry.revoke({ userId: maxId, revokedBy: "a".repeat(128) }).revokedBy.length, 128);
  const minimum = f.registry.issue(invitationInput({ email: "a@b.c", organizationId: "o", issuedBy: "a" }));
  f.registry.claim({ code: minimum.code, user: userInput({ id: "u", email: "a@b.c" }) });
  assert.equal(f.registry.revoke({ userId: "u", revokedBy: "a" }).status, "revoked");
});

test("SQL-looking identifiers remain literal parameter values", t => {
  const f = fixture(t);
  const literal = "x'; DROP TABLE operator_assignments; --";
  const issued = f.registry.issue(invitationInput({ organizationId: literal, issuedBy: literal }));
  const claimed = f.registry.claim({ code: issued.code, user: userInput({ id: literal }) });
  assert.equal(claimed.organizationId, literal);
  assert.equal(f.registry.lookup(literal).userId, literal);
  assert.equal(f.registry.revoke({ userId: literal, revokedBy: literal }).revokedBy, literal);
  assert.equal(f.registry.list().length, 1);
});

test("invalid configuration and clocks fail explicitly; clock errors roll back; close is idempotent", t => {
  const f = fixture(t);
  for (const options of [undefined, null, [], {}, { file: null }, { file: "" }, { file: " " },
    { file: "\0" }, { file: "x".repeat(4097) }, { file: ":memory:" }, { file: f.file, clock: 1 }]) {
    assert.throws(() => createOperatorRegistry(options), { code: "INVALID_INPUT" });
  }
  for (const time of [NaN, Infinity, -1, 0.1, "1", null, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    f.setTime(time);
    assert.throws(() => f.registry.issue(invitationInput()), { code: "INVALID_CLOCK" });
  }
  assert.deepEqual(counts(f.inspect()), [0, 0, 0]);
  f.setTime(START);
  const invitation = f.registry.issue(invitationInput());
  f.setTime(NaN);
  assert.throws(() => f.registry.claim({ code: invitation.code, user: userInput() }), { code: "INVALID_CLOCK" });
  f.setTime(START);
  const active = f.registry.claim({ code: invitation.code, user: userInput() });
  f.setTime(NaN);
  assert.throws(() => f.registry.revoke({ userId: "user-1", revokedBy: "admin-1" }), { code: "INVALID_CLOCK" });
  assert.deepEqual(f.registry.lookup("user-1"), active);
  const injected = new Error("injected clock exception");
  const throwing = createOperatorRegistry({ file: f.file, clock() { throw injected; } });
  try { assert.throws(() => throwing.issue(invitationInput()), error => error === injected); }
  finally { throwing.close(); }
  f.registry.close();
  f.registry.close();
  for (const operation of ["issue", "claim", "lookup", "list", "revoke"]) {
    assert.throws(() => f.registry[operation](), { code: "REGISTRY_CLOSED" });
  }
  const defaultClock = createOperatorRegistry({ file: f.file });
  try {
    const before = Date.now();
    const current = defaultClock.issue(invitationInput());
    assert.ok(current.expiresAt >= before + TTL && current.expiresAt <= Date.now() + TTL);
  } finally { defaultClock.close(); }
});

// Each worker opens a separate SQLite connection before the shared start gate.
async function raceClaims(t, file, claims) {
  const gate = new SharedArrayBuffer(4);
  const workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const participants = claims.map(claim => {
    let readyResolve, readyReject, resultResolve, resultReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { createOperatorRegistry } = require(workerData.modulePath);
      const registry = createOperatorRegistry({ file: workerData.file, clock: () => workerData.time });
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      let result;
      try { result = { value: registry.claim(workerData.claim) }; }
      catch (error) { result = { error: { code: error.code, message: error.message } }; }
      finally { registry.close(); }
      parentPort.postMessage(result);
    `, { eval: true, workerData: { modulePath: require.resolve("../operator-registry"), file, gate, claim, time: START } });
    workers.push(worker);
    let received = false;
    worker.on("message", message => {
      if (message.ready) readyResolve();
      else { received = true; resultResolve(message); }
    });
    worker.on("error", error => { readyReject(error); resultReject(error); });
    worker.on("exit", code => {
      if (!received) {
        const error = new Error(`Claim worker exited without result (${code})`);
        readyReject(error);
        resultReject(error);
      }
    });
    return { ready, result };
  });
  // Attach both rejection handlers before waiting for startup.
  const results = Promise.all(participants.map(participant => participant.result));
  const started = Promise.all(participants.map(participant => participant.ready)).then(() => {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, claims.length);
  });
  return (await Promise.all([started, results]))[1];
}

test("concurrent two-connection claims consume an invitation exactly once, even for different users", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const { code } = f.registry.issue(invitationInput());
  const results = await raceClaims(t, f.file, [
    { code, user: userInput() }, { code, user: userInput({ id: "user-2", wallet: OTHER_WALLET }) }
  ]);
  assert.equal(results.filter(result => result.value).length, 1);
  assert.equal(results.find(result => result.error).error.code, "INVITATION_UNAVAILABLE");
  const winner = results.find(result => result.value).value;
  assert.deepEqual(f.registry.list(), [winner]);
  const db = f.inspect();
  assert.equal(db.prepare("SELECT claimed_by FROM operator_invitations").get().claimed_by, winner.userId);
  assert.deepEqual(counts(db), [1, 1, 2]);
});

test("concurrent distinct invitations cannot assign a wallet to two users", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const first = f.registry.issue(invitationInput());
  const second = f.registry.issue(invitationInput({ email: "bob@example.test", role: "finance" }));
  const results = await raceClaims(t, f.file, [
    { code: first.code, user: userInput() },
    { code: second.code, user: userInput({ id: "user-2", email: "bob@example.test", wallet: getAddress(WALLET) }) }
  ]);
  assert.equal(results.filter(result => result.value).length, 1);
  assert.equal(results.find(result => result.error).error.code, "ASSIGNMENT_CONFLICT");
  const db = f.inspect();
  assert.equal(db.prepare("SELECT count(*) AS count FROM operator_invitations WHERE claimed_at IS NULL").get().count, 1);
  assert.deepEqual(counts(db), [2, 1, 3]);
});
