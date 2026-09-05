"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createFundingStore } = require("../funding-store");
const address = n => "0x" + n.toString(16).padStart(40, "0"), hash = n => "0x" + n.toString(16).padStart(64, "0");
const config = { chainId: "10143", poolAddress: address(9) };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-fifo-store-"));
  const file = path.join(directory, "funding.sqlite"), opened = [];
  const open = (options = {}) => { const store = createFundingStore({ file, ...config, ...options }); opened.push(store); return store; };
  t.after(() => { for (const store of opened) store.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-fifo-store-")); fs.rmSync(directory, { recursive: true, force: true }); });
  return { file, open };
}
function events() {
  const payloads = [
    ["DonationReceived", { donationId: "first", donorUserId: "u1", donorWallet: address(1), amountWei: "100", gasReservedWei: "0", purpose: 1, projectId: null }],
    ["DonationReceived", { donationId: "second", donorUserId: "u2", donorWallet: address(2), amountWei: "100", gasReservedWei: "0", purpose: 1, projectId: null }],
    ["TaskRegistered", { taskId: "task", purpose: 1, projectId: "project" }],
    ["DonationAllocated", { donationId: "second", taskId: "task", amountWei: "100" }],
    ["DonationAllocated", { donationId: "first", taskId: "task", amountWei: "100" }],
    ["ContractLocked", { contractId: "contract", taskId: "task", recipient: address(3), amountWei: "200" }],
    ["BatchPaid", { paymentId: "payment", contractId: "contract", batchId: "batch", recipient: address(3), amountWei: "120" }]
  ];
  return payloads.map(([type, data], i) => ({ type, data, ...config, txHash: hash(100 + i), blockHash: hash(1000 + i), blockNumber: i + 1, transactionIndex: 0, logIndex: 0 }));
}
test("SQLite persists FIFO sources and payment preview across restart without converting wei to Number", t => {
  const f = fixture(t), store = f.open(); store.append(events().slice(0, 6), { expectedVersion: 0 });
  assert.deepEqual(store.previewPayment("contract", "120").sources, [{ donationId: "first", amountWei: "100" }, { donationId: "second", amountWei: "20" }]);
  store.append(events().slice(6), { expectedVersion: 1 }); const before = store.read(); store.close();
  assert.deepEqual(f.open().read(), before); assert.equal(before.storeVersion, 2); assert.equal(before.totals.spentWei, "120");
});

test("readWithEvents returns one canonical projection revision and independent event copies", t => {
  const f = fixture(t), store = f.open(); store.append(events(), { expectedVersion: 0 });
  const result = store.readWithEvents(), { canonicalEvents, orphanedDonations, ...snapshot } = result;
  assert.deepEqual(orphanedDonations, []);
  assert.deepEqual(snapshot, store.read()); assert.deepEqual(canonicalEvents, events());
  canonicalEvents[0].data.donorUserId = "not-the-original-user";
  assert.equal(store.readWithEvents().canonicalEvents[0].data.donorUserId, "u1");
  store.replaceFromBlock({ fromBlock: 7, events: [], expectedVersion: 1, reason: "Verified rollback test" });
  const next = store.readWithEvents(); assert.equal(next.storeVersion, 2);
  assert.equal(next.canonicalEvents.length, 6); assert.deepEqual(next.payments, []);
});
test("duplicate delivery is idempotent even after another connection advances the version", t => {
  const f = fixture(t), a = f.open(), b = f.open(); a.append(events(), { expectedVersion: 0 });
  assert.equal(b.append(events(), { expectedVersion: 0 }).replayed, true); assert.equal(b.audit().revisions.length, 1);
  const modified = events(); modified[0].data.amountWei = "101";
  assert.throws(() => b.append(modified, { expectedVersion: 1 }), error => error.code === "EVENT_CONFLICT"); assert.equal(a.read().totals.amountWei, "200");
});
test("stale workers cannot append new payments based on a previous projection revision", t => {
  const f = fixture(t), a = f.open(), b = f.open(); a.append(events().slice(0, 6), { expectedVersion: 0 });
  assert.throws(() => b.append(events().slice(6), { expectedVersion: 0 }), error => error.code === "VERSION_CONFLICT");
  assert.equal(b.read().payments.length, 0); b.append(events().slice(6), { expectedVersion: 1 });
});
test("one invalid event rolls back the complete append batch", t => {
  const f = fixture(t), store = f.open(), batch = events(); batch[6].data.amountWei = "201";
  assert.throws(() => store.append(batch, { expectedVersion: 0 }), error => error.code === "INSUFFICIENT_ELIGIBLE_FUNDS");
  assert.equal(store.read().version, 0); assert.equal(store.read().storeVersion, 0); assert.equal(store.audit().revisions.length, 0);
});
test("SQLite event and audit write failures roll back balances and allow exact retry", t => {
  const f = fixture(t), store = f.open(); const raw = new DatabaseSync(f.file);
  try {
    raw.exec("CREATE TRIGGER break_audit BEFORE INSERT ON funding_revisions BEGIN SELECT RAISE(ABORT,'disk failure injection'); END;");
    assert.throws(() => store.append(events(), { expectedVersion: 0 })); assert.equal(store.read().totals.amountWei, "0");
    raw.exec("DROP TRIGGER break_audit"); store.append(events(), { expectedVersion: 0 }); assert.equal(store.read().totals.spentWei, "120");
  } finally { raw.close(); }
});
test("verified reorg replacement removes orphan contribution but preserves its audit history", t => {
  const f = fixture(t), store = f.open(); store.append(events(), { expectedVersion: 0 });
  const replacement = { ...events()[6], txHash: hash(500), blockHash: hash(600), data: { ...events()[6].data, amountWei: "30", paymentId: "replacement" } };
  const result = store.replaceFromBlock({ fromBlock: 7, events: [replacement], expectedVersion: 1, reason: "Verified block hash change" });
  assert.equal(result.orphanedCount, 1); assert.equal(store.read().totals.spentWei, "30");
  assert.deepEqual(store.read().payments[0].sources, [{ donationId: "first", amountWei: "30" }]);
  assert.equal(store.audit().orphanedCount, 1); assert.equal(store.audit().revisions[1].kind, "REORG");
  store.close(); assert.equal(f.open().read().totals.spentWei, "30");
});
test("bad reorg replacement cannot discard the previous canonical journal", t => {
  const f = fixture(t), store = f.open(); store.append(events(), { expectedVersion: 0 }); const before = store.read();
  const replacement = { ...events()[6], txHash: hash(500), data: { ...events()[6].data, amountWei: "201" } };
  assert.throws(() => store.replaceFromBlock({ fromBlock: 7, events: [replacement], expectedVersion: 1, reason: "Test" }));
  assert.deepEqual(store.read(), before); assert.equal(store.audit().orphanedCount, 0);
  assert.throws(() => store.replaceFromBlock({ fromBlock: 7, events: [], expectedVersion: 0, reason: "Stale" }), error => error.code === "VERSION_CONFLICT");
});
test("reorg truncation removes orphan donations, allocations and contracts consistently", t => {
  const f = fixture(t), store = f.open(); store.append(events(), { expectedVersion: 0 });
  store.replaceFromBlock({ fromBlock: 2, events: [], expectedVersion: 1, reason: "Verified canonical rollback" });
  const state = store.read(); assert.equal(state.totals.amountWei, "100"); assert.equal(state.totals.availableWei, "100"); assert.equal(state.payments.length, 0); assert.equal(state.contracts.length, 0);
  assert.equal(store.audit().orphanedCount, 6);
});
test("stored network mismatch and corrupt journal fail startup without replacing data", t => {
  const f = fixture(t), store = f.open(); store.append(events(), { expectedVersion: 0 }); store.close();
  assert.throws(() => f.open({ chainId: "1" }), error => error.code === "FUNDING_CONFIG_MISMATCH");
  const raw = new DatabaseSync(f.file); try { raw.exec("UPDATE funding_events SET event_json='{' WHERE id=1"); } finally { raw.close(); }
  assert.throws(() => f.open(), SyntaxError);
  const check = new DatabaseSync(f.file); try { assert.equal(check.prepare("SELECT event_json FROM funding_events WHERE id=1").get().event_json, "{"); } finally { check.close(); }
});
test("invalid clock rolls back journal and revision together", t => {
  const f = fixture(t), store = f.open({ clock: () => NaN });
  assert.throws(() => store.append(events(), { expectedVersion: 0 }), error => error.code === "INVALID_CLOCK");
  assert.equal(store.read().totals.amountWei, "0");
});
