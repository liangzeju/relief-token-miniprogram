"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Wallet } = require("ethers");
const { createAccounts } = require("../wallet-accounts");
const { createLocalMailbox } = require("../local-mailbox");

const PASSWORD = "local-test-password";
const NEW_PASSWORD = "replacement-password";
const EMAIL = "alice@example.test";
const ADMIN_TOKEN = "a".repeat(64);

function fixture(t, { env = {}, origin = "http://127.0.0.1:3000", isAdminSession } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-wallet-email-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = {
    dataDir, origin, chainId: 10143, isAdminSession,
    send(res, status, body) { res.status = status; res.body = body; res.writableEnded = true; },
    async readBody(req) { if (req.invalidJSON) throw new Error("Invalid JSON"); return req.body; }
  };
  let accounts;
  function restart(environment = env) {
    const values = { NODE_ENV: undefined, RELIEF_MAIL_MODE: undefined, RELIEF_ADMIN_TOKEN: ADMIN_TOKEN, ...environment };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      accounts = createAccounts(options);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  restart();
  async function request(route, { method = "POST", body = {}, cookie, headers = {}, ip = "127.0.0.1", invalidJSON = false } = {}) {
    const req = { method, body, invalidJSON, socket: { remoteAddress: ip }, headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) } };
    const res = { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, destroy() {} };
    const handled = await accounts.handle(req, res, `/v1/wallet/${route}`);
    return { handled, ...res, cookie: res.headers["set-cookie"]?.split(";")[0] };
  }
  return {
    dataDir, restart, request,
    get accounts() { return accounts; },
    register(email = EMAIL) { return request("register", { body: { name: "Alice", email, password: PASSWORD } }); },
    login(password = PASSWORD, email = EMAIL) { return request("login", { body: { email, password } }); },
    async inbox() { return (await request("admin/test-mailbox", { method: "GET", headers: { "x-admin-token": ADMIN_TOKEN } })).body.data.messages; }
  };
}

function clock(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return { advance(ms) { now += ms; } };
}

function current(f, cookie) { return f.accounts.user({ headers: { cookie } }); }

async function issue(f, purpose, cookie, email = EMAIL) {
  const response = await f.request(purpose === "email-verification" ? "email/request" : "password/request", { cookie, body: { email } });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { data: { accepted: true } });
  return (await f.inbox()).find(item => item.purpose === purpose && item.to === email);
}

test("frozen API: local verification is private, purpose-bound, persisted, and never real email verification", async t => {
  const f = fixture(t);
  assert.deepEqual((await f.request("auth-config", { method: "GET" })).body, { data: { emailMode: "local-test" } });
  const alice = await f.register();
  const bob = await f.register("bob@example.test");
  const initial = alice.body.data.user;
  assert.equal(initial.emailVerified, false);
  assert.equal(initial.emailTestVerified, false);
  assert.equal(initial.emailTestVerifiedAt, null);
  assert.equal(initial.emailVerificationMode, "local-test");
  assert.deepEqual(Object.keys(initial).sort(), ["email", "emailTestVerified", "emailTestVerifiedAt", "emailVerificationMode", "emailVerified", "id", "name", "organization", "registeredAt", "wallet"]);
  const verification = await issue(f, "email-verification", alice.cookie);
  assert.deepEqual(Object.keys(verification).sort(), ["code", "createdAt", "expiresAt", "id", "purpose", "to"]);
  assert.match(verification.code, /^[0-9]{6}$/);
  assert.equal(Date.parse(verification.expiresAt) - Date.parse(verification.createdAt), 600000);
  assert.equal((await f.request("email/verify", { cookie: bob.cookie, body: { code: verification.code } })).status, 400);
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: verification.code, password: NEW_PASSWORD } })).status, 400);
  const verified = await f.request("email/verify", { cookie: alice.cookie, body: { code: verification.code } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.emailVerified, false);
  assert.equal(verified.body.data.user.emailTestVerified, true);
  assert.ok(Number.isFinite(Date.parse(verified.body.data.user.emailTestVerifiedAt)));
  assert.equal((await f.request("email/verify", { cookie: alice.cookie, body: { code: verification.code } })).status, 400);
  assert.deepEqual(await f.inbox(), []);
  const store = JSON.parse(fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8"));
  assert.equal(store.users[0].emailTestVerified, true);
  assert.equal(store.users[0].code, undefined);
  assert.equal(store.users[0].challenges, undefined);
  assert.equal(store.version, 1);
  f.restart();
  assert.equal(current(f, alice.cookie), null);
  assert.deepEqual(f.accounts.snapshot(initial.id), verified.body.data.user);
  const login = await f.login();
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.emailTestVerified, true);
  f.restart({ NODE_ENV: "production", RELIEF_MAIL_MODE: "local-test" });
  assert.equal(f.accounts.snapshot(initial.id).emailVerificationMode, "disabled");
  assert.equal(f.accounts.snapshot(initial.id).emailVerified, false);
  assert.equal(f.accounts.snapshot(initial.id).emailTestVerified, true);
});

test("password reset revokes all user sessions and binding/email challenges, preserves other users, and survives restart", async t => {
  const f = fixture(t);
  const alice = await f.register();
  const another = await f.login();
  const bob = await f.register("bob@example.test");
  const wallet = Wallet.createRandom();
  const binding = (await f.request("challenge", { cookie: alice.cookie, body: { address: wallet.address } })).body.data;
  const emailProof = await issue(f, "email-verification", alice.cookie);
  const reset = await issue(f, "password-reset");
  const result = await f.request("password/reset", { cookie: alice.cookie, body: { email: " ALICE@EXAMPLE.TEST ", code: reset.code, password: NEW_PASSWORD } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { reset: true } });
  assert.match(result.headers["set-cookie"], /relief_session=;.*Max-Age=0/);
  assert.equal(current(f, alice.cookie), null);
  assert.equal(current(f, another.cookie), null);
  assert.ok(current(f, bob.cookie));
  assert.deepEqual(await f.inbox(), []);
  assert.equal((await f.login()).status, 401);
  const fresh = await f.login(NEW_PASSWORD);
  assert.equal(fresh.status, 200);
  assert.equal((await f.request("verify", { cookie: fresh.cookie, body: { nonce: binding.nonce, signature: await wallet.signMessage(binding.message) } })).status, 400);
  assert.equal((await f.request("email/verify", { cookie: fresh.cookie, body: { code: emailProof.code } })).status, 400);
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: reset.code, password: PASSWORD } })).status, 400);
  f.restart();
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
});

test("mailbox requires token or injected admin session; bootstrap validates raw tokens only", async t => {
  const f = fixture(t, { isAdminSession: req => req.headers.cookie === "admin-session=valid" });
  const alice = await f.register();
  await issue(f, "email-verification", alice.cookie);
  for (const headers of [{}, { "x-admin-token": "demo-platform-admin" }, { "x-admin-token": "b".repeat(64) }, { authorization: `Bearer ${ADMIN_TOKEN}` }, { cookie: alice.cookie }]) {
    assert.equal((await f.request("admin/test-mailbox", { method: "GET", headers })).status, 403);
  }
  for (const headers of [{ "x-admin-token": ADMIN_TOKEN }, { cookie: "admin-session=valid" }]) {
    const result = await f.request("admin/test-mailbox", { method: "GET", headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.body.data.mode, "local-test");
    assert.equal(result.body.data.messages.length, 1);
    assert.equal(f.accounts.isAdmin({ headers }), true);
  }
  assert.equal(f.accounts.isAdminToken({ headers: { cookie: "admin-session=valid" } }), false);
  assert.equal(f.accounts.isAdminToken({ headers: { "x-admin-token": ADMIN_TOKEN } }), true);
  const standalone = fixture(t);
  assert.equal(standalone.accounts.isAdmin({ headers: { cookie: "admin-session=valid" } }), false);
});

test("mode defaults fail closed outside local development, production cannot opt in", async t => {
  for (const [origin, env, expected] of [
    ["http://localhost:3000", {}, "local-test"],
    ["http://[::1]:3000", { NODE_ENV: "test" }, "local-test"],
    ["http://127.0.0.1:3000", { NODE_ENV: "development" }, "local-test"],
    ["http://0.0.0.0:3000", {}, "disabled"],
    ["https://wallet.example.test", {}, "disabled"],
    ["https://wallet.example.test", { NODE_ENV: "test" }, "disabled"],
    ["http://localhost:3000", { NODE_ENV: "staging" }, "disabled"],
    ["https://wallet.example.test", { RELIEF_MAIL_MODE: "local-test" }, "local-test"],
    ["http://localhost:3000", { RELIEF_MAIL_MODE: "disabled" }, "disabled"],
    ["http://localhost:3000", { RELIEF_MAIL_MODE: "smtp" }, "disabled"],
    ["http://localhost:3000", { NODE_ENV: "production" }, "disabled"],
    ["http://localhost:3000", { NODE_ENV: "production", RELIEF_MAIL_MODE: "local-test" }, "disabled"]
  ]) {
    const f = fixture(t, { origin, env });
    const result = await f.request("auth-config", { method: "GET" });
    assert.deepEqual(result.body, { data: { emailMode: expected } }, JSON.stringify({ origin, env }));
    if (expected === "disabled") {
      assert.equal((await f.request("password/request", { body: { email: EMAIL } })).status, 202);
      assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: "123456", password: PASSWORD } })).status, 403);
      assert.equal((await f.request("admin/test-mailbox", { method: "GET", headers: { "x-admin-token": ADMIN_TOKEN } })).status, 403);
    }
  }
});

test("auth, Origin, JSON and route methods are enforced on new endpoints", async t => {
  const f = fixture(t);
  for (const route of ["email/request", "email/verify", "password/request", "password/reset"]) {
    assert.equal((await f.request(route, { headers: { origin: "https://attacker.test" } })).status, 403);
    assert.equal((await f.request(route, { headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await f.request(route, { invalidJSON: true })).status, 400);
    assert.equal((await f.request(route, { body: [] })).status, 400);
    assert.equal((await f.request(route, { method: "GET" })).handled, false);
  }
  for (const route of ["auth-config", "admin/test-mailbox"]) {
    assert.equal((await f.request(route, { method: "GET", headers: { origin: "null", "x-admin-token": ADMIN_TOKEN } })).status, 403);
    assert.equal((await f.request(route)).handled, false);
  }
  assert.equal((await f.request("email/request")).status, 401);
  assert.equal((await f.request("email/verify", { body: { code: "123456" } })).status, 401);
  assert.equal((await f.request("password/request", { body: { email: "invalid" } })).status, 400);
});

test("request responses do not enumerate accounts or reveal throttling, cooldown/latest code and expiry hold", async t => {
  const time = clock(t);
  const f = fixture(t);
  const alice = await f.register();
  const first = await issue(f, "password-reset");
  const known = await f.request("password/request", { body: { email: EMAIL } });
  const unknown = await f.request("password/request", { body: { email: "unknown@example.test" } });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body);
  assert.deepEqual(await f.inbox(), [first]);
  time.advance(60000);
  const latest = await issue(f, "password-reset");
  assert.notEqual(latest.code, first.code);
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: first.code, password: NEW_PASSWORD } })).status, 400);
  const verification = await issue(f, "email-verification", alice.cookie);
  assert.deepEqual((await f.inbox()).map(item => item.id), [verification.id, latest.id]);
  for (let i = 0; i < 40; i++) {
    const response = await f.request("password/request", { body: { email: i % 2 ? EMAIL : "unknown@example.test" }, headers: { "x-forwarded-for": `192.0.2.${i}` } });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, known.body);
  }
  time.advance(600000);
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: latest.code, password: NEW_PASSWORD } })).status, 400);
  assert.equal((await f.request("email/verify", { cookie: alice.cookie, body: { code: verification.code } })).status, 400);
  assert.deepEqual(await f.inbox(), []);
  time.advance(900001);
  assert.ok(await issue(f, "password-reset"));
});

test("five bad attempts lock codes; email/user/IP budgets cannot be bypassed with forwarding headers", async t => {
  const f = fixture(t);
  const alice = await f.register();
  for (const purpose of ["email-verification", "password-reset"]) {
    const proof = await issue(f, purpose, alice.cookie);
    const route = purpose === "email-verification" ? "email/verify" : "password/reset";
    const wrong = proof.code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++) {
      assert.equal((await f.request(route, { cookie: alice.cookie, body: { email: EMAIL, password: NEW_PASSWORD, code: i === 0 ? 123456 : wrong } })).status, 400);
    }
    assert.equal((await f.request(route, { cookie: alice.cookie, body: { email: EMAIL, password: NEW_PASSWORD, code: proof.code } })).status, 400);
  }
  for (let i = 0; i < 30; i++) {
    await f.request("email/verify", { cookie: alice.cookie, body: { code: "123456" }, ip: `192.0.2.${i}` });
  }
  assert.equal((await f.request("email/verify", { cookie: alice.cookie, body: { code: "123456" }, ip: "203.0.113.1" })).status, 429);
  const other = fixture(t);
  for (let i = 0; i < 60; i++) {
    assert.equal((await other.request("password/reset", { body: { email: `absent${i}@example.test`, code: "123456", password: PASSWORD }, headers: { "x-forwarded-for": `192.0.2.${i}` } })).status, 400);
  }
  assert.equal((await other.request("password/reset", { body: { email: "another@example.test", code: "123456", password: PASSWORD }, headers: { "x-forwarded-for": "203.0.113.1" } })).status, 429);
});

test("local mailbox enforces per-user sends, per-email cooldown, separate purposes, bounded inbox and buckets", t => {
  const time = clock(t);
  const box = createLocalMailbox();
  let number = 100000;
  t.mock.method(crypto, "randomInt", () => number++);
  box.issue("email-verification", EMAIL, "alice", "ip1");
  const first = box.list()[0];
  box.issue("email-verification", EMAIL, "alice", "ip2");
  assert.equal(box.list().length, 1);
  box.issue("password-reset", EMAIL, "alice", "ip1");
  const reset = box.list()[0];
  assert.equal(box.check("password-reset", EMAIL, "alice", first.code, "ip1").valid, undefined);
  assert.equal(box.check("password-reset", "other@example.test", "alice", reset.code, "ip1").valid, undefined);
  assert.equal(box.check("password-reset", EMAIL, "bob", reset.code, "ip1").valid, undefined);
  assert.equal(box.check("password-reset", EMAIL, "alice", reset.code, "ip1").valid, true);
  for (let i = 0; i < 5; i++) {
    time.advance(60000);
    box.issue("email-verification", `alias${i}@example.test`, "alice", `ip${i + 10}`);
  }
  assert.equal(box.list().filter(item => item.purpose === "email-verification").length, 4);
  const bounded = createLocalMailbox();
  for (let i = 0; i < 1100; i++) bounded.issue("password-reset", `u${i}@example.test`, `user${i}`, `ip${i}`);
  assert.equal(bounded.list().length, 1000);
  assert.equal(bounded.list().at(-1).to, "u100@example.test");
  const copy = bounded.list()[0];
  copy.code = "changed";
  assert.notEqual(bounded.list()[0].code, "changed");
  for (let i = 1100; i < 6000; i++) bounded.issue("password-reset", `u${i}@example.test`, `user${i}`, `ip${i}`);
  assert.equal(bounded.list().length, 1000);
  time.advance(900001);
  assert.deepEqual(bounded.list(), []);
  bounded.issue("password-reset", EMAIL, "alice", "ip");
  assert.equal(bounded.list().length, 1);
});

test("restart drops pending codes and mailbox; version 1 legacy users load, invalid optional markers fail closed", async t => {
  const f = fixture(t);
  const alice = await f.register();
  const proof = await issue(f, "password-reset");
  const file = path.join(f.dataDir, "accounts.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const field of ["emailTestVerified", "emailTestVerifiedAt", "emailVerificationMode"]) delete original.users[0][field];
  fs.writeFileSync(file, JSON.stringify(original));
  f.restart();
  assert.deepEqual(await f.inbox(), []);
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: proof.code, password: NEW_PASSWORD } })).status, 400);
  assert.equal(f.accounts.snapshot(alice.body.data.user.id).emailTestVerified, false);
  assert.equal(f.accounts.snapshot(alice.body.data.user.id).emailTestVerifiedAt, null);
  assert.equal((await f.login()).status, 200);
  for (const patch of [
    { emailTestVerified: "true" }, { emailTestVerified: true }, { emailTestVerifiedAt: "yesterday" },
    { emailTestVerifiedAt: 1234 }, { emailTestVerifiedAt: "2026-01-01T00:00:00.000Z" },
    { emailVerificationMode: "smtp" }, { emailVerified: true },
    { emailTestVerified: true, emailTestVerifiedAt: "2026-01-01" }
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, users: [{ ...original.users[0], ...patch }] }));
    assert.throws(() => f.restart(), /Cannot load accounts.json/);
  }
  fs.writeFileSync(file, JSON.stringify(original));
  f.restart();
});

test("failed reset persistence preserves credentials, sessions and outstanding binding/verification proofs", async t => {
  const time = clock(t);
  const f = fixture(t);
  const alice = await f.register();
  const wallet = Wallet.createRandom();
  const binding = (await f.request("challenge", { cookie: alice.cookie, body: { address: wallet.address } })).body.data;
  const verification = await issue(f, "email-verification", alice.cookie);
  const reset = await issue(f, "password-reset");
  const file = path.join(f.dataDir, "accounts.json");
  const before = fs.readFileSync(file, "utf8");
  const rename = fs.promises.rename;
  const mocked = t.mock.method(fs.promises, "rename", async (from, to) => {
    if (to === file) throw new Error("Injected persistence failure");
    return rename(from, to);
  });
  const result = await f.request("password/reset", { body: { email: EMAIL, code: reset.code, password: NEW_PASSWORD } });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "STORAGE_ERROR");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.ok(current(f, alice.cookie));
  assert.equal(fs.readdirSync(f.dataDir).some(name => name.endsWith(".tmp")), false);
  mocked.mock.restore();
  assert.equal((await f.login()).status, 200);
  assert.equal((await f.login(NEW_PASSWORD)).status, 401);
  assert.equal((await f.request("verify", { cookie: alice.cookie, body: { nonce: binding.nonce, signature: await wallet.signMessage(binding.message) } })).status, 200);
  assert.equal((await f.request("email/verify", { cookie: alice.cookie, body: { code: verification.code } })).status, 200);
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: reset.code, password: NEW_PASSWORD } })).status, 400);
  time.advance(60000);
  const retry = await issue(f, "password-reset");
  assert.equal((await f.request("password/reset", { body: { email: EMAIL, code: retry.code, password: NEW_PASSWORD } })).status, 200);
});

test("concurrent reset/login/binding cannot resurrect credentials; concurrent reset and verification consume once", async t => {
  const f = fixture(t);
  const alice = await f.register();
  const wallet = Wallet.createRandom();
  const binding = (await f.request("challenge", { cookie: alice.cookie, body: { address: wallet.address } })).body.data;
  const signature = await wallet.signMessage(binding.message);
  const reset = await issue(f, "password-reset");
  const file = path.join(f.dataDir, "accounts.json");
  const rename = fs.promises.rename;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const mocked = t.mock.method(fs.promises, "rename", async (from, to) => {
    if (to === file) { enter(); await gate; }
    return rename(from, to);
  });
  const body = { email: EMAIL, code: reset.code, password: NEW_PASSWORD };
  const resetting = f.request("password/reset", { body });
  await entered;
  const login = f.login();
  const bindingResult = f.request("verify", { cookie: alice.cookie, body: { nonce: binding.nonce, signature } });
  const replay = f.request("password/reset", { body });
  const queuedSend = f.request("email/request", { cookie: alice.cookie });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([resetting, login, bindingResult, replay, queuedSend]);
  assert.deepEqual(results.map(item => item.status), [200, 401, 401, 400, 401]);
  assert.equal(current(f, alice.cookie), null);
  assert.equal(f.accounts.snapshot(alice.body.data.user.id).wallet, null);
  mocked.mock.restore();
  const fresh = await f.login(NEW_PASSWORD);
  const proof = await issue(f, "email-verification", fresh.cookie);
  const verified = await Promise.all([1, 2].map(() => f.request("email/verify", { cookie: fresh.cookie, body: { code: proof.code } })));
  assert.deepEqual(verified.map(item => item.status).sort(), [200, 400]);
});
