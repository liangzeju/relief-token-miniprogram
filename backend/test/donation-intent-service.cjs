"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Wallet, id, ZeroHash } = require("ethers");
const { createAccounts } = require("../wallet-accounts");
const { createDonationIntentStore } = require("../donation-intent-store");
const { createDonationIntentService } = require("../donation-intent-service");

const origin = "http://localhost:9876", pool = "0x" + "22".repeat(20);
const policy = { gasReservedWei: "5", feePolicyHash: id("LOCAL_TEST_POLICY_ONLY"),
  registrar: "0x" + "33".repeat(20), authorizationEpoch: "0", deadline: "9999999999" };
const requestBody = () => ({ requestId: crypto.randomUUID(), purpose: 1, projectId: ZeroHash, amountWei: "100" });

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-intent-service-"));
  const store = createDonationIntentStore({ file: path.join(directory, "intents.sqlite"), chainId: "10143", poolAddress: pool });
  t.after(() => { store.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("relief-intent-service-")); fs.rmSync(directory, { recursive: true, force: true }); });
  const accounts = createAccounts({ dataDir: path.join(directory, "accounts"), origin, chainId: 10143,
    send(res, status, body) { res.status = status; res.body = body; res.writableEnded = true; }, readBody: async req => req.body });
  let cookie;
  const req = (extra = {}) => ({ headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, socket: { remoteAddress: "127.0.0.1" } });
  async function post(route, body = {}) {
    const res = { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; } };
    await accounts.handle({ ...req(), method: "POST", body }, res, `/v1/wallet/${route}`);
    const setCookie = res.headers["set-cookie"];
    if (setCookie) cookie = setCookie.split(";")[0];
    assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
    return res.body.data;
  }
  async function bind(wallet) {
    const challenge = await post("challenge", { address: wallet.address });
    return post("verify", { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) });
  }
  const registered = await post("register", { name: "Original Donor", email: "donor@example.test", organization: "Local Test Team", password: "test-only-password-123" });
  return { store, accounts, directory, req, post, bind, user: registered.user, wallet: Wallet.createRandom(),
    service: resolveTerms => createDonationIntentService({ accounts, store, resolveTerms }) };
}

test("real registration and signed wallet binding create private historical donation intent; default policy remains closed", async t => {
  const f = await fixture(t), body = requestBody();
  await assert.rejects(() => f.service().prepare(f.req(), body), { code: "WALLET_BINDING_REQUIRED" });
  await f.bind(f.wallet);
  await assert.rejects(() => f.service().prepare(f.req(), body), { code: "FUNDING_POLICY_NOT_CONFIGURED" });
  assert.deepEqual(f.store.listForUser(f.user.id), []);
  let calls = 0;
  const service = f.service(async context => { calls++; assert.equal(context.user.id, f.user.id); return policy; });
  const record = await service.prepare(f.req(), body);
  assert.equal(record.userId, f.user.id); assert.equal(record.profile.name, "Original Donor");
  assert.equal(record.profile.email, "donor@example.test"); assert.equal(record.profile.emailVerified, false);
  assert.equal(record.wallet, f.wallet.address.toLowerCase()); assert.equal(record.permit.amountWei, "100");
  assert.equal(record.permit.gasReservedWei, "5"); assert.ok(BigInt(record.permit.nonce) >= 0n);
  assert.equal(record.registrationHash, record.permit.registrationHash);
  assert.deepEqual(await service.prepare(f.req(), body), record); assert.equal(calls, 1);
  assert.deepEqual(service.getOwn(f.req(), record.permit.donationId), record);
  assert.deepEqual(service.listOwn(f.req()), [record]);
  const encoded = JSON.stringify(record);
  assert.doesNotMatch(encoded, /test-only-password|passwordHash|passwordSalt|relief_session/);
  await assert.rejects(() => service.prepare(f.req(), { ...body, amountWei: "101" }), { code: "DONATION_REQUEST_CONFLICT" });
  const oldWallet = record.wallet;
  await f.bind(Wallet.createRandom());
  assert.equal(f.accounts.requireUser(f.req()).wallet.toLowerCase() === oldWallet, false);
  assert.deepEqual(service.getOwn(f.req(), record.permit.donationId), record);
  await assert.rejects(() => service.prepare(f.req(), body), { code: "DONATION_WALLET_CHANGED" });
  await f.post("logout");
  assert.throws(() => service.getOwn(f.req(), record.permit.donationId), { code: "AUTH_REQUIRED" });
});

test("preparation rejects injected identity, amounts, policy and cross-origin input before policy evaluation", async t => {
  const f = await fixture(t); await f.bind(f.wallet);
  let called = 0;
  const service = f.service(async () => { called++; return policy; });
  const body = requestBody();
  for (const change of [{ userId: "another-user" }, { wallet: pool }, { gasReservedWei: "0" }, { registrationHash: id("fake") },
    { nonce: "1" }, { amountWei: 100 }, { amountWei: "0100" }, { amountWei: "0" }, { amountWei: (1n << 256n).toString() },
    { amountWei: "-1" }, { purpose: "1" }, { purpose: 6 }, { projectId: "project-a" }, { requestId: "not-a-uuid" }]) {
    await assert.rejects(() => service.prepare(f.req(), { ...body, ...change }), { code: "INVALID_DONATION_REQUEST" });
  }
  await assert.rejects(() => service.prepare(f.req({ origin: "http://evil.test" }), body), { status: 403 });
  assert.equal(called, 0); assert.deepEqual(service.listOwn(f.req()), []);
});

test("account changes or logout while server policy resolves cannot persist a stale donation owner", async t => {
  const f = await fixture(t); await f.bind(f.wallet);
  const body = requestBody();
  const service = f.service(async () => { await f.bind(Wallet.createRandom()); return policy; });
  await assert.rejects(() => service.prepare(f.req(), body), { code: "ACCOUNT_CHANGED_DURING_PREPARATION" });
  assert.deepEqual(f.store.listForUser(f.user.id), []);
  const logout = f.service(async () => { await f.post("logout"); return policy; });
  await assert.rejects(() => logout.prepare(f.req(), body), { code: "AUTH_REQUIRED" });
  assert.deepEqual(f.store.listForUser(f.user.id), []);
});

test("concurrent same-request retries reuse one immutable intent and distinct users cannot read each other's snapshot", async t => {
  const f = await fixture(t); await f.bind(f.wallet);
  const service = f.service(async () => { await new Promise(resolve => setImmediate(resolve)); return policy; });
  const body = requestBody();
  const results = await Promise.all([service.prepare(f.req(), body), service.prepare(f.req(), body)]);
  assert.deepEqual(results[0], results[1]); assert.equal(service.listOwn(f.req()).length, 1);
  await f.bind(Wallet.createRandom());
  await f.post("logout");
  await f.post("register", { name: "Second Donor", email: "second@example.test", organization: "", password: "test-only-password-456" });
  await f.bind(f.wallet);
  assert.notEqual(f.accounts.getByWallet(f.wallet.address).id, results[0].userId);
  assert.throws(() => service.getOwn(f.req(), results[0].permit.donationId), { code: "DONATION_INTENT_NOT_FOUND" });
  assert.deepEqual(service.listOwn(f.req()), []);
});

test("incomplete server fee policy never falls back to zero fee or accepts policy identity injection", async t => {
  const f = await fixture(t); await f.bind(f.wallet);
  for (const value of [null, {}, { ...policy, donor: pool }, { ...policy, donationId: id("injected") }]) {
    await assert.rejects(() => f.service(async () => value).prepare(f.req(), requestBody()), { code: "FUNDING_POLICY_NOT_CONFIGURED" });
  }
  assert.deepEqual(f.store.listForUser(f.user.id), []);
});

test("a competing prepared record between read and write is reconciled without overwriting the winning nonce", async t => {
  const f = await fixture(t); await f.bind(f.wallet);
  const service = createDonationIntentService({ accounts: f.accounts, resolveTerms: async () => policy,
    store: { ...f.store, prepare(value) {
      f.store.prepare({ profile: value.profile, terms: { ...value.terms, nonce: "1" } });
      return f.store.prepare({ profile: value.profile, terms: { ...value.terms, nonce: "2" } });
    } } });
  const record = await service.prepare(f.req(), requestBody());
  assert.equal(record.permit.nonce, "1"); assert.deepEqual(service.listOwn(f.req()), [record]);
});
