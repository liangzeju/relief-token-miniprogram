"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createFundingDomain } = require("../funding-domain");
const { createFundingStore } = require("../funding-store");

const address = n => "0x" + n.toString(16).padStart(40, "0");
const hash = n => "0x" + n.toString(16).padStart(64, "0");
const config = { chainId: "10143", poolAddress: address(9) };
const source = (donationId, amountWei) => ({ donationId, amountWei });
const donation = (donationId, amountWei = "100", gasReservedWei = "0") => ({
  donationId, donorUserId: "user-" + donationId, donorWallet: address(1),
  purpose: 1, projectId: null, amountWei, gasReservedWei
});
function event(type, data, n, overrides = {}) {
  return { type, data, ...config, txHash: hash(100 + n), blockHash: hash(1000 + n),
    blockNumber: n, transactionIndex: 0, logIndex: 0, ...overrides };
}
function history() {
  return [
    ["DonationReceived", donation("first")],
    ["DonationReceived", donation("second")],
    ["TaskRegistered", { taskId: "task", purpose: 1, projectId: null }],
    ["DonationAllocated", { donationId: "second", taskId: "task", amountWei: "100" }],
    ["DonationAllocated", { donationId: "first", taskId: "task", amountWei: "100" }],
    ["ContractLocked", { contractId: "contract", taskId: "task", recipient: address(3), amountWei: "200" }],
    ["BatchPaid", { paymentId: "payment", contractId: "contract", batchId: "batch", recipient: address(3), amountWei: "120" }]
  ].map(([type, data], i) => event(type, data, i + 1));
}
function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, "funding-review-"));
  const file = path.join(directory, "funding.sqlite");
  const opened = [];
  const open = () => {
    const store = createFundingStore({ file, ...config });
    opened.push(store);
    return store;
  };
  t.after(() => {
    for (const store of opened) store.close();
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.ok(path.basename(directory).startsWith("funding-review-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { file, open };
}
function conserved(snapshot) {
  for (const d of [...snapshot.donations, snapshot.totals]) {
    const accounted = ["availableWei", "gasReservedWei", "allocatedWei", "lockedWei", "spentWei", "refundedWei"]
      .reduce((total, field) => total + BigInt(d[field]), 0n);
    assert.equal(accounted, BigInt(d.amountWei));
  }
}

test("review: cross-task release, relock, payment and refund preserve original sources", () => {
  const domain = createFundingDomain(undefined, config);
  let n = 0;
  const apply = (type, data) => { domain.apply(event(type, data, ++n)); conserved(domain.snapshot()); };
  const allocate = (donationId, taskId, amountWei) => apply("DonationAllocated", { donationId, taskId, amountWei });
  const lock = (contractId, taskId, amountWei) => apply("ContractLocked", { contractId, taskId, amountWei, recipient: address(3) });
  const pay = (contractId, amountWei) => apply("BatchPaid", { contractId, amountWei, recipient: address(3), paymentId: "p-" + contractId, batchId: "b" });
  const close = (contractId, releasedWei) => apply("ContractClosed", { contractId, releasedWei });
  apply("DonationReceived", donation("first", "100", "10"));
  apply("DonationReceived", donation("second", "70"));
  for (const taskId of ["a", "b"]) apply("TaskRegistered", { taskId, purpose: 1, projectId: null });
  allocate("first", "a", "60"); allocate("first", "b", "30"); allocate("second", "a", "70");
  lock("a1", "a", "100"); pay("a1", "75"); close("a1", "25");
  lock("a2", "a", "40"); pay("a2", "40"); close("a2", "0");
  apply("TaskClosed", { taskId: "a", releasedWei: "15" });
  lock("b1", "b", "30"); pay("b1", "10"); close("b1", "20");
  apply("TaskClosed", { taskId: "b", releasedWei: "20" });
  for (const [donationId, amountWei] of [["first", "20"], ["second", "15"]]) {
    apply("DonationRefunded", { donationId, amountWei, refundId: "r-" + donationId, recipient: address(1) });
  }
  const s = domain.snapshot();
  assert.deepEqual(s.payments.map(p => p.sources), [
    [source("first", "60"), source("second", "15")], [source("second", "40")], [source("first", "10")]
  ]);
  assert.deepEqual(s.donations.map(d => [d.spentWei, d.refundedWei]), [["70", "20"], ["55", "15"]]);
  assert.equal(s.totals.amountWei, "170"); assert.equal(s.totals.spentWei, "125");
  assert.equal(s.totals.refundedWei, "35"); assert.equal(s.totals.balanceWei, "10");
  assert.deepEqual(createFundingDomain(domain.exportState(), config).snapshot(), s);
});

test("review: late lock validation failure restores both balances and journal", () => {
  const domain = createFundingDomain({ schemaVersion: 1, events: history().slice(0, 5) }, config);
  const before = domain.snapshot(), journal = domain.exportState();
  const lock = history()[5];
  assert.throws(() => domain.apply({ ...lock, data: { ...lock.data, recipient: address(0) } }), { code: "INVALID_WALLET" });
  assert.deepEqual(domain.snapshot(), before); assert.deepEqual(domain.exportState(), journal);
  domain.apply(lock);
  assert.deepEqual(domain.previewPayment("contract", "120").sources, [source("first", "100"), source("second", "20")]);
});

test("review: corrected donation order recomputes payment FIFO and survives restart", t => {
  const f = fixture(t), store = f.open(), original = history();
  store.append(original, { expectedVersion: 0 });
  const before = store.read();
  assert.deepEqual(before.payments[0].sources, [source("first", "100"), source("second", "20")]);
  const replacement = [original[1], original[0], ...original.slice(2)].map((e, i) => ({
    ...e, blockNumber: i + 1, blockHash: hash(2000 + i)
  }));
  const result = store.replaceFromBlock({ fromBlock: 1, events: replacement, expectedVersion: 1, reason: "Verified replacement branch" });
  const after = store.read();
  assert.equal(result.orphanedCount, 7);
  assert.deepEqual(after.payments[0].sources, [source("second", "100"), source("first", "20")]);
  assert.deepEqual(after.totals, before.totals); conserved(after);
  assert.equal(after.storeVersion, 2); store.close(); assert.deepEqual(f.open().read(), after);
});

test("review: orphan re-inclusion counts once and stale writes remain rejected", t => {
  const f = fixture(t), store = f.open(), original = history();
  store.append(original, { expectedVersion: 0 });
  store.replaceFromBlock({ fromBlock: 7, events: [], expectedVersion: 1, reason: "Verified rollback" });
  assert.equal(store.read().totals.spentWei, "0");
  assert.throws(() => store.append([original[6]], { expectedVersion: 1 }), { code: "VERSION_CONFLICT" });
  const included = { ...original[6], blockNumber: 9, blockHash: hash(9000) };
  store.append([included], { expectedVersion: 2 });
  assert.equal(store.append([included], { expectedVersion: 2 }).replayed, true);
  const before = store.read();
  assert.equal(before.totals.spentWei, "120"); assert.equal(before.payments.length, 1);
  assert.equal(before.storeVersion, 3); assert.equal(store.audit().orphanedCount, 1);
  assert.throws(() => store.append([{ ...included, data: { ...included.data, amountWei: "30" } }], { expectedVersion: 3 }), { code: "EVENT_CONFLICT" });
  const repeatedBatch = event("BatchPaid", { ...included.data, paymentId: "other", amountWei: "1" }, 10);
  assert.throws(() => store.append([repeatedBatch], { expectedVersion: 3 }), { code: "BATCH_ALREADY_PAID" });
  assert.deepEqual(store.read(), before); store.close(); assert.deepEqual(f.open().read(), before);
});

for (const target of ["funding_events", "funding_revisions"]) {
  test("review: replacement failure at " + target + " restores canonical rows and audit", t => {
    const f = fixture(t), store = f.open();
    store.append(history(), { expectedVersion: 0 });
    const before = store.read(), audit = store.audit(), raw = new DatabaseSync(f.file);
    const rows = () => raw.prepare("SELECT * FROM funding_events ORDER BY id").all();
    try {
      const originalRows = rows();
      raw.exec(`CREATE TRIGGER review_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'review injected failure'); END`);
      const payment = history()[6];
      const replacement = { ...payment, blockHash: hash(7777), data: { ...payment.data, amountWei: "30" } };
      const request = { fromBlock: 7, events: [replacement], expectedVersion: 1, reason: "Verified correction" };
      assert.throws(() => store.replaceFromBlock(request), /review injected failure/);
      assert.deepEqual(rows(), originalRows); assert.deepEqual(store.read(), before); assert.deepEqual(store.audit(), audit);
      raw.exec("DROP TRIGGER review_failure");
      store.replaceFromBlock(request);
      const after = store.read();
      assert.equal(after.totals.spentWei, "30"); assert.equal(after.totals.lockedWei, "170");
      assert.equal(store.audit().orphanedCount, 1); assert.equal(after.storeVersion, 2);
      store.close(); assert.deepEqual(f.open().read(), after);
    } finally { raw.close(); }
  });
}

test("review: same-block multi-log transactions persist and reject inconsistent positions", t => {
  const f = fixture(t), store = f.open();
  const positions = [[0, 3], [0, 4], [1, 6], [2, 7], [2, 8], [3, 9], [3, 10]];
  const batch = history().map((e, i) => ({ ...e, blockNumber: 1, blockHash: hash(1),
    transactionIndex: positions[i][0], logIndex: positions[i][1], txHash: hash(100 + positions[i][0]) }));
  store.append(batch.slice(0, 4), { expectedVersion: 0 }); store.append(batch.slice(4), { expectedVersion: 1 });
  const before = store.read();
  assert.deepEqual(before.payments[0].sources, [source("first", "100"), source("second", "20")]);
  assert.equal(store.append(batch.slice().reverse(), { expectedVersion: 0 }).replayed, true);
  for (const [transactionIndex, logIndex, code] of [[4, 9, "EVENT_ORDER_VIOLATION"], [2, 11, "EVENT_ORDER_VIOLATION"], [3, 11, "TRANSACTION_HASH_CONFLICT"]]) {
    const invalid = event("TaskRegistered", { taskId: "extra", purpose: 1, projectId: null }, 1, {
      blockHash: hash(1), txHash: hash(999), transactionIndex, logIndex
    });
    assert.throws(() => store.append([invalid], { expectedVersion: 2 }), { code });
    assert.deepEqual(store.read(), before);
  }
  store.close(); assert.deepEqual(f.open().read(), before);
});
