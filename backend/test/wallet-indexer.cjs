"use strict";

// Execute the production service and accounts. Only chain reads are mocked;
// HTTP, signatures, sessions and persistence use isolated real instances.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire, wrap } = require("node:module");
const ethers = require("ethers");
const artifact = require("../../web/shared/contracts/ReliefPool.json");

const servicePath = path.resolve(__dirname, "../wallet-service.js");
const productionRequire = createRequire(servicePath);
const serviceSource = fs.readFileSync(servicePath, "utf8");
const iface = new ethers.Interface(artifact.abi);
const POOL = ethers.getAddress("0x" + "10".repeat(20));
const DONOR = ethers.getAddress("0x" + "20".repeat(20));
const hash = label => ethers.id(label);
const tick = () => new Promise(resolve => setImmediate(resolve));

class MockRpc {
  constructor() {
    this.head = 3;
    this.branch = 0;
    this.logs = [[], []];
    this.transactions = new Map();
    this.receipts = new Map();
    this.transactionReads = [];
    this.calls = [];
    this.onLogs = null;
    this.onBlock = null;
  }
  blockHash(number, branch = this.branch) { return hash(`block:${branch}:${number}`); }
  async send(method) {
    this.calls.push({ method });
    assert.equal(method, "eth_chainId", `Unexpected raw RPC method: ${method}`);
    return "0x279f";
  }
  async getCode(address) {
    assert.equal(address.toLowerCase(), POOL.toLowerCase());
    return artifact.deployedBytecode;
  }
  async getBlockNumber() { return this.head; }
  async getBlock(tag) {
    const number = tag === "latest" ? this.head : Number(tag);
    this.calls.push({ method: "getBlock", number });
    if (this.onBlock) await this.onBlock(number);
    return { number, hash: this.blockHash(number), parentHash: this.blockHash(number - 1) };
  }
  async getLogs(filter) {
    assert.equal(filter.address.toLowerCase(), POOL.toLowerCase());
    this.calls.push({ method: "getLogs", from: Number(filter.fromBlock), to: Number(filter.toBlock) });
    const selected = this.logs[this.branch].filter(log => log.blockNumber >= Number(filter.fromBlock) && log.blockNumber <= Number(filter.toBlock));
    if (this.onLogs) return this.onLogs(filter, structuredClone(selected));
    return structuredClone(selected);
  }
  async getTransaction(txHash) {
    this.transactionReads.push(txHash);
    return this.transactions.get(txHash) || null;
  }
  async getTransactionReceipt(txHash) { return this.receipts.get(txHash) || null; }
  destroy() {}
}

function donationLog(rpc, label, { branch = rpc.branch, blockNumber = 2, amountMon = "1", donor = DONOR, donationId = hash(label), txHash = hash(`tx:${label}`) } = {}) {
  const encoded = iface.encodeEventLog(iface.getEvent("DonationReceived"), [donationId, donor, 1, ethers.parseEther(amountMon)]);
  return {
    ...encoded, address: POOL, index: 0, transactionIndex: 0, removed: false,
    blockNumber, blockHash: rpc.blockHash(blockNumber, branch), transactionHash: txHash
  };
}

function loadService(rpc) {
  const module = { exports: {} };
  const mockEthers = {
    ...ethers,
    JsonRpcProvider: class { constructor() { return rpc; } },
    Contract: class {
      async getTasks() { return []; }
    }
  };
  const execute = vm.runInThisContext(wrap(serviceSource), { filename: servicePath });
  execute(module.exports, name => name === "ethers" ? mockEthers : productionRequire(name), module, servicePath, path.dirname(servicePath));
  return module.exports.createWalletService;
}

async function fixture(t, seed = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-wallet-indexer-"));
  const ledgerPath = path.join(dataDir, "wallet-ledger.json");
  const rpc = new MockRpc();
  const previousEnv = new Map(["RELIEF_ADMIN_TOKEN", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK"].map(name => [name, process.env[name]]));
  process.env.RELIEF_ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
  delete process.env.MONAD_POOL_ADDRESS;
  delete process.env.MONAD_START_BLOCK;
  let service;
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      if (service) await service.close();
    } finally {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const resolved = path.resolve(dataDir);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith("relief-wallet-indexer-"));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  fs.writeFileSync(ledgerPath, JSON.stringify({
    config: { address: POOL, startBlock: 1, chainId: 10143 },
    intents: [], events: [], checkpoints: [], through: null, chainTasks: [], version: 0, lastSyncedAt: null,
    ...seed
  }), { mode: 0o600 });
  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
  async function readBody(req) {
    let body = "";
    for await (const chunk of req) body += chunk;
    return JSON.parse(body || "{}");
  }
  server = http.createServer(async (req, res) => {
    try {
      if (!await service.route(req, res, new URL(req.url, "http://localhost").pathname)) send(res, 404, {});
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: { message: error.message } });
      else res.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = loadService(rpc)({ dataDir, origin, send, readBody, options: { rpcUrl: "http://mock.invalid", confirmations: 2 } });

  async function request(route, { body, session, key } = {}) {
    const response = await fetch(`${origin}/v1/wallet/${route}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
      headers: {
        Origin: origin, "Content-Type": "application/json",
        ...(session?.cookie ? { Cookie: session.cookie } : {}), ...(key ? { "Idempotency-Key": key } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const cookie = response.headers.get("set-cookie");
    if (session && cookie) session.cookie = cookie.split(";")[0];
    return { status: response.status, ...await response.json() };
  }
  async function register(name) {
    const wallet = ethers.Wallet.createRandom();
    const session = { cookie: "", wallet };
    const registered = await request("register", { session, body: { name, email: `${name}@example.test`, organization: "Regression", password: "test-only-password-123" } });
    assert.equal(registered.status, 201, JSON.stringify(registered));
    session.user = registered.data.user;
    const challenge = await request("challenge", { session, body: { address: wallet.address } });
    assert.equal(challenge.status, 200, JSON.stringify(challenge));
    const verified = await request("verify", { session, body: { nonce: challenge.data.nonce, signature: await wallet.signMessage(challenge.data.message) } });
    assert.equal(verified.status, 200, JSON.stringify(verified));
    return session;
  }
  async function prepare(session) {
    const result = await request("donations/prepare", { session, key: crypto.randomUUID(), body: { amountMon: "1", purpose: 1 } });
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.data;
  }
  async function syncOnce() {
    // submit starts sync without awaiting it; drain its immediate mock reads first.
    await tick();
    await service.sync();
    await tick();
  }
  async function settleReady() {
    for (let pass = 0; pass < 6; pass++) {
      await syncOnce();
      const view = service.dashboard();
      if (view.ready && view.syncStatus === "SYNCED" && view.confirmedBlock === rpc.head - 1) return view;
    }
    assert.fail(`Service never became ready: ${JSON.stringify(service.dashboard())}`);
  }
  return { service, rpc, request, register, prepare, syncOnce, settleReady, ledger: () => JSON.parse(fs.readFileSync(ledgerPath, "utf8")) };
}

function assertCanonical(f, orphanId, canonicalId) {
  const view = f.service.dashboard();
  assert.equal(view.ready, true, "The real service must recover, not remain paused in RPC_ERROR");
  assert.equal(view.syncStatus, "SYNCED");
  assert.equal(view.confirmedBlock, f.rpc.head - 1);
  assert.equal(view.totals.donatedMon, "2.0", "Only the new-chain 2 MON donation may count");
  assert.equal(view.totals.balanceMon, "2.0");
  assert.deepEqual(view.recentDonations.map(item => item.id), [canonicalId]);
  assert.ok(!f.ledger().events.some(event => event.donationId === orphanId), "Orphan logs must not remain persisted");
  for (const event of f.ledger().events) assert.equal(event.blockHash, f.rpc.blockHash(event.blockNumber));
}

test("reorg while getLogs returns: discard orphan logs, recover ready and index canonical funds once", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const orphan = donationLog(f.rpc, "orphan-during-logs", { branch: 0 });
  const canonical = donationLog(f.rpc, "canonical-after-logs", { branch: 1, amountMon: "2" });
  f.rpc.logs = [[orphan], [canonical]];
  let triggered = false;
  f.rpc.onLogs = async (_filter, oldLogs) => {
    if (!triggered) {
      triggered = true;
      f.rpc.branch = 1;
      return oldLogs;
    }
    return oldLogs;
  };
  await f.syncOnce();
  const firstPass = f.ledger();
  await f.settleReady();
  assert.equal(triggered, true);
  assertCanonical(f, orphan.topics[1], canonical.topics[1]);
  assert.ok(!firstPass.events.some(event => event.donationId === orphan.topics[1]), "Never commit the orphan batch, even temporarily");
  await f.syncOnce();
  assertCanonical(f, orphan.topics[1], canonical.topics[1]);
});

test("stale per-log block hash is rejected even when both range anchors agree", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const orphan = donationLog(f.rpc, "stale-log", { branch: 0, blockNumber: 1 });
  const canonical = donationLog(f.rpc, "fresh-log", { branch: 1, amountMon: "2" });
  f.rpc.branch = 1;
  f.rpc.logs[1] = [canonical];
  let deliveredStaleLog = false;
  f.rpc.onLogs = async (_filter, freshLogs) => {
    if (!deliveredStaleLog) { deliveredStaleLog = true; return [orphan]; }
    return freshLogs;
  };
  await f.syncOnce();
  const firstPass = f.ledger();
  await f.settleReady();
  assert.equal(deliveredStaleLog, true);
  assertCanonical(f, orphan.topics[1], canonical.topics[1]);
  assert.ok(!firstPass.events.some(event => event.donationId === orphan.topics[1]));
});

test("previous checkpoint changing before the new range anchor cannot retain old funds", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const orphan = donationLog(f.rpc, "previous-checkpoint-orphan", { branch: 0, blockNumber: 1 });
  const canonical = donationLog(f.rpc, "checkpoint-canonical", { branch: 1, amountMon: "2" });
  f.rpc.head = 2;
  f.rpc.logs = [[orphan], [canonical]];
  await f.settleReady();
  assert.equal(f.service.dashboard().totals.donatedMon, "1.0");
  f.rpc.head = 3;
  let triggered = false;
  f.rpc.onBlock = async number => {
    // The original checkpoint (block 1) was already checked. Fork immediately
    // before reading the new range anchor, so both new-anchor reads agree.
    if (number === 2 && !triggered) { triggered = true; f.rpc.branch = 1; }
  };
  await f.syncOnce();
  await f.settleReady();
  assert.equal(triggered, true);
  assertCanonical(f, orphan.topics[1], canonical.topics[1]);
});

test("unverified hash claim cannot block its real donor; retries never duplicate credit", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.settleReady();
  const alice = await f.register("alice");
  const bob = await f.register("bob");
  const aliceIntent = await f.prepare(alice);
  const bobIntent = await f.prepare(bob);
  const txHash = hash("alice-wallet-transaction");
  const submit = (session, id) => f.request("donations/submit", { session, key: `submit:${id}`, body: { id, txHash } });

  // Neither user has broadcast yet. Bob first claims the same arbitrary hash.
  const claimed = await submit(bob, bobIntent.id);
  assert.equal(claimed.status, 202, JSON.stringify(claimed));
  const accepted = await submit(alice, aliceIntent.id);
  assert.equal(accepted.status, 202, "An unverified cross-user hash claim must not produce DUPLICATE_TRANSACTION");
  assert.equal((await submit(alice, aliceIntent.id)).status, 202);

  f.rpc.transactions.set(txHash, {
    hash: txHash, from: alice.wallet.address, to: POOL,
    value: ethers.parseEther("1"), data: aliceIntent.transaction.data, chainId: 10143n
  });
  f.rpc.receipts.set(txHash, { status: 1, blockNumber: 3, blockHash: f.rpc.blockHash(3) });
  f.rpc.head = 4;
  f.rpc.logs[0] = [donationLog(f.rpc, "alice-confirmed", { blockNumber: 3, donor: alice.wallet.address, donationId: aliceIntent.id, txHash })];
  await f.settleReady();
  assert.equal((await submit(alice, aliceIntent.id)).status, 202, "Confirmed retries must remain valid even after the other claim fails");
  await f.syncOnce();
  const own = await f.request("me", { session: alice });
  const other = await f.request("me", { session: bob });
  assert.equal(own.status, 200);
  assert.equal(other.status, 200);
  assert.equal(own.data.totals.donatedMon, "1.0");
  assert.equal(own.data.donations.filter(item => item.id === aliceIntent.id && item.status === "CONFIRMED").length, 1);
  assert.equal(other.data.totals.donatedMon, "0.0");
  assert.equal(other.data.donations.find(item => item.id === bobIntent.id).status, "FAILED");
  assert.equal(f.ledger().intents.length, 2);
  assert.equal(f.ledger().events.filter(event => event.name === "DonationReceived").length, 1);
  assert.equal(f.service.dashboard().totals.donatedMon, "1.0");
  assert.equal(f.service.config().ready, true);
});

test("51st pending transaction is checked despite 50 permanently missing hashes", { timeout: 15000 }, async t => {
  const intents = Array.from({ length: 51 }, (_, index) => ({
    id: hash(`pending:${index}`), userId: index < 50 ? "first-user" : "later-user", donor: null,
    wallet: DONOR, amountWei: ethers.parseEther("1").toString(), purpose: 1,
    status: "SUBMITTED", requestKey: `pending-key:${index}`, requestHash: hash(`request:${index}`),
    createdAt: new Date().toISOString(), txHash: hash(`pending-tx:${index}`),
    preview: { allocations: [], unallocatedMon: "1.0" }
  }));
  const f = await fixture(t, { intents });
  const last = intents[50];
  f.rpc.transactions.set(last.txHash, {
    hash: last.txHash, from: DONOR, to: POOL, value: ethers.parseEther("1"),
    data: iface.encodeFunctionData("donate", [last.id, last.purpose]), chainId: 10143n
  });
  f.rpc.receipts.set(last.txHash, { status: 0, blockNumber: 1, blockHash: f.rpc.blockHash(1) });
  for (let pass = 0; pass < 3; pass++) await f.syncOnce();
  assert.equal(f.service.config().ready, true, "Fairness must not depend on stopping synchronization");
  assert.equal(f.service.dashboard().syncStatus, "SYNCED");
  assert.ok(f.rpc.transactionReads.includes(last.txHash), "Later users must be reached within three passes through 51 pending items");
  assert.equal(f.ledger().intents.find(item => item.id === last.id).status, "FAILED", "Inspect the actual reverted receipt, not merely advance a cursor");
  assert.ok(intents.slice(0, 50).every(item => f.rpc.transactionReads.includes(item.txHash)));
  assert.equal(f.service.dashboard().totals.donatedMon, "0.0");
});
