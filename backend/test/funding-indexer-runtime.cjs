"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFundingIndexerConfig, createFundingIndexerRuntime } = require("../funding-indexer-runtime");

const pool = "0x" + "22".repeat(20), hash = "0x" + "33".repeat(32);
const complete = { MONAD_FUNDING_POOL_ADDRESS: pool, MONAD_FUNDING_RPC_URL: "http://127.0.0.1:8545/",
  MONAD_FUNDING_RUNTIME_CODE_HASH: hash, MONAD_FUNDING_START_BLOCK: "12" };

test("funding indexer environment is either saved-only, complete, or rejected", () => {
  assert.equal(readFundingIndexerConfig({}), null);
  assert.deepEqual(readFundingIndexerConfig({ MONAD_FUNDING_POOL_ADDRESS: pool }), { poolAddress: pool, enabled: false });
  assert.deepEqual(readFundingIndexerConfig(complete), { poolAddress: pool, enabled: true, rpcUrl: "http://127.0.0.1:8545/",
    runtimeCodeHash: hash, startBlock: 12, confirmations: 2, pollIntervalMs: 5000 });
  assert.deepEqual(readFundingIndexerConfig({ ...complete, MONAD_FUNDING_CONFIRMATIONS: "8", MONAD_FUNDING_POLL_INTERVAL_MS: "1000" }),
    { poolAddress: pool, enabled: true, rpcUrl: "http://127.0.0.1:8545/", runtimeCodeHash: hash,
      startBlock: 12, confirmations: 8, pollIntervalMs: 1000 });
  for (const env of [
    { MONAD_FUNDING_RUNTIME_CODE_HASH: hash },
    { MONAD_FUNDING_POOL_ADDRESS: pool, MONAD_FUNDING_RPC_URL: complete.MONAD_FUNDING_RPC_URL },
    { MONAD_FUNDING_POOL_ADDRESS: pool, MONAD_FUNDING_CONFIRMATIONS: "2" },
    { ...complete, MONAD_FUNDING_START_BLOCK: "0" }, { ...complete, MONAD_FUNDING_CONFIRMATIONS: "0" },
    { ...complete, MONAD_FUNDING_POLL_INTERVAL_MS: "999" }, { ...complete, MONAD_FUNDING_RPC_URL: "file:///private" },
    { ...complete, MONAD_FUNDING_RPC_URL: "https://user:secret@example.test" }, { ...complete, MONAD_FUNDING_RUNTIME_CODE_HASH: "0x" + "00".repeat(32) }
  ]) assert.throws(() => readFundingIndexerConfig(env));
});

test("runtime starts immediately, coalesces scans, reports errors and waits before closing", async () => {
  let resolve, scans = 0, closed = false, providerClosed = false, now = 10, failNext = false; const errors = [];
  const indexer = { status: () => ({ state: "IDLE", throughBlock: scans }), close: () => { closed = true; },
    scanOnce() { scans++; if (failNext) { failNext = false; return Promise.reject(Object.assign(new Error("rpc"), { code: "RPC_DOWN" })); }
      return new Promise(done => { resolve = done; }); } };
  const runtime = createFundingIndexerRuntime({ indexer, pollIntervalMs: 60000, clock: () => now++,
    reportError: code => errors.push(code), closeProvider: async () => { providerClosed = true; } });
  runtime.start(); assert.equal(scans, 1); assert.equal(runtime.status().polling, true);
  const same = runtime.scanOnce(); assert.equal(scans, 1); resolve({ ok: true }); await same;
  failNext = true; await assert.rejects(runtime.scanOnce(), { code: "RPC_DOWN" });
  assert.deepEqual(errors, ["RPC_DOWN"]); assert.equal(runtime.status().runtimeErrorCode, "RPC_DOWN");
  const pending = runtime.scanOnce(), closing = runtime.close(); assert.equal(closed, false); resolve({ ok: true }); await pending; await closing;
  assert.equal(closed, true); assert.equal(providerClosed, true); assert.equal(runtime.status().polling, false);
  await assert.rejects(runtime.scanOnce(), { code: "FUNDING_INDEXER_STOPPING" });
});
