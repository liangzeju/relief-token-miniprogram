"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Interface, id, keccak256 } = require("ethers");
const { FUNDING_ABI } = require("../funding-receipts");
const { createFundingIndexer } = require("../funding-indexer");
const { createFundingStore } = require("../funding-store");

const iface = new Interface(FUNDING_ABI);
const pool = "0x" + "2b".repeat(20), operator = "0x" + "4d".repeat(20), code = "0x60006000";
const chainId = "10143", taskId = id("medical-task"), projectId = id("project-a");

class MockChain {
  constructor() {
    this.branch = 0; this.head = 5; this.logRanges = []; this.onLogs = null;
    this.transactions = new Map(); this.receipts = new Map(); this.branches = [];
    this.branches[0] = this.makeBranch(0, true); this.branches[1] = this.makeBranch(1, false);
  }
  blockHash(branch, number) { return id(number <= 2 ? `common-block-${number}` : `branch-${branch}-block-${number}`); }
  makeBranch(branch, paused) {
    const blocks = new Map(), logs = [];
    for (let number = 0; number <= 8; number++) blocks.set(number, { number, hash: this.blockHash(branch, number),
      parentHash: this.blockHash(branch, number - 1), transactions: [] });
    if (branch === 0) {
      this.addTransaction(blocks, logs, { label: "register", blockNumber: 2,
        data: iface.encodeFunctionData("registerTask", [taskId, 2, projectId, 3, 100n]),
        events: [["TaskRegistered", [taskId, 2, projectId, 3, 100n]], ["TaskActivityChanged", [taskId, true]]] });
    } else {
      const shared = this.branches?.[0];
      if (shared) {
        blocks.get(2).transactions = [...shared.blocks.get(2).transactions];
        logs.push(...shared.logs.filter(log => log.blockNumber === 2));
      }
    }
    if (paused) this.addTransaction(blocks, logs, { label: "pause", blockNumber: 3,
      data: iface.encodeFunctionData("setTaskActive", [taskId, false]), events: [["TaskActivityChanged", [taskId, false]]] });
    return { blocks, logs };
  }
  addTransaction(blocks, logs, { label, blockNumber, data, events }) {
    const txHash = id(`tx-${label}`), block = blocks.get(blockNumber), transactionIndex = block.transactions.length;
    block.transactions.push(txHash);
    const receiptLogs = events.map(([name, args], index) => ({ ...iface.encodeEventLog(iface.getEvent(name), args),
      address: pool, index, transactionIndex, removed: false, blockNumber, blockHash: block.hash, transactionHash: txHash }));
    logs.push(...receiptLogs);
    this.transactions.set(txHash, { hash: txHash, blockHash: block.hash, blockNumber, from: operator, to: pool,
      chainId: BigInt(chainId), value: 0n, data });
    this.receipts.set(txHash, { hash: txHash, blockHash: block.hash, blockNumber, index: transactionIndex,
      from: operator, to: pool, status: 1, logs: receiptLogs });
  }
  async getNetwork() { return { chainId: BigInt(chainId) }; }
  async getBlock(tag) { return structuredClone(this.branches[this.branch].blocks.get(tag === "latest" ? this.head : Number(tag)) || null); }
  async getCode(target) { assert.equal(target.toLowerCase(), pool.toLowerCase()); return code; }
  async getLogs(filter) {
    const from = Number(filter.fromBlock), to = Number(filter.toBlock); this.logRanges.push([from, to]);
    const selected = structuredClone(this.branches[this.branch].logs.filter(log => log.blockNumber >= from && log.blockNumber <= to));
    return this.onLogs ? this.onLogs(filter, selected) : selected;
  }
  async getTransactionReceipt(txHash) { return structuredClone(this.receipts.get(txHash) || null); }
  async getTransaction(txHash) { return structuredClone(this.transactions.get(txHash) || null); }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-funding-indexer-")), opened = [];
  const fundingStore = createFundingStore({ file: path.join(directory, "funding.sqlite"), chainId, poolAddress: pool });
  const chain = new MockChain(), indexerFile = path.join(directory, "indexer.sqlite");
  function open(overrides = {}) {
    const indexer = createFundingIndexer({ provider: chain, chainId, poolAddress: pool, runtimeCodeHash: keccak256(code),
      confirmations: 2, startBlock: 1, range: 2, maxLogs: 50, file: indexerFile, fundingStore,
      resolveRegistration: async () => null, ...overrides });
    opened.push(indexer); return indexer;
  }
  t.after(() => {
    for (const indexer of opened) { try { indexer.close(); } catch (_) { /* Already closed or test-injected busy state. */ } }
    fundingStore.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("relief-funding-indexer-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, indexerFile, fundingStore, chain, open };
}

test("confirmed ranges are scanned without gaps and task activity survives restart", async t => {
  const f = fixture(t), indexer = f.open();
  assert.throws(() => f.open(), { code: "INDEXER_ALREADY_RUNNING_OR_UNCLEAN_SHUTDOWN" });
  const status = await indexer.scanOnce();
  assert.equal(status.throughBlock, 4); assert.equal(status.confirmedBlock, 4); assert.equal(status.state, "IDLE");
  assert.deepEqual(f.chain.logRanges, [[1, 2], [3, 4]]);
  const state = f.fundingStore.read();
  assert.equal(state.tasks[0].id, taskId); assert.equal(state.tasks[0].status, "PAUSED"); assert.equal(state.version, 2);
  indexer.close();
  const reopened = f.open(); assert.equal(reopened.status().throughBlock, 4);
  await reopened.scanOnce(); assert.equal(f.fundingStore.read().version, 2); assert.equal(f.fundingStore.audit().revisions.length, 2);
});

test("a confirmed reorg rolls back to the common ancestor and replays the canonical branch", async t => {
  const f = fixture(t), indexer = f.open(); await indexer.scanOnce();
  f.chain.branch = 1; f.chain.logRanges.length = 0;
  const status = await indexer.scanOnce(), state = f.fundingStore.read();
  assert.equal(status.throughBlock, 4); assert.deepEqual(f.chain.logRanges, [[3, 4]]);
  assert.equal(state.tasks[0].status, "OPEN"); assert.equal(state.version, 1);
  assert.equal(f.fundingStore.audit().orphanedCount, 1);
  const revisions = f.fundingStore.audit().revisions.length;
  await indexer.scanOnce(); assert.equal(f.fundingStore.audit().revisions.length, revisions);
});

test("a crash after projection commit is repaired by exact replay before checkpoint advance", async t => {
  const f = fixture(t), real = f.fundingStore; let injected = false;
  const crashingStore = { readWithEvents: () => real.readWithEvents(), replaceFromBlock: value => real.replaceFromBlock(value),
    append(events, options) { const result = real.append(events, options); if (!injected) { injected = true; throw Object.assign(new Error("test crash"), { code: "TEST_CRASH" }); } return result; } };
  const indexer = f.open({ range: 4, fundingStore: crashingStore });
  await assert.rejects(indexer.scanOnce(), { code: "TEST_CRASH" });
  assert.equal(indexer.status().throughBlock, null); assert.equal(real.read().version, 2);
  indexer.close();
  const recovered = f.open({ range: 4 }); await recovered.scanOnce();
  assert.equal(recovered.status().throughBlock, 4); assert.equal(real.read().version, 2);
  assert.equal(real.audit().revisions.length, 1, "recovery must not manufacture a second funding revision");
});

test("a new checkpoint database refuses to adopt an existing funding journal", t => {
  const f = fixture(t);
  f.fundingStore.append([{ type: "TaskRegistered", chainId, poolAddress: pool, txHash: id("manual-tx"),
    blockHash: f.chain.blockHash(0, 2), blockNumber: 2, transactionIndex: 0, logIndex: 0,
    data: { taskId, purpose: 2, projectId } }], { expectedVersion: 0 });
  assert.throws(() => f.open(), { code: "INDEXER_CHECKPOINT_REQUIRED" });
  assert.throws(() => f.open(), { code: "INDEXER_CHECKPOINT_REQUIRED" });
});

test("chain movement during a range leaves both projection and checkpoint untouched", async t => {
  const f = fixture(t), indexer = f.open({ range: 4 });
  f.chain.onLogs = (_filter, logs) => { f.chain.branch = 1; f.chain.onLogs = null; return logs; };
  await assert.rejects(indexer.scanOnce());
  assert.equal(indexer.status().throughBlock, null); assert.equal(f.fundingStore.read().version, 0);
  await indexer.scanOnce();
  assert.equal(indexer.status().throughBlock, 4); assert.equal(f.fundingStore.read().tasks[0].status, "OPEN");
});

test("an unknown pool event in a relevant receipt halts the complete range", async t => {
  const f = fixture(t), receipt = f.chain.receipts.get(id("tx-pause"));
  receipt.logs.push({ address: pool, topics: [id("UnreviewedPoolEvent(uint256)")], data: "0x" + "00".repeat(32),
    index: 1, transactionIndex: 0, removed: false, blockNumber: 3, blockHash: f.chain.blockHash(0, 3), transactionHash: receipt.hash });
  const indexer = f.open({ range: 4 });
  await assert.rejects(indexer.scanOnce(), { code: "UNKNOWN_POOL_EVENT" });
  assert.equal(indexer.status().throughBlock, null); assert.equal(f.fundingStore.read().version, 0);
});

test("confirmation depth gates scanning and checkpoint fingerprints detect projection loss", async t => {
  const f = fixture(t); f.chain.head = 1;
  const indexer = f.open(); await indexer.scanOnce();
  assert.equal(indexer.status().throughBlock, null); assert.equal(f.fundingStore.read().version, 0);
  f.chain.head = 5; await indexer.scanOnce(); assert.equal(indexer.status().throughBlock, 4);
  const raw = new DatabaseSync(path.join(f.directory, "funding.sqlite"));
  try { raw.exec("UPDATE funding_events SET canonical=0 WHERE block_number=3"); } finally { raw.close(); }
  await assert.rejects(indexer.scanOnce(), { code: "FUNDING_CHECKPOINT_MISMATCH" });
  assert.equal(indexer.status().throughBlock, 4);
});

test("a verifiable dead-process lock is preserved as stale evidence, while an unverifiable lock blocks startup", t => {
  const f = fixture(t), first = f.open(); first.close();
  const dead = JSON.stringify({ schemaVersion: 1, pid: 2147483647, startedAt: 1234, token: "ab".repeat(32) });
  fs.writeFileSync(f.indexerFile + ".lock", dead, { mode: 0o600 });
  const recovered = f.open(); recovered.close();
  assert.equal(fs.existsSync(f.indexerFile + ".lock.stale-1234-" + "ab".repeat(6)), true);
  fs.writeFileSync(f.indexerFile + ".lock", "untrusted", { mode: 0o600 });
  assert.throws(() => f.open(), { code: "INDEXER_LOCK_UNVERIFIED" });
});
