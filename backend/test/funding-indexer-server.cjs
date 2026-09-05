"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const ganache = require("ganache");
const { BrowserProvider, ContractFactory, Wallet, ZeroHash, id, keccak256 } = require("ethers");
const { getArtifact, permitTypes, feePolicyHash } = require("./helpers/donation-ledger-fixture.cjs");
const { createDonationIntentStore } = require("../donation-intent-store");
const { createFundingStore } = require("../funding-store");

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test("actual backend continuously indexes confirmed local EVM funding without a client mutation route", { timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-funding-indexer-server-"));
  const rpc = ganache.provider({ chain: { chainId: 10143, hardfork: "merge" }, logging: { quiet: true },
    miner: { blockGasLimit: 30_000_000 }, wallet: { totalAccounts: 7, defaultBalance: 100 } });
  async function dispatch(request) {
    try { return { jsonrpc: "2.0", id: request.id, result: await rpc.request({ method: request.method, params: request.params || [] }) }; }
    catch (error) { return { jsonrpc: "2.0", id: request.id, error: { code: error.code || -32000, message: error.message, data: error.data } }; }
  }
  const chain = http.createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body), result = Array.isArray(value) ? await Promise.all(value.map(dispatch)) : await dispatch(value);
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(result));
    } catch (error) {
      t.diagnostic(`rpc-proxy-error: ${error.stack || error.message}`);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error.message) }));
    }
  });
  await new Promise(resolve => chain.listen(0, "127.0.0.1", resolve));
  const chainPort = chain.address().port, rpcUrl = `http://127.0.0.1:${chainPort}/`;
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  const appPort = await freePort(), base = `http://127.0.0.1:${appPort}`;
  let child = null, output = "";
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(); await new Promise(resolve => child.once("exit", resolve));
      }
    } finally {
      provider.destroy(); chain.closeAllConnections(); await new Promise(resolve => chain.close(resolve)); await rpc.disconnect();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("relief-funding-indexer-server-"));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const [admin, donor, , registrar, operator] = await Promise.all(Array.from({ length: 5 }, (_, index) => provider.getSigner(index)));
  const artifact = getArtifact(), ledger = await new ContractFactory(artifact.abi, artifact.bytecode, admin).deploy(admin.address);
  await ledger.waitForDeployment(); const deployment = await ledger.deploymentTransaction().wait(), poolAddress = await ledger.getAddress();
  for (const [role, signer] of [["REGISTRAR_ROLE", registrar], ["TASK_OPERATOR_ROLE", operator]])
    await (await ledger.grantRole(await ledger[role](), signer.address)).wait();
  const taskId = id("server-indexed-task"), projectId = id("server-indexed-project");
  await (await ledger.connect(operator).registerTask(taskId, 2, projectId, 3, 100n)).wait();
  const latest = await provider.getBlock("latest"), initial = { donationId: id("server-indexed-donation"), donor: donor.address,
    purpose: 2, projectId, amountWei: 100n, gasReservedWei: 10n, registrationHash: id("replaced-by-private-intent"),
    nonce: 1n, deadline: BigInt(latest.timestamp + 3600), authorizationEpoch: await ledger.authorizationEpochs(registrar.address),
    feePolicyHash, registrar: registrar.address };
  const intentFile = path.join(directory, "funding", "donation-intents.sqlite");
  const intents = createDonationIntentStore({ file: intentFile, chainId: "10143", poolAddress });
  const terms = Object.fromEntries(Object.entries(initial).filter(([key]) => !["donor", "registrationHash"].includes(key))
    .map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
  const prepared = intents.prepare({ profile: { id: "server-indexed-user", name: "Server Indexed User",
    email: "server.indexed@example.invalid", organization: "Indexer Server Test", wallet: donor.address,
    registeredAt: "2026-09-01T00:00:00.000Z", emailVerified: false, emailTestVerified: false,
    emailTestVerifiedAt: null, emailVerificationMode: "local-test" }, terms });
  intents.close();
  const accounts = rpc.getInitialAccounts(), registrarWallet = new Wallet(accounts[registrar.address.toLowerCase()].secretKey);
  const signature = await registrarWallet.signTypedData({ name: "ReliefFunding", version: "2", chainId: 10143, verifyingContract: poolAddress }, permitTypes, prepared.permit);
  await (await ledger.connect(donor).donate(prepared.permit, registrar.address, signature, { value: prepared.permit.amountWei })).wait();

  const env = { ...process.env, PORT: String(appPort), DATA_DIR: directory, PUBLIC_BASE_URL: base, CORS_ORIGIN: base,
    NODE_ENV: "test", RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false", RELIEF_MAIL_MODE: "local-test",
    MONAD_FUNDING_POOL_ADDRESS: poolAddress, MONAD_FUNDING_RPC_URL: rpcUrl,
    MONAD_FUNDING_RUNTIME_CODE_HASH: keccak256(await provider.getCode(poolAddress)), MONAD_FUNDING_START_BLOCK: String(deployment.blockNumber),
    MONAD_FUNDING_CONFIRMATIONS: "1", MONAD_FUNDING_POLL_INTERVAL_MS: "1000" };
  for (const key of ["MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "MONAD_PROCUREMENT_POOL_ADDRESS", "RELIEF_ADMIN_TOKEN"]) delete env[key];
  function startChild() {
    child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; }); return child;
  }
  startChild();
  async function get(route) {
    const response = await fetch(base + route, { headers: { Origin: base }, signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  }
  let pool;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) assert.fail(output);
    try {
      pool = await get("/v1/funding/pool");
      if (pool.status === 200 && pool.body.data.connection.live && pool.body.data.summary?.donatedWei === "100") break;
    } catch (_) { /* Service or first scan is not ready yet. */ }
    await wait(100);
  }
  assert.equal(pool?.status, 200, output); assert.equal(pool.body.data.connection.live, true, output);
  assert.equal(pool.body.data.summary.donatedWei, "100"); assert.equal(pool.body.data.summary.donorCount, 1);
  const health = await get("/v1/health"); assert.equal(health.body.funding.live, true); assert.equal(health.body.funding.indexerState, "IDLE");
  assert.equal((await get("/v1/funding/admin/indexer")).status, 401);
  const token = fs.readFileSync(path.join(directory, "wallet", "admin-access-token.txt"), "utf8").trim();
  const authenticated = await fetch(base + "/v1/admin/session", { method: "POST", headers: { Origin: base,
    "X-Relief-Actor": "admin", "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(authenticated.status, 200); const cookie = authenticated.headers.get("set-cookie").split(";")[0];
  const adminStatusResponse = await fetch(base + "/v1/funding/admin/indexer", { headers: { Origin: base,
    "X-Relief-Actor": "admin", Cookie: cookie } });
  assert.equal(adminStatusResponse.status, 200); const adminStatus = await adminStatusResponse.json();
  assert.equal(adminStatus.data.indexer.polling, true); assert.equal(adminStatus.data.indexer.state, "IDLE");
  assert.equal(JSON.stringify(adminStatus).includes(rpcUrl), false, "admin status must not expose the configured RPC URL");
  assert.equal(fs.existsSync(path.join(directory, "funding", "indexer.sqlite")), true);

  await (await ledger.connect(operator).setTaskActive(taskId, false)).wait();
  const pauseBlock = await provider.getBlockNumber();
  for (let attempt = 0; attempt < 80; attempt++) {
    pool = await get("/v1/funding/pool");
    if (pool.body.data.connection.indexedThroughBlock >= pauseBlock) break;
    await wait(100);
  }
  const funding = createFundingStore({ file: path.join(directory, "funding", "funding.sqlite"), chainId: "10143", poolAddress });
  try { assert.equal(funding.read().tasks[0].status, "PAUSED"); } finally { funding.close(); }
  assert.equal(pool.body.data.connection.live, true); assert.equal(pool.body.data.connection.indexedThroughBlock, pauseBlock);

  child.kill(); await new Promise(resolve => child.once("exit", resolve));
  const staleLockExpected = fs.existsSync(path.join(directory, "funding", "indexer.sqlite.lock"));
  output = ""; startChild();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(output);
    try { pool = await get("/v1/funding/pool"); if (pool.body.data.connection.live) break; } catch (_) {}
    await wait(100);
  }
  assert.equal(pool.body.data.connection.live, true, output); assert.equal(pool.body.data.summary.donatedWei, "100");
  if (staleLockExpected) assert.ok(fs.readdirSync(path.join(directory, "funding")).some(name => name.startsWith("indexer.sqlite.lock.stale-")));
});
