"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { Interface, getAddress, keccak256 } = require("ethers");
const { FUNDING_ABI, createFundingReceiptVerifier } = require("./funding-receipts");

const iface = new Interface(FUNDING_ABI);
const fundingTopics = iface.fragments.filter(fragment => fragment.type === "event").map(fragment => fragment.topicHash.toLowerCase());
const topicSet = new Set(fundingTopics);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) fail(code); }
function integer(value, code, minimum = 0) { check(Number.isSafeInteger(value) && value >= minimum, code); return value; }
function hash(value, code) { check(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value), code); return value.toLowerCase(); }
function address(value, code) {
  try { const result = getAddress(value).toLowerCase(); check(!/^0x0{40}$/.test(result), code); return result; }
  catch (_) { fail(code); }
}
function same(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function chainId(value) { check(typeof value === "string" && /^[1-9][0-9]*$/.test(value), "INVALID_INDEXER_CONFIGURATION"); return value; }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function exactEvents(a, b) { return canonicalJson(a) === canonicalJson(b); }
function eventFingerprint(events) { return crypto.createHash("sha256").update(canonicalJson(events), "utf8").digest("hex"); }

// Read-only chain adapter. It never signs, deploys or broadcasts transactions.
// FundingStore is committed before its checkpoint; duplicate replay repairs a
// crash between those writes without crediting an event twice.
function createFundingIndexer({ provider, chainId: chainValue, poolAddress, runtimeCodeHash, confirmations,
  startBlock, range = 256, maxLogs = 5000, file, fundingStore, resolveRegistration, clock = Date.now }) {
  const configuration = {
    chainId: chainId(chainValue), poolAddress: address(poolAddress, "INVALID_INDEXER_CONFIGURATION"),
    runtimeCodeHash: hash(runtimeCodeHash, "INVALID_INDEXER_CONFIGURATION"),
    confirmations: integer(confirmations, "INVALID_INDEXER_CONFIGURATION", 1),
    startBlock: integer(startBlock, "INVALID_INDEXER_CONFIGURATION", 1)
  };
  integer(range, "INVALID_INDEXER_CONFIGURATION", 1); check(range <= 2048, "INVALID_INDEXER_CONFIGURATION");
  integer(maxLogs, "INVALID_INDEXER_CONFIGURATION", 1); check(maxLogs <= 5000, "INVALID_INDEXER_CONFIGURATION");
  check(provider && ["getNetwork", "getBlock", "getLogs", "getTransactionReceipt", "getTransaction", "getCode"]
    .every(name => typeof provider[name] === "function"), "INVALID_INDEXER_PROVIDER");
  check(fundingStore && typeof fundingStore.readWithEvents === "function" && typeof fundingStore.append === "function" &&
    typeof fundingStore.replaceFromBlock === "function", "INVALID_FUNDING_STORE");
  check(typeof resolveRegistration === "function", "REGISTRATION_RESOLVER_REQUIRED");
  check(typeof clock === "function" && typeof file === "string" && file && file !== ":memory:", "INVALID_INDEXER_CONFIGURATION");

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let newFile = false;
  try { const fd = fs.openSync(file, "wx", 0o600); fs.closeSync(fd); newFile = true; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = fs.lstatSync(file);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "UNSAFE_INDEXER_FILE");
  try { fs.chmodSync(file, 0o600); } catch (error) { if (process.platform !== "win32") throw error; }
  const lockFile = `${file}.lock`, lockToken = crypto.randomBytes(32).toString("hex");
  const lockValue = JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: Date.now(), token: lockToken }); let lockHandle = null;
  function processExists(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  }
  function verifiedLock(value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && parsed.schemaVersion === 1 && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 &&
        Number.isSafeInteger(parsed.startedAt) && parsed.startedAt >= 0 && typeof parsed.token === "string" && /^[0-9a-f]{64}$/.test(parsed.token) &&
        Object.keys(parsed).length === 4 ? parsed : null;
    } catch (_) { return null; }
  }
  function releaseInstanceLock() {
    if (lockHandle === null) return;
    fs.closeSync(lockHandle); lockHandle = null;
    let saved;
    try { saved = fs.readFileSync(lockFile, "utf8"); } catch (_) { fail("INDEXER_LOCK_CHANGED"); }
    check(saved === lockValue, "INDEXER_LOCK_CHANGED"); fs.unlinkSync(lockFile);
  }
  try {
    for (let attempt = 0; attempt < 3 && lockHandle === null; attempt++) {
      try {
        lockHandle = fs.openSync(lockFile, "wx", 0o600); fs.writeFileSync(lockHandle, lockValue, "utf8");
        try { fs.chmodSync(lockFile, 0o600); } catch (error) { if (process.platform !== "win32") throw error; }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const item = fs.lstatSync(lockFile);
        check(item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && item.size <= 1000, "INDEXER_LOCK_UNVERIFIED");
        const previous = verifiedLock(fs.readFileSync(lockFile, "utf8")); check(previous, "INDEXER_LOCK_UNVERIFIED");
        if (processExists(previous.pid)) fail("INDEXER_ALREADY_RUNNING_OR_UNCLEAN_SHUTDOWN");
        const stale = `${lockFile}.stale-${previous.startedAt}-${previous.token.slice(0, 12)}`;
        check(path.dirname(path.resolve(stale)) === path.dirname(path.resolve(lockFile)) && !fs.existsSync(stale), "INDEXER_LOCK_UNVERIFIED");
        try { fs.renameSync(lockFile, stale); } catch (renameError) { if (renameError.code !== "ENOENT") throw renameError; }
      }
    }
    check(lockHandle !== null, "INDEXER_ALREADY_RUNNING_OR_UNCLEAN_SHUTDOWN");
  } catch (error) {
    if (lockHandle !== null) { try { releaseInstanceLock(); } catch (_) { /* Preserve the acquisition failure. */ } }
    throw error;
  }
  let db;
  try { db = new DatabaseSync(file); } catch (error) { releaseInstanceLock(); throw error; }
  let closed = false, active = null;
  let runState = "IDLE", confirmedBlock = null, lastErrorCode = null;
  const configJson = JSON.stringify(configuration);

  function transaction(work, write = true) {
    check(!closed, "INDEXER_CLOSED"); db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch (_) { /* Preserve the original failure. */ } throw error; }
  }
  function meta() { return db.prepare("SELECT * FROM funding_indexer_meta WHERE id=1").get(); }
  function checkpoint(number) { return db.prepare("SELECT * FROM funding_indexer_blocks WHERE block_number=?").get(number); }
  function validateStorage() {
    const value = meta(); check(value && value.schema_version === 1 && value.config_json === configJson, "INDEXER_CONFIG_MISMATCH");
    check(Number.isSafeInteger(value.through_block) && value.through_block >= configuration.startBlock - 1, "INDEXER_CHECKPOINT_CORRUPT");
    const rows = db.prepare("SELECT * FROM funding_indexer_blocks ORDER BY block_number").all();
    const expectedCount = value.through_block < configuration.startBlock ? 0 : value.through_block - configuration.startBlock + 1;
    check(rows.length === expectedCount, "INDEXER_CHECKPOINT_CORRUPT");
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], number = configuration.startBlock + index;
      check(row.block_number === number, "INDEXER_CHECKPOINT_CORRUPT");
      hash(row.block_hash, "INDEXER_CHECKPOINT_CORRUPT"); hash(row.parent_hash, "INDEXER_CHECKPOINT_CORRUPT");
      check(Number.isSafeInteger(row.event_count) && row.event_count >= 0 && typeof row.event_hash === "string" && /^[0-9a-f]{64}$/.test(row.event_hash), "INDEXER_CHECKPOINT_CORRUPT");
      if (index) check(rows[index - 1].block_hash === row.parent_hash, "INDEXER_CHECKPOINT_CORRUPT");
    }
    check(value.last_success_at === null || Number.isSafeInteger(value.last_success_at) && value.last_success_at >= 0, "INDEXER_CHECKPOINT_CORRUPT");
    return value;
  }
  function writeCheckpoint(fromBlock, blocks, events) {
    transaction(() => {
      db.prepare("DELETE FROM funding_indexer_blocks WHERE block_number>=?").run(fromBlock);
      const insert = db.prepare("INSERT INTO funding_indexer_blocks(block_number,block_hash,parent_hash,event_count,event_hash) VALUES(?,?,?,?,?)");
      for (const block of blocks) {
        const blockEvents = events.filter(event => event.blockNumber === block.number);
        insert.run(block.number, block.hash, block.parentHash, blockEvents.length, eventFingerprint(blockEvents));
      }
      const time = clock(); check(Number.isSafeInteger(time) && time >= 0, "INVALID_INDEXER_CLOCK");
      const through = blocks.length ? blocks[blocks.length - 1].number : fromBlock - 1;
      db.prepare("UPDATE funding_indexer_meta SET through_block=?,last_success_at=? WHERE id=1").run(through, time);
      validateStorage();
    });
  }

  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const schemaExists = objects.some(item => item.type === "table" && item.name === "funding_indexer_meta");
    if (!schemaExists) {
      check(newFile || objects.length === 0, "INDEXER_SCHEMA_MISMATCH");
      check(fundingStore.readWithEvents().canonicalEvents.length === 0, "INDEXER_CHECKPOINT_REQUIRED");
      db.exec(`CREATE TABLE funding_indexer_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,
        config_json TEXT NOT NULL,through_block INTEGER NOT NULL,last_success_at INTEGER) STRICT;
        CREATE TABLE funding_indexer_blocks(block_number INTEGER PRIMARY KEY,block_hash TEXT NOT NULL,parent_hash TEXT NOT NULL,
          event_count INTEGER NOT NULL,event_hash TEXT NOT NULL) STRICT;`);
      db.prepare("INSERT INTO funding_indexer_meta VALUES(1,1,?,?,NULL)").run(configJson, configuration.startBlock - 1);
    }
    validateStorage();
  } catch (error) { db.close(); closed = true; releaseInstanceLock(); throw error; }

  const verifier = createFundingReceiptVerifier({ provider, chainId: configuration.chainId,
    poolAddress: configuration.poolAddress, runtimeCodeHash: configuration.runtimeCodeHash,
    confirmations: configuration.confirmations, resolveRegistration });

  async function network() {
    const value = await provider.getNetwork();
    check(value && value.chainId === BigInt(configuration.chainId), "CHAIN_MISMATCH");
  }
  async function blockAt(number) {
    const value = await provider.getBlock(number); check(value, "BLOCK_UNAVAILABLE");
    check(integer(value.number, "INVALID_BLOCK") === number, "INVALID_BLOCK");
    return { number, hash: hash(value.hash, "INVALID_BLOCK"), parentHash: hash(value.parentHash, "INVALID_BLOCK"),
      transactions: Array.isArray(value.transactions) ? value.transactions : [] };
  }
  async function checkedBlocks(fromBlock, toBlock) {
    const blocks = [];
    for (let number = fromBlock; number <= toBlock; number++) {
      const block = await blockAt(number);
      if (blocks.length) check(block.parentHash === blocks[blocks.length - 1].hash, "NONCONTIGUOUS_CHAIN");
      blocks.push(block);
    }
    return blocks;
  }
  async function assertRuntime(blockNumber) {
    const code = await provider.getCode(configuration.poolAddress, blockNumber);
    check(typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code) && same(keccak256(code), configuration.runtimeCodeHash), "RUNTIME_CODE_MISMATCH");
  }
  async function scanRange(fromBlock, toBlock) {
    const before = await checkedBlocks(fromBlock, toBlock);
    const previous = fromBlock > configuration.startBlock ? checkpoint(fromBlock - 1) : null;
    if (previous) check(before[0].parentHash === previous.block_hash, "RANGE_PARENT_MISMATCH");
    await assertRuntime(toBlock);
    const logs = await provider.getLogs({ address: configuration.poolAddress, fromBlock, toBlock, topics: [fundingTopics] });
    check(Array.isArray(logs) && logs.length <= maxLogs, "INDEXER_LOG_LIMIT");
    const byNumber = new Map(before.map(block => [block.number, block]));
    const candidates = logs.map(log => {
      check(log && address(log.address, "INVALID_INDEXER_LOG") === configuration.poolAddress && Array.isArray(log.topics) &&
        log.topics.length && topicSet.has(String(log.topics[0]).toLowerCase()), "INVALID_INDEXER_LOG");
      const blockNumber = integer(log.blockNumber, "INVALID_INDEXER_LOG"), block = byNumber.get(blockNumber);
      check(block && same(log.blockHash, block.hash) && log.removed !== true, "INDEXER_LOG_REORGED");
      return { txHash: hash(log.transactionHash, "INVALID_INDEXER_LOG"), blockNumber,
        transactionIndex: integer(log.transactionIndex, "INVALID_INDEXER_LOG"), logIndex: integer(log.index, "INVALID_INDEXER_LOG") };
    }).sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
    const hashes = [...new Set(candidates.map(item => item.txHash))], events = [];
    for (const txHash of hashes) {
      const result = await verifier.verify(txHash), block = byNumber.get(result.blockNumber);
      check(block && result.blockHash === block.hash, "VERIFIED_TRANSACTION_OUTSIDE_RANGE");
      events.push(...result.events);
    }
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
    const after = await checkedBlocks(fromBlock, toBlock);
    check(before.every((block, index) => block.hash === after[index].hash && block.parentHash === after[index].parentHash), "RANGE_REORGED");
    await network();
    const head = await provider.getBlock("latest");
    check(head && integer(head.number, "INVALID_BLOCK") >= toBlock + configuration.confirmations - 1, "CONFIRMATIONS_PENDING");
    return { blocks: after.map(({ transactions, ...block }) => block), events };
  }
  async function commonAncestor(through, confirmed) {
    for (let number = Math.min(through, confirmed); number >= configuration.startBlock; number--) {
      const saved = checkpoint(number); check(saved, "INDEXER_CHECKPOINT_CORRUPT");
      const current = await blockAt(number);
      if (current.hash === saved.block_hash) return number;
    }
    return configuration.startBlock - 1;
  }
  function validateProjectionThrough(projection, through) {
    const grouped = new Map();
    for (const event of projection.canonicalEvents) {
      check(event.blockNumber >= configuration.startBlock, "FUNDING_CHECKPOINT_MISMATCH");
      if (event.blockNumber > through) continue;
      const row = checkpoint(event.blockNumber);
      check(row && event.blockHash === row.block_hash, "FUNDING_CHECKPOINT_MISMATCH");
      if (!grouped.has(event.blockNumber)) grouped.set(event.blockNumber, []);
      grouped.get(event.blockNumber).push(event);
    }
    for (let number = configuration.startBlock; number <= through; number++) {
      const row = checkpoint(number), events = grouped.get(number) || [];
      check(row && row.event_count === events.length && row.event_hash === eventFingerprint(events), "FUNDING_CHECKPOINT_MISMATCH");
    }
  }
  function commitProjection(fromBlock, events, replacing) {
    const current = fundingStore.readWithEvents(), suffix = current.canonicalEvents.filter(event => event.blockNumber >= fromBlock);
    if (replacing) {
      if (exactEvents(suffix, events)) return { replayed: true, storeVersion: current.storeVersion };
      if (!suffix.length && !events.length) return { replayed: true, storeVersion: current.storeVersion };
      return fundingStore.replaceFromBlock({ fromBlock, events, expectedVersion: current.storeVersion,
        reason: "Canonical funding indexer block reconciliation" });
    }
    return fundingStore.append(events, { expectedVersion: current.storeVersion });
  }
  async function synchronize() {
    runState = "SYNCING"; lastErrorCode = null;
    try {
      await network();
      const latest = await provider.getBlock("latest"); check(latest, "BLOCK_UNAVAILABLE");
      const latestNumber = integer(latest.number, "INVALID_BLOCK");
      confirmedBlock = latestNumber - configuration.confirmations + 1;
      const stored = validateStorage(), through = stored.through_block;
      if (confirmedBlock >= configuration.startBlock) await assertRuntime(confirmedBlock);
      let ancestor = through;
      if (through >= configuration.startBlock) {
        if (through > confirmedBlock) ancestor = await commonAncestor(through, confirmedBlock);
        else {
          const current = await blockAt(through);
          if (current.hash !== checkpoint(through).block_hash) ancestor = await commonAncestor(through, confirmedBlock);
        }
      }
      const projection = fundingStore.readWithEvents();
      validateProjectionThrough(projection, ancestor);
      let next = ancestor + 1, replacing = ancestor !== through || projection.canonicalEvents.some(event => event.blockNumber > ancestor);
      if (replacing && next > confirmedBlock) {
        commitProjection(next, [], true); writeCheckpoint(next, [], []);
      }
      while (next <= confirmedBlock) {
        const end = Math.min(confirmedBlock, next + range - 1), scanned = await scanRange(next, end);
        commitProjection(next, scanned.events, replacing); writeCheckpoint(next, scanned.blocks, scanned.events);
        replacing = false; next = end + 1;
      }
      runState = "IDLE";
      return status();
    } catch (error) {
      runState = "ERROR"; lastErrorCode = typeof error?.code === "string" ? error.code : "INDEXER_FAILURE";
      throw error;
    }
  }
  function scanOnce() {
    check(!closed, "INDEXER_CLOSED");
    if (!active) active = synchronize().finally(() => { active = null; });
    return active;
  }
  function status() {
    check(!closed, "INDEXER_CLOSED"); const value = validateStorage();
    return { state: runState, chainId: configuration.chainId, poolAddress: configuration.poolAddress,
      runtimeCodeHash: configuration.runtimeCodeHash, startBlock: configuration.startBlock,
      confirmations: configuration.confirmations, throughBlock: value.through_block < configuration.startBlock ? null : value.through_block,
      confirmedBlock, lastSuccessAt: value.last_success_at, errorCode: lastErrorCode };
  }
  function close() { check(!active, "INDEXER_BUSY"); if (!closed) { db.close(); closed = true; releaseInstanceLock(); } }
  return { scanOnce, status, close };
}

module.exports = { createFundingIndexer };
