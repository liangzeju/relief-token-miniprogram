"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createFundingDomain } = require("./funding-domain");

function fail(code) { throw Object.assign(new Error(code), { code }); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fail("EXPECTED_VERSION_REQUIRED"); }
function eventsInput(events) { if (!Array.isArray(events) || events.length > 5000) fail("INVALID_EVENT_BATCH"); }

// Private projection store, not a chain verifier. Append/replaceFromBlock must be
// called only after the indexer has verified canonical chain facts and registration.
function createFundingStore({ file, chainId, poolAddress, clock = Date.now }) {
  if (typeof file !== "string" || !file || file === ":memory:") fail("PERSISTENT_FILE_REQUIRED");
  const options = { chainId, poolAddress };
  const initial = createFundingDomain(undefined, options).snapshot();
  const config = JSON.stringify({ chainId: initial.chainId, poolAddress: initial.poolAddress });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("UNSAFE_STORE_FILE"); }
  const db = new DatabaseSync(file); let closed = false;
  function transaction(work, write = true) {
    if (closed) fail("STORE_CLOSED");
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch (_) { /* Preserve the original failure. */ } throw error; }
  }
  try {
    try { fs.chmodSync(file, 0o600); } catch (error) { if (process.platform !== "win32") throw error; }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    db.exec(`CREATE TABLE IF NOT EXISTS funding_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,config_json TEXT NOT NULL,revision INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS funding_events(id INTEGER PRIMARY KEY,block_number INTEGER NOT NULL,tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,event_json TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1))) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS funding_canonical_event ON funding_events(tx_hash,log_index) WHERE canonical=1;
      CREATE TABLE IF NOT EXISTS funding_revisions(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,from_block INTEGER,previous_revision INTEGER NOT NULL,event_count INTEGER NOT NULL,reason TEXT,committed_at INTEGER NOT NULL) STRICT;`);
    transaction(() => {
      const meta = db.prepare("SELECT * FROM funding_meta WHERE id=1").get();
      if (!meta) db.prepare("INSERT INTO funding_meta VALUES(1,1,?,0)").run(config);
      else if (meta.schema_version !== 1) fail("FUNDING_SCHEMA_UNSUPPORTED");
      else if (meta.config_json !== config) fail("FUNDING_CONFIG_MISMATCH");
      hydrate();
    });
  } catch (error) { db.close(); closed = true; throw error; }
  function hydrate() {
    const rows = db.prepare("SELECT event_json FROM funding_events WHERE canonical=1 ORDER BY block_number,log_index,id").all();
    return createFundingDomain({ schemaVersion: 1, events: rows.map(row => JSON.parse(row.event_json)) }, options);
  }
  function version() { return db.prepare("SELECT revision FROM funding_meta WHERE id=1").get().revision; }
  function writeEvents(events) {
    const insert = db.prepare("INSERT INTO funding_events(block_number,tx_hash,log_index,event_json,canonical) VALUES(?,?,?,?,1)");
    for (const event of events) insert.run(event.blockNumber, event.txHash, event.logIndex, JSON.stringify(event));
  }
  function commitRevision(kind, previous, count, fromBlock = null, reason = null) {
    const time = clock(); if (!Number.isSafeInteger(time) || time < 0) fail("INVALID_CLOCK");
    const next = previous + 1; revision(next);
    db.prepare("INSERT INTO funding_revisions VALUES(?,?,?,?,?,?,?)").run(next, kind, fromBlock, previous, count, reason, time);
    db.prepare("UPDATE funding_meta SET revision=? WHERE id=1").run(next);
    return next;
  }
  function append(events, { expectedVersion }) {
    eventsInput(events); revision(expectedVersion);
    return transaction(() => {
      const current = version(), domain = hydrate(), before = domain.snapshot().version;
      for (const event of events) domain.apply(event);
      const additions = domain.exportState().events.slice(before);
      if (!additions.length) return { storeVersion: current, eventCount: before, replayed: true };
      if (current !== expectedVersion) fail("VERSION_CONFLICT");
      writeEvents(additions);
      return { storeVersion: commitRevision("APPEND", current, additions.length), eventCount: before + additions.length, replayed: false };
    });
  }
  function replaceFromBlock({ fromBlock, events, expectedVersion, reason }) {
    revision(expectedVersion); eventsInput(events);
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) fail("INVALID_REWIND_BLOCK");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 400) fail("REWIND_REASON_REQUIRED");
    return transaction(() => {
      const current = version(); if (current !== expectedVersion) fail("VERSION_CONFLICT");
      const previous = hydrate().exportState().events;
      const prefix = previous.filter(event => event.blockNumber < fromBlock);
      if (prefix.length === previous.length && events.length === 0) fail("EMPTY_REWIND");
      const domain = createFundingDomain({ schemaVersion: 1, events: prefix }, options);
      for (const event of events) { if (event.blockNumber < fromBlock) fail("EVENT_BEFORE_REWIND"); domain.apply(event); }
      const replacements = domain.exportState().events.slice(prefix.length);
      db.prepare("UPDATE funding_events SET canonical=0 WHERE canonical=1 AND block_number>=?").run(fromBlock);
      writeEvents(replacements);
      return { storeVersion: commitRevision("REORG", current, replacements.length, fromBlock, reason), eventCount: prefix.length + replacements.length, orphanedCount: previous.length - prefix.length };
    });
  }
  return {
    append, replaceFromBlock,
    read() { return transaction(() => ({ ...hydrate().snapshot(), storeVersion: version() }), false); },
    readWithEvents() { return transaction(() => {
      const domain = hydrate();
      const orphanedDonations = db.prepare("SELECT event_json FROM funding_events WHERE canonical=0 ORDER BY id").all()
        .map(row => JSON.parse(row.event_json)).filter(event => event.type === "DonationReceived")
        .map(event => createFundingDomain({ schemaVersion: 1, events: [event] }, options).snapshot().donations[0]);
      return { ...domain.snapshot(), canonicalEvents: domain.exportState().events, orphanedDonations, storeVersion: version() };
    }, false); },
    previewPayment(contractId, amountWei) { return transaction(() => ({ ...hydrate().previewPayment(contractId, amountWei), storeVersion: version() }), false); },
    audit() { return transaction(() => ({ revisions: db.prepare("SELECT * FROM funding_revisions ORDER BY id").all(), orphanedCount: db.prepare("SELECT count(*) AS n FROM funding_events WHERE canonical=0").get().n }), false); },
    close() { if (!closed) { db.close(); closed = true; } }
  };
}

module.exports = { createFundingStore };
