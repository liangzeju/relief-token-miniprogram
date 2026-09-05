"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { Wallet, id, ZeroHash } = require("ethers");
const { createDonationIntentStore } = require("../../donation-intent-store");
const { createFundingStore } = require("../../funding-store");
const pool = "0x" + "22".repeat(20), config = { chainId: "10143", poolAddress: pool };
const password = "local-funding-read-password";

async function fixture({ configured = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-funding-read-"));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: directory, PUBLIC_BASE_URL: base, CORS_ORIGIN: base,
    NODE_ENV: "test", RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false", RELIEF_MAIL_MODE: "local-test" };
  for (const key of ["MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "MONAD_PROCUREMENT_POOL_ADDRESS", "RELIEF_ADMIN_TOKEN", "MONAD_FUNDING_POOL_ADDRESS"]) delete env[key];
  if (configured) env.MONAD_FUNDING_POOL_ADDRESS = pool;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", intents, funding, closed = false;
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  async function close() {
    if (closed) return; closed = true;
    intents?.close(); funding?.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-funding-read-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  try {
    let ready = false;
    for (let n = 0; n < 150; n++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const response = await fetch(base + "/v1/health"); if (response.ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Funding read fixture failed to start: " + output);
    if (configured) {
      intents = createDonationIntentStore({ file: path.join(directory, "funding/donation-intents.sqlite"), ...config });
      funding = createFundingStore({ file: path.join(directory, "funding/funding.sqlite"), ...config });
    }
    async function request(person, url, body, extra = {}) {
      const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: {
        Origin: base, ...(person?.cookie ? { Cookie: person.cookie } : {}), ...(person?.admin ? { "X-Relief-Actor": "admin" } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const json = await response.json(); return { status: response.status, json, headers: response.headers, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    }
    const token = fs.readFileSync(path.join(directory, "wallet/admin-access-token.txt"), "utf8").trim();
    const session = await request({ admin: true }, "/v1/admin/session", { token }); assert.equal(session.status, 200);
    const admin = { admin: true, cookie: session.cookie };
    async function bind(person, wallet) {
      const challenge = await request(person, "/v1/wallet/challenge", { address: wallet.address }); assert.equal(challenge.status, 200);
      const verified = await request(person, "/v1/wallet/verify", { nonce: challenge.json.data.nonce, signature: await wallet.signMessage(challenge.json.data.message) });
      assert.equal(verified.status, 200); person.user = verified.json.data.user; person.wallet = wallet; return person;
    }
    async function user(name) {
      const registered = await request(null, "/v1/wallet/register", { name, email: `${name.toLowerCase()}@example.test`, organization: "Test relief team", password });
      assert.equal(registered.status, 201);
      return bind({ cookie: registered.cookie, user: registered.json.data.user }, Wallet.createRandom());
    }
    let sequence = 0;
    function prepare(person, name, overrides = {}) {
      return intents.prepare({ profile: person.user, terms: { donationId: id(name), purpose: 1, projectId: ZeroHash,
        amountWei: "100000000000000000001", gasReservedWei: "1", nonce: String(++sequence), deadline: "9999999999",
        authorizationEpoch: "0", feePolicyHash: id("LOCAL_TEST_POLICY_ONLY"), registrar: "0x" + "33".repeat(20), ...overrides } });
    }
    let block = 0;
    function append(type, data) {
      block++;
      funding.append([{ type, data, ...config, blockNumber: block, transactionIndex: 0, logIndex: 0,
        txHash: id(`transaction-${block}`), blockHash: id(`block-${block}`) }], { expectedVersion: funding.read().storeVersion });
    }
    function received(record) {
      append("DonationReceived", { donationId: record.permit.donationId, donorUserId: record.userId, donorWallet: record.wallet,
        purpose: record.permit.purpose, projectId: record.permit.projectId === ZeroHash ? null : record.permit.projectId,
        amountWei: record.permit.amountWei, gasReservedWei: record.permit.gasReservedWei });
    }
    return { base, directory, admin, token, request, bind, user, prepare, append, received, intents, funding, close, pool };
  } catch (error) { await close(); throw error; }
}
module.exports = { fixture, config };
