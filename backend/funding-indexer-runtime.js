"use strict";

const { getAddress } = require("ethers");

function fail(code) { throw Object.assign(new Error(code), { code }); }
function integer(value, code, minimum, maximum) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(code);
  const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(code); return result;
}
function poolAddress(value) {
  try { const result = getAddress(value).toLowerCase(); if (/^0x0{40}$/.test(result)) fail("INVALID_FUNDING_INDEXER_CONFIGURATION"); return result; }
  catch (_) { fail("INVALID_FUNDING_INDEXER_CONFIGURATION"); }
}

function readFundingIndexerConfig(env = process.env) {
  const pool = env.MONAD_FUNDING_POOL_ADDRESS;
  const required = ["MONAD_FUNDING_RPC_URL", "MONAD_FUNDING_RUNTIME_CODE_HASH", "MONAD_FUNDING_START_BLOCK"];
  const supplied = required.filter(name => env[name] !== undefined && env[name] !== "");
  if (!pool) {
    if (supplied.length || env.MONAD_FUNDING_CONFIRMATIONS || env.MONAD_FUNDING_POLL_INTERVAL_MS) fail("INCOMPLETE_FUNDING_INDEXER_CONFIGURATION");
    return null;
  }
  const address = poolAddress(pool);
  const optionalSupplied = ["MONAD_FUNDING_CONFIRMATIONS", "MONAD_FUNDING_POLL_INTERVAL_MS"]
    .some(name => env[name] !== undefined && env[name] !== "");
  if (!supplied.length) {
    if (optionalSupplied) fail("INCOMPLETE_FUNDING_INDEXER_CONFIGURATION");
    return { poolAddress: address, enabled: false };
  }
  if (supplied.length !== required.length) fail("INCOMPLETE_FUNDING_INDEXER_CONFIGURATION");
  let rpc;
  try { rpc = new URL(env.MONAD_FUNDING_RPC_URL); } catch (_) { fail("INVALID_FUNDING_INDEXER_CONFIGURATION"); }
  if (!['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password || rpc.hash) fail("INVALID_FUNDING_INDEXER_CONFIGURATION");
  const runtimeCodeHash = env.MONAD_FUNDING_RUNTIME_CODE_HASH;
  if (!/^0x[0-9a-fA-F]{64}$/.test(runtimeCodeHash) || /^0x0{64}$/i.test(runtimeCodeHash)) fail("INVALID_FUNDING_INDEXER_CONFIGURATION");
  return { poolAddress: address, enabled: true, rpcUrl: rpc.toString(), runtimeCodeHash: runtimeCodeHash.toLowerCase(),
    startBlock: integer(env.MONAD_FUNDING_START_BLOCK, "INVALID_FUNDING_INDEXER_CONFIGURATION", 1, Number.MAX_SAFE_INTEGER),
    confirmations: integer(env.MONAD_FUNDING_CONFIRMATIONS || "2", "INVALID_FUNDING_INDEXER_CONFIGURATION", 1, 1000),
    pollIntervalMs: integer(env.MONAD_FUNDING_POLL_INTERVAL_MS || "5000", "INVALID_FUNDING_INDEXER_CONFIGURATION", 1000, 60000) };
}

function createFundingIndexerRuntime({ indexer, pollIntervalMs, clock = Date.now, reportError = () => {}, closeProvider = async () => {} }) {
  if (!indexer || typeof indexer.scanOnce !== "function" || typeof indexer.status !== "function" || typeof indexer.close !== "function" ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000 || typeof clock !== "function" ||
      typeof reportError !== "function" || typeof closeProvider !== "function") fail("INVALID_FUNDING_INDEXER_RUNTIME");
  let timer = null, active = null, stopping = false, lastAttemptAt = null, lastErrorCode = null, finalStatus = null;
  function execute() {
    if (stopping) return Promise.reject(Object.assign(new Error("FUNDING_INDEXER_STOPPING"), { code: "FUNDING_INDEXER_STOPPING" }));
    if (active) return active;
    const time = clock(); if (!Number.isSafeInteger(time) || time < 0) return Promise.reject(Object.assign(new Error("INVALID_INDEXER_CLOCK"), { code: "INVALID_INDEXER_CLOCK" }));
    lastAttemptAt = time;
    active = indexer.scanOnce().then(result => { lastErrorCode = null; return result; }, error => {
      lastErrorCode = typeof error?.code === "string" ? error.code : "INDEXER_FAILURE";
      reportError(lastErrorCode); throw error;
    }).finally(() => { active = null; });
    return active;
  }
  function start() {
    if (timer || stopping) fail("FUNDING_INDEXER_RUNTIME_STATE");
    timer = setInterval(() => void execute().catch(() => {}), pollIntervalMs); timer.unref();
    void execute().catch(() => {});
  }
  function status() { return finalStatus ? { ...finalStatus } : { ...indexer.status(), polling: Boolean(timer) && !stopping, pollIntervalMs, lastAttemptAt, runtimeErrorCode: lastErrorCode }; }
  async function close() {
    if (stopping) return; stopping = true; clearInterval(timer); timer = null;
    if (active) { try { await active; } catch (_) { /* The failed scan was already reported. */ } }
    finalStatus = { ...indexer.status(), polling: false, pollIntervalMs, lastAttemptAt, runtimeErrorCode: lastErrorCode };
    indexer.close(); await closeProvider();
  }
  return { start, scanOnce: execute, status, close };
}

module.exports = { readFundingIndexerConfig, createFundingIndexerRuntime };
