"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Wallet } = require("ethers");
const { createAccounts } = require("../wallet-accounts");

const PASSWORD = "temporary-test-password";
const PROFILE_KEYS = ["email", "emailTestVerified", "emailTestVerifiedAt", "emailVerificationMode", "emailVerified", "id", "name", "organization", "registeredAt", "wallet"];
const record = (email = "alice@example.test") => ({ name: " Alice ", email, password: PASSWORD, organization: " Relief Team " });

function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function construct(options, adminToken = "") {
  const previous = process.env.RELIEF_ADMIN_TOKEN;
  process.env.RELIEF_ADMIN_TOKEN = adminToken;
  try { return createAccounts(options); } finally {
    if (previous === undefined) delete process.env.RELIEF_ADMIN_TOKEN;
    else process.env.RELIEF_ADMIN_TOKEN = previous;
  }
}

async function fixture(t, overrides = {}, adminToken = "") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-wallet-accounts-test-"));
  let accounts;
  const donations = [];
  const server = http.createServer(async (req, res) => {
    try {
      const p = new URL(req.url, "http://localhost").pathname;
      if (await accounts.handle(req, res, p)) return;
      if (p === "/test/profile") return send(res, 200, { data: accounts.user(req) });
      if (p === "/test/actor") return send(res, 200, { data: accounts.actor(req) });
      if (p === "/test/admin") return send(res, accounts.isAdmin(req) ? 200 : 403, { data: accounts.isAdmin(req) });
      if (p === "/test/transaction" && req.method === "POST") {
        accounts.assertOrigin(req);
        const current = accounts.requireUser(req);
        donations.push({ id: crypto.randomUUID(), userId: current.id });
        return send(res, 201, { data: donations.at(-1) });
      }
      if (p === "/v1/wallet/me" && req.method === "GET") {
        const current = accounts.requireUser(req);
        return send(res, 200, { data: { user: current, donations: donations.filter(item => item.userId === current.id) } });
      }
      send(res, 404, { error: { code: "NOT_FOUND" } });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: { code: error.code, message: error.message } });
    }
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { dataDir, origin, chainId: 10143, send, readBody, ...overrides };
  accounts = construct(options, adminToken);

  async function request(p, { method = "POST", body = {}, cookie, headers = {}, raw } = {}) {
    const payload = raw === undefined ? JSON.stringify(body) : raw;
    return new Promise((resolve, reject) => {
      const req = http.request(`${origin}${p}`, {
        method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }
      }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => {
          try {
            const setCookie = res.headers["set-cookie"]?.[0];
            resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers, setCookie, cookie: setCookie?.split(";")[0] });
          } catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(method === "GET" ? undefined : payload);
    });
  }
  return {
    dataDir, origin, request, options,
    get accounts() { return accounts; },
    restart() { accounts = construct(options, adminToken); },
    register(email) { return request("/v1/wallet/register", { body: record(email) }); }
  };
}

function publicProfile(user) {
  assert.deepEqual(Object.keys(user).sort(), PROFILE_KEYS);
  assert.equal(user.emailVerified, false);
  assert.ok(Number.isFinite(Date.parse(user.registeredAt)));
  assert.equal(typeof user.id, "string");
}

function fakeRequest(cookie, extra = {}) {
  return { headers: { ...(cookie ? { cookie } : {}), ...extra } };
}

test("register/login/logout, private profiles, scrypt persistence and restart", async t => {
  const f = await fixture(t);
  const registered = await f.register(" ALICE@Example.Test ");
  assert.equal(registered.status, 201);
  assert.deepEqual(Object.keys(registered.body), ["data"]);
  const user = registered.body.data.user;
  publicProfile(user);
  assert.equal(user.name, "Alice");
  assert.equal(user.email, "alice@example.test");
  assert.equal(user.organization, "Relief Team");
  assert.equal(user.wallet, null);
  assert.match(registered.setCookie, /HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.match(registered.setCookie, /Path=\//);
  assert.doesNotMatch(registered.setCookie, /Secure|Domain=/);
  assert.equal(registered.headers["cache-control"], "no-store");
  assert.deepEqual(f.accounts.user(fakeRequest(registered.cookie)), user);
  const copy = f.accounts.snapshot(user.id);
  copy.name = "Changed externally";
  assert.equal(f.accounts.snapshot(user.id).name, "Alice");
  assert.equal(f.accounts.snapshot("missing"), null);
  assert.equal(f.accounts.getByWallet("invalid"), null);
  assert.equal(f.accounts.getByWallet(Wallet.createRandom().address), null);

  const text = fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8");
  const stored = JSON.parse(text).users[0];
  assert.match(stored.passwordSalt, /^[a-f0-9]{32}$/);
  assert.match(stored.passwordHash, /^[a-f0-9]{128}$/);
  assert.ok(!text.includes(PASSWORD));
  assert.ok(!text.includes(registered.cookie.split("=")[1]));
  const computed = await promisify(crypto.scrypt)(PASSWORD, Buffer.from(stored.passwordSalt, "hex"), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  assert.equal(computed.toString("hex"), stored.passwordHash);
  assert.deepEqual(fs.readdirSync(f.dataDir).sort(), ["accounts.json", "admin-access-token.txt"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.dataDir, "accounts.json")).mode & 0o777, 0o600);

  const wrong = await f.request("/v1/wallet/login", { body: { email: user.email, password: "incorrect-password" } });
  const absent = await f.request("/v1/wallet/login", { body: { email: "absent@example.test", password: PASSWORD } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(absent.body, wrong.body);
  assert.equal(wrong.setCookie, undefined);

  const loggedIn = await f.request("/v1/wallet/login", { body: { email: " ALICE@EXAMPLE.TEST ", password: PASSWORD }, cookie: registered.cookie });
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(loggedIn.body.data.user, user);
  assert.notEqual(loggedIn.cookie, registered.cookie);
  assert.equal(f.accounts.user(fakeRequest(registered.cookie)), null);
  assert.deepEqual(f.accounts.requireUser(fakeRequest(loggedIn.cookie)), user);
  const logout = await f.request("/v1/wallet/logout", { cookie: loggedIn.cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie, /relief_session=;.*Max-Age=0/);
  assert.equal(f.accounts.user(fakeRequest(loggedIn.cookie)), null);
  assert.equal((await f.request("/v1/wallet/me", { method: "GET", cookie: loggedIn.cookie })).status, 401);
  assert.throws(() => f.accounts.requireUser(fakeRequest()), { status: 401, code: "AUTH_REQUIRED" });

  const beforeRestart = await f.request("/v1/wallet/login", { body: { email: user.email, password: PASSWORD } });
  f.restart();
  assert.equal(f.accounts.user(fakeRequest(beforeRestart.cookie)), null);
  assert.deepEqual(f.accounts.snapshot(user.id), user);
  const afterRestart = await f.request("/v1/wallet/login", { body: { email: user.email, password: PASSWORD } });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(afterRestart.body.data.user, user);
});

test("register validates input, bounds passwords and never accepts HTML fields", async t => {
  const f = await fixture(t);
  for (const patch of [
    { password: "123456789" }, { password: "x".repeat(129) }, { name: "<img src=x onerror=alert(1)>" },
    { name: "x".repeat(121) }, { email: "a..b@example.test" }, { email: "<b>@example.test" },
    { organization: "<script>alert(1)</script>" }, { organization: "x".repeat(161) }
  ]) {
    const result = await f.request("/v1/wallet/register", { body: { ...record(), ...patch } });
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.equal(result.setCookie, undefined);
  }
  for (const length of [10, 128]) {
    const result = await f.request("/v1/wallet/register", { body: { ...record(`length${length}@example.test`), password: "a".repeat(length) } });
    assert.equal(result.status, 201);
  }
});

test("strict JSON, Origin checks and unknown/GET routes leave routing to the server", async t => {
  const f = await fixture(t);
  for (const endpoint of ["register", "login", "logout", "challenge", "verify"]) {
    const wrongOrigin = await f.request(`/v1/wallet/${endpoint}`, { headers: { Origin: "https://attacker.test" } });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.body.error.code, "ORIGIN_FORBIDDEN");
    assert.equal((await f.request(`/v1/wallet/${endpoint}`, { headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await f.request(`/v1/wallet/${endpoint}`, { method: "GET" })).status, 404);
  }
  assert.throws(() => f.accounts.assertOrigin(fakeRequest(null, { origin: "null" })), { status: 403 });
  assert.doesNotThrow(() => f.accounts.assertOrigin(fakeRequest()));
  assert.doesNotThrow(() => f.accounts.assertOrigin(fakeRequest(null, { origin: f.origin })));
  assert.equal(await f.accounts.handle({ method: "GET" }, {}, "/v1/wallet/me"), false);
  assert.equal(await f.accounts.handle({ method: "POST" }, {}, "/v1/wallet/unknown"), false);
  assert.equal(await f.accounts.handle({ method: "PATCH" }, {}, "/v1/wallet/login"), false);
  for (const raw of ["{", "null", "[]", '"text"']) {
    assert.equal((await f.request("/v1/wallet/register", { raw })).status, 400);
  }
  assert.equal((await f.request("/v1/wallet/register", { body: record(), headers: { Origin: f.origin, "Content-Type": "application/json; charset=utf-8" } })).status, 201);
});

test("EIP-191 challenge binds identity/address/chain/origin; proof is single-use and private", async t => {
  const f = await fixture(t);
  const registered = await f.register();
  const cookie = registered.cookie;
  const user = registered.body.data.user;
  const wallet = Wallet.createRandom();
  assert.equal((await f.request("/v1/wallet/challenge", { body: { address: wallet.address } })).status, 401);
  assert.equal((await f.request("/v1/wallet/challenge", { cookie, body: { address: "bad" } })).status, 400);
  const challenge = await f.request("/v1/wallet/challenge", { cookie, body: { address: wallet.address.toLowerCase() } });
  assert.equal(challenge.status, 200);
  const { nonce, message } = challenge.body.data;
  assert.deepEqual(Object.keys(challenge.body.data).sort(), ["message", "nonce"]);
  assert.match(nonce, /^[a-f0-9]{64}$/);
  for (const value of [user.id, wallet.address, f.origin, "Chain ID: 10143", nonce]) assert.ok(message.includes(value));
  for (const value of [user.name, user.email, user.organization]) assert.ok(!message.includes(value));
  const signature = await wallet.signMessage(message);
  const verified = await f.request("/v1/wallet/verify", { cookie, body: { nonce, signature } });
  assert.equal(verified.status, 200);
  publicProfile(verified.body.data.user);
  assert.equal(verified.body.data.user.wallet, wallet.address);
  assert.deepEqual(f.accounts.getByWallet(wallet.address.toLowerCase()), verified.body.data.user);
  const replay = await f.request("/v1/wallet/verify", { cookie, body: { nonce, signature } });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, "INVALID_CHALLENGE");
  const stored = fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8");
  for (const secret of [signature, nonce, message, wallet.privateKey, PASSWORD]) assert.ok(!stored.includes(secret));
  f.restart();
  assert.equal(f.accounts.getByWallet(wallet.address).id, user.id);
  assert.equal(f.accounts.user(fakeRequest(cookie)), null);
});

test("account mismatch, forged signatures, modified messages and wallet hijacking fail", async t => {
  const f = await fixture(t);
  const alice = await f.register();
  const bob = await f.register("bob@example.test");
  const wallet = Wallet.createRandom();
  const otherWallet = Wallet.createRandom();
  const issue = async cookie => (await f.request("/v1/wallet/challenge", { cookie, body: { address: wallet.address } })).body.data;
  const proof = await issue(alice.cookie);
  const signature = await wallet.signMessage(proof.message);
  const mismatch = await f.request("/v1/wallet/verify", { cookie: bob.cookie, body: { nonce: proof.nonce, signature } });
  assert.equal(mismatch.status, 403);
  assert.equal(f.accounts.snapshot(bob.body.data.user.id).wallet, null);
  for (const signer of [message => otherWallet.signMessage(message), message => wallet.signMessage(`${message}\nchanged`)]) {
    const challenge = await issue(alice.cookie);
    const forged = await signer(challenge.message);
    const rejected = await f.request("/v1/wallet/verify", { cookie: alice.cookie, body: { nonce: challenge.nonce, signature: forged } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_SIGNATURE");
    const retry = await f.request("/v1/wallet/verify", { cookie: alice.cookie, body: { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) } });
    assert.equal(retry.status, 400);
  }
  const valid = await issue(alice.cookie);
  assert.equal((await f.request("/v1/wallet/verify", { cookie: alice.cookie, body: { nonce: valid.nonce, signature: await wallet.signMessage(valid.message) } })).status, 200);
  const hijack = await f.request("/v1/wallet/challenge", { cookie: bob.cookie, body: { address: wallet.address } });
  assert.equal(hijack.status, 409);
  assert.equal(hijack.body.error.code, "WALLET_IN_USE");
  assert.equal(f.accounts.getByWallet(wallet.address).id, alice.body.data.user.id);
});

test("concurrent registration, wallet claims and replay serialize correctly", async t => {
  const f = await fixture(t);
  const registrations = await Promise.all([f.register("dupe@example.test"), f.register(" DUPE@EXAMPLE.TEST ")]);
  assert.deepEqual(registrations.map(result => result.status).sort(), [201, 409]);
  const alice = registrations.find(result => result.status === 201);
  const bob = await f.register("bob@example.test");
  const persisted = JSON.parse(fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8"));
  assert.equal(persisted.users.length, 2);
  assert.notEqual(persisted.users[0].passwordSalt, persisted.users[1].passwordSalt);
  assert.notEqual(persisted.users[0].passwordHash, persisted.users[1].passwordHash);
  const wallet = Wallet.createRandom();
  const claims = await Promise.all([alice, bob].map(async owner => {
    const response = await f.request("/v1/wallet/challenge", { cookie: owner.cookie, body: { address: wallet.address } });
    const { nonce, message } = response.body.data;
    return { cookie: owner.cookie, body: { nonce, signature: await wallet.signMessage(message) } };
  }));
  const results = await Promise.all(claims.map(claim => f.request("/v1/wallet/verify", claim)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8")).users.filter(user => user.wallet === wallet.address).length, 1);
  const secondWallet = Wallet.createRandom();
  const challenge = await f.request("/v1/wallet/challenge", { cookie: alice.cookie, body: { address: secondWallet.address } });
  const { nonce, message } = challenge.body.data;
  const claim = { cookie: alice.cookie, body: { nonce, signature: await secondWallet.signMessage(message) } };
  const replays = await Promise.all([f.request("/v1/wallet/verify", claim), f.request("/v1/wallet/verify", claim)]);
  assert.deepEqual(replays.map(result => result.status).sort(), [200, 400]);
});

test("challenges expire after five minutes and sessions after eight hours", async t => {
  const f = await fixture(t);
  const registered = await f.register();
  const wallet = Wallet.createRandom();
  const challenge = await f.request("/v1/wallet/challenge", { cookie: registered.cookie, body: { address: wallet.address } });
  const { nonce, message } = challenge.body.data;
  const signature = await wallet.signMessage(message);
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base + 5 * 60 * 1000 + 1;
    assert.equal((await f.request("/v1/wallet/verify", { cookie: registered.cookie, body: { nonce, signature } })).status, 400);
    assert.ok(f.accounts.user(fakeRequest(registered.cookie)));
    Date.now = () => base + 8 * 60 * 60 * 1000 + 1;
    assert.equal((await f.request("/v1/wallet/me", { method: "GET", cookie: registered.cookie })).status, 401);
  } finally { Date.now = realNow; }
});

test("personal scope, demo tokens rejected, and transaction requests cannot change authentication", async t => {
  const f = await fixture(t);
  const alice = await f.register();
  const bob = await f.register("bob@example.test");
  for (const token of ["demo-donor", "demo-platform-admin", "demo-finance"]) {
    const headers = { Authorization: `Bearer ${token}`, "X-Admin-Token": token };
    assert.equal((await f.request("/v1/wallet/me", { method: "GET", headers })).status, 401);
    assert.equal((await f.request("/test/actor", { method: "GET", headers })).body.data, null);
    assert.equal((await f.request("/test/admin", { method: "GET", headers })).status, 403);
  }
  const anonymous = fakeRequest("relief_session=demo-donor");
  assert.equal(f.accounts.user(anonymous), null);
  assert.equal(f.accounts.actor(anonymous), null);
  assert.equal(f.accounts.user(fakeRequest(`${alice.cookie}; ${bob.cookie}`)), null);
  assert.deepEqual(f.accounts.actor(fakeRequest(alice.cookie)), { userId: alice.body.data.user.id, organizationId: null, roles: ["donor"] });
  const storedBefore = fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8");
  for (const owner of [alice, bob]) {
    assert.equal((await f.request("/test/transaction", { cookie: owner.cookie, body: { userId: "fake", roles: ["platform_admin"], email: "other@example.test" } })).status, 201);
  }
  const views = await Promise.all([alice, bob].map(owner => f.request("/v1/wallet/me", { method: "GET", cookie: owner.cookie })));
  views.forEach((view, index) => {
    const owner = [alice, bob][index];
    publicProfile(view.body.data.user);
    assert.equal(view.body.data.user.id, owner.body.data.user.id);
    assert.equal(view.body.data.donations.length, 1);
    assert.equal(view.body.data.donations[0].userId, owner.body.data.user.id);
  });
  assert.notEqual(views[0].body.data.donations[0].id, views[1].body.data.donations[0].id);
  assert.equal(fs.readFileSync(path.join(f.dataDir, "accounts.json"), "utf8"), storedBefore);
});

test("admin token is generated privately, persists, and only the admin header grants access", async t => {
  const f = await fixture(t);
  assert.equal(f.accounts.adminTokenPath, path.join(f.dataDir, "admin-access-token.txt"));
  const token = fs.readFileSync(f.accounts.adminTokenPath, "utf8").trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.accounts.adminTokenPath).mode & 0o777, 0o600);
  assert.equal((await f.request("/test/admin", { method: "GET", headers: { "X-Admin-Token": token } })).status, 200);
  assert.equal((await f.request("/test/admin", { method: "GET", headers: { Authorization: `Bearer ${token}` } })).status, 403);
  assert.equal((await f.request("/test/admin", { method: "GET", headers: { "X-Admin-Token": "z".repeat(64) } })).status, 403);
  assert.equal((await f.request("/v1/wallet/me", { method: "GET", headers: { "X-Admin-Token": token } })).status, 401);
  f.restart();
  assert.ok(f.accounts.isAdmin(fakeRequest(null, { "x-admin-token": token })));
  fs.writeFileSync(f.accounts.adminTokenPath, "short");
  assert.throws(() => f.restart(), /Admin token file is invalid/);
});

test("configured admin token and Secure HTTPS session cookies", async t => {
  const configured = crypto.randomBytes(32).toString("hex");
  const f = await fixture(t, { origin: "https://wallet.example.test" }, configured);
  assert.equal(fs.existsSync(f.accounts.adminTokenPath), false);
  assert.ok(f.accounts.isAdmin(fakeRequest(null, { "x-admin-token": configured })));
  const registration = await f.register();
  assert.equal(registration.status, 201);
  assert.match(registration.setCookie, /; Secure/);
  assert.match((await f.request("/v1/wallet/logout", { cookie: registration.cookie })).setCookie, /Max-Age=0; Secure/);
  const short = await fixture(t, {}, "demo-platform-admin");
  assert.ok(fs.existsSync(short.accounts.adminTokenPath));
  assert.equal(short.accounts.isAdmin(fakeRequest(null, { "x-admin-token": "demo-platform-admin" })), false);
});

test("registration/login/challenge rates are bounded per IP, ignore forwarded IP, and expire", async t => {
  const f = await fixture(t);
  const registration = await f.register();
  const wallet = Wallet.createRandom();
  for (const [route, count, body, cookie] of [
    ["register", 9, {}, undefined], ["login", 20, {}, undefined],
    ["challenge", 30, { address: wallet.address }, registration.cookie]
  ]) {
    for (let i = 0; i < count; i++) {
      const result = await f.request(`/v1/wallet/${route}`, { body, cookie, headers: { "X-Forwarded-For": `192.0.2.${i}` } });
      assert.notEqual(result.status, 429);
    }
    const limited = await f.request(`/v1/wallet/${route}`, { body, cookie, headers: { "X-Forwarded-For": "203.0.113.1" } });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
  }
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base + 15 * 60 * 1000 + 1;
    assert.equal((await f.request("/v1/wallet/login", { body: { email: "alice@example.test", password: PASSWORD } })).status, 200);
  } finally { Date.now = realNow; }
});

test("failed registration storage rolls back identity and a later retry succeeds", async t => {
  const f = await fixture(t);
  const file = path.join(f.dataDir, "accounts.json");
  fs.mkdirSync(file);
  const rejected = await f.register();
  assert.equal(rejected.status, 500);
  assert.equal(rejected.body.error.code, "STORAGE_ERROR");
  assert.equal(rejected.setCookie, undefined);
  assert.equal((await f.request("/v1/wallet/login", { body: { email: "alice@example.test", password: PASSWORD } })).status, 401);
  assert.equal(fs.readdirSync(f.dataDir).filter(name => name.endsWith(".tmp")).length, 0);
  fs.rmdirSync(file);
  assert.equal((await f.register()).status, 201);
});

test("failed wallet persistence preserves profile and does not permit proof replay", async t => {
  const f = await fixture(t);
  const alice = await f.register();
  const wallet = Wallet.createRandom();
  const challenge = await f.request("/v1/wallet/challenge", { cookie: alice.cookie, body: { address: wallet.address } });
  const { nonce, message } = challenge.body.data;
  const claim = { cookie: alice.cookie, body: { nonce, signature: await wallet.signMessage(message) } };
  const file = path.join(f.dataDir, "accounts.json");
  const backup = path.join(f.dataDir, "accounts.backup.json");
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  const result = await f.request("/v1/wallet/verify", claim);
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "STORAGE_ERROR");
  assert.equal(f.accounts.user(fakeRequest(alice.cookie)).wallet, null);
  assert.equal(f.accounts.getByWallet(wallet.address), null);
  assert.equal((await f.request("/v1/wallet/verify", claim)).status, 400);
  fs.rmdirSync(file);
  fs.renameSync(backup, file);
  const fresh = (await f.request("/v1/wallet/challenge", { cookie: alice.cookie, body: { address: wallet.address } })).body.data;
  assert.equal((await f.request("/v1/wallet/verify", { cookie: alice.cookie, body: { nonce: fresh.nonce, signature: await wallet.signMessage(fresh.message) } })).status, 200);
});

test("corrupt stores fail startup instead of silently discarding accounts", async t => {
  const f = await fixture(t);
  await f.register();
  const file = path.join(f.dataDir, "accounts.json");
  const original = fs.readFileSync(file, "utf8");
  const duplicate = JSON.parse(original);
  duplicate.users.push({ ...duplicate.users[0], id: crypto.randomUUID() });
  for (const bad of ["{", JSON.stringify({ users: [] }), JSON.stringify(duplicate)]) {
    fs.writeFileSync(file, bad);
    assert.throws(() => f.restart(), /Cannot load accounts.json/);
    assert.equal(fs.readFileSync(file, "utf8"), bad);
  }
  fs.writeFileSync(file, original);
  f.restart();
});

test("errors after response headers never escape handle", async t => {
  const f = await fixture(t, { send(res, status, value) { send(res, status, value); throw new Error("late injected failure"); } });
  assert.equal((await f.register()).status, 201);
  assert.equal((await f.request("/v1/wallet/login", { headers: { Origin: "https://attacker.test" } })).status, 403);
  const response = { headersSent: true, writableEnded: false };
  assert.equal(await f.accounts.handle({ method: "POST" }, response, "/v1/wallet/login"), true);
});
