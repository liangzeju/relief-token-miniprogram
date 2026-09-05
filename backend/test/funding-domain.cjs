"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createFundingDomain } = require("../funding-domain");

const address = number => "0x" + number.toString(16).padStart(40, "0");
const hash = number => "0x" + number.toString(16).padStart(64, "0");
const config = { chainId: "10143", poolAddress: address(10) };
function fixture() {
  let cursor = 1;
  const ledger = createFundingDomain(undefined, config);
  function event(type, data, overrides = {}) { const n = cursor++; return { type, ...config, blockNumber: n, blockHash: hash(n), txHash: hash(n + 1000), transactionIndex: 0, logIndex: 0, data, ...overrides }; }
  const apply = (type, data, overrides) => ledger.apply(event(type, data, overrides));
  const donation = (donationId, amountWei, purpose = 1, projectId = "project-a", gasReservedWei = "0", donorWallet = address(1)) => apply("DonationReceived", { donationId, donorUserId: "user-" + donationId, donorWallet, purpose, projectId, amountWei, gasReservedWei });
  const task = (taskId = "task-a", purpose = 1, projectId = "project-a") => apply("TaskRegistered", { taskId, purpose, projectId });
  const allocate = (donationId, amountWei, taskId = "task-a") => apply("DonationAllocated", { donationId, taskId, amountWei });
  const lock = (contractId, amountWei, taskId = "task-a") => apply("ContractLocked", { contractId, taskId, amountWei, recipient: address(5) });
  const pay = (paymentId, contractId, batchId, amountWei) => apply("BatchPaid", { paymentId, contractId, batchId, amountWei, recipient: address(5) });
  return { ledger, event, apply, donation, task, allocate, lock, pay };
}
function unchanged(ledger, action, code) { const before = ledger.exportState(); assert.throws(action, error => error.code === code); assert.deepEqual(ledger.exportState(), before); }

test("FIFO uses chain arrival order, not donation ID or task allocation order", () => {
  const f = fixture(); f.donation("z-first", "100"); f.donation("a-second", "200"); f.task();
  f.allocate("a-second", "200"); f.allocate("z-first", "100"); f.lock("c1", "250");
  assert.deepEqual(f.ledger.previewPayment("c1", "120").sources, [{ donationId: "z-first", amountWei: "100" }, { donationId: "a-second", amountWei: "20" }]);
  assert.equal(f.ledger.snapshot().totals.spentWei, "0", "reservation and preview are not contribution");
  f.pay("p1", "c1", "b1", "120"); const s = f.ledger.snapshot();
  assert.equal(s.donations[0].spentWei, "100"); assert.equal(s.donations[1].spentWei, "20");
  assert.deepEqual(s.payments[0].sources, [{ donationId: "z-first", amountWei: "100" }, { donationId: "a-second", amountWei: "20" }]);
  assert.deepEqual(s.totals, { amountWei: "300", gasReservedWei: "0", availableWei: "0", allocatedWei: "50", lockedWei: "130", spentWei: "120", refundedWei: "0", balanceWei: "180" });
});
test("multiple contracts cannot reuse locked sources; sequential batches use remaining oldest eligible funds", () => {
  const f = fixture(); f.donation("d1", "100"); f.donation("d2", "100"); f.task(); f.allocate("d1", "100"); f.allocate("d2", "100");
  f.lock("c1", "120"); f.lock("c2", "80");
  unchanged(f.ledger, () => f.lock("c3", "1"), "INSUFFICIENT_ELIGIBLE_FUNDS");
  f.pay("p2", "c2", "b2", "80"); f.pay("p1", "c1", "b1", "90"); f.pay("p3", "c1", "b3", "30");
  assert.deepEqual(f.ledger.snapshot().payments[2].sources, [{ donationId: "d1", amountWei: "10" }, { donationId: "d2", amountWei: "20" }]);
  assert.equal(f.ledger.snapshot().totals.spentWei, "200");
  unchanged(f.ledger, () => f.pay("p4", "c1", "b4", "1"), "INSUFFICIENT_ELIGIBLE_FUNDS");
});
test("purpose and disaster restrictions remain enforced before FIFO selection", () => {
  const f = fixture(); f.donation("medical", "100", 2); f.donation("other", "100", 1, "project-b"); f.donation("unrestricted", "80", 0, null); f.task();
  unchanged(f.ledger, () => f.allocate("medical", "1"), "DONATION_RESTRICTION_MISMATCH");
  unchanged(f.ledger, () => f.allocate("other", "1"), "DONATION_RESTRICTION_MISMATCH");
  f.allocate("unrestricted", "80"); f.lock("c1", "80"); f.pay("p1", "c1", "b1", "80");
  assert.equal(f.ledger.snapshot().donations[0].spentWei, "0");
  assert.equal(f.ledger.snapshot().donations[1].availableWei, "100");
});
test("task pause and resume events gate new allocations while preserving existing obligations", () => {
  const f = fixture(); f.donation("d", "100"); f.task(); f.allocate("d", "40");
  f.apply("TaskActivityChanged", { taskId: "task-a", active: false });
  assert.equal(f.ledger.snapshot().tasks[0].status, "PAUSED");
  unchanged(f.ledger, () => f.allocate("d", "1"), "TASK_CLOSED");
  unchanged(f.ledger, () => f.lock("c", "1"), "TASK_CLOSED");
  f.apply("TaskActivityChanged", { taskId: "task-a", active: true });
  f.allocate("d", "60"); f.lock("c", "100");
  f.apply("TaskActivityChanged", { taskId: "task-a", active: false });
  f.pay("p", "c", "b", "100");
  f.apply("ContractClosed", { contractId: "c", releasedWei: "0" });
  f.apply("TaskClosed", { taskId: "task-a", releasedWei: "0" });
  assert.equal(f.ledger.snapshot().tasks[0].status, "CLOSED");
  unchanged(f.ledger, () => f.apply("TaskActivityChanged", { taskId: "task-a", active: true }), "TASK_CLOSED");
});
test("unused contract funds return to original task lots and closed task returns restricted donor balance", () => {
  const f = fixture(); f.donation("d1", "100"); f.donation("d2", "100"); f.task(); f.allocate("d1", "100"); f.allocate("d2", "100"); f.lock("c1", "150"); f.pay("p1", "c1", "b1", "40");
  unchanged(f.ledger, () => f.apply("TaskClosed", { taskId: "task-a", releasedWei: "50" }), "OPEN_CONTRACT_OBLIGATIONS");
  unchanged(f.ledger, () => f.apply("ContractClosed", { contractId: "c1", releasedWei: "1" }), "RELEASE_AMOUNT_MISMATCH");
  f.apply("ContractClosed", { contractId: "c1", releasedWei: "110" });
  assert.deepEqual(f.ledger.snapshot().allocations.map(a => a.availableWei), ["60", "100"]);
  f.apply("TaskClosed", { taskId: "task-a", releasedWei: "160" });
  const s = f.ledger.snapshot(); assert.deepEqual(s.donations.map(d => d.availableWei), ["60", "100"]);
  assert.equal(s.donations[0].purpose, 1); assert.equal(s.donations[0].projectId, "project-a");
  unchanged(f.ledger, () => f.allocate("d2", "1"), "TASK_CLOSED");
  unchanged(f.ledger, () => f.pay("p2", "c1", "b2", "1"), "CONTRACT_CLOSED");
});
test("refunds only spend unallocated principal and only return to original wallet", () => {
  const f = fixture(); f.donation("d", "100", 1, "project-a", "10"); f.task(); f.allocate("d", "60");
  unchanged(f.ledger, () => f.apply("DonationRefunded", { refundId: "r1", donationId: "d", recipient: address(2), amountWei: "1" }), "REFUND_OWNER_MISMATCH");
  unchanged(f.ledger, () => f.apply("DonationRefunded", { refundId: "r1", donationId: "d", recipient: address(1), amountWei: "31" }), "BALANCE_OUT_OF_RANGE");
  f.apply("DonationRefunded", { refundId: "r1", donationId: "d", recipient: address(1), amountWei: "30" });
  const s = f.ledger.snapshot(); assert.equal(s.totals.refundedWei, "30"); assert.equal(s.totals.balanceWei, "70"); assert.equal(s.totals.gasReservedWei, "10");
});
test("explicit gas reserve is excluded from allocation and certificates; this module does not set fee policy", () => {
  const f = fixture(); f.donation("d", "100", 1, "project-a", "15"); f.task();
  unchanged(f.ledger, () => f.allocate("d", "86"), "BALANCE_OUT_OF_RANGE");
  f.allocate("d", "85"); f.lock("c", "85"); f.pay("p", "c", "b", "85");
  assert.equal(f.ledger.snapshot().totals.spentWei, "85"); assert.equal(f.ledger.snapshot().totals.gasReservedWei, "15");
  unchanged(f.ledger, () => f.donation("invalid", "1", 1, null, "2"), "GAS_RESERVE_EXCEEDS_DONATION");
});
test("event replay is idempotent regardless of object key order, conflicting event identity is rejected", () => {
  const f = fixture(); const e = f.event("TaskRegistered", { taskId: "task", purpose: 1, projectId: null });
  f.ledger.apply(e); assert.equal(f.ledger.apply(Object.fromEntries(Object.entries(e).reverse())).replayed, true);
  unchanged(f.ledger, () => f.ledger.apply({ ...e, data: { ...e.data, purpose: 2 } }), "EVENT_CONFLICT");
  assert.equal(f.ledger.snapshot().version, 1);
});
test("wrong chain, pool, old events and inconsistent chain positions fail without changes", () => {
  const f = fixture(); const initial = f.event("TaskRegistered", { taskId: "a", purpose: 1, projectId: null }); f.ledger.apply(initial);
  const d = { taskId: "b", purpose: 1, projectId: null };
  unchanged(f.ledger, () => f.ledger.apply(f.event("TaskRegistered", d, { chainId: "1" })), "CHAIN_OR_POOL_MISMATCH");
  unchanged(f.ledger, () => f.ledger.apply(f.event("TaskRegistered", d, { poolAddress: address(11) })), "CHAIN_OR_POOL_MISMATCH");
  unchanged(f.ledger, () => f.ledger.apply(f.event("TaskRegistered", d, { blockNumber: 0 })), "EVENT_ORDER_VIOLATION");
  unchanged(f.ledger, () => f.ledger.apply(f.event("TaskRegistered", d, { blockNumber: initial.blockNumber, transactionIndex: 1, logIndex: 1 })), "BLOCK_HASH_CONFLICT");
  unchanged(f.ledger, () => f.ledger.apply(f.event("TaskRegistered", d, { txHash: initial.txHash, logIndex: 1 })), "TRANSACTION_HASH_CONFLICT");
});
test("same-block arrival order follows transaction and log positions", () => {
  const f = fixture(); const donated = id => ({ donationId: id, donorUserId: "u", donorWallet: address(1), amountWei: "100", gasReservedWei: "0", purpose: 1, projectId: null });
  f.ledger.apply(f.event("DonationReceived", donated("first"), { blockNumber: 1, blockHash: hash(1), transactionIndex: 0, logIndex: 3 }));
  f.ledger.apply(f.event("DonationReceived", donated("second"), { blockNumber: 1, blockHash: hash(1), transactionIndex: 1, logIndex: 4 }));
  f.task("task-a", 1, null); f.allocate("second", "100"); f.allocate("first", "100"); f.lock("c", "100");
  assert.equal(f.ledger.previewPayment("c", "100").sources[0].donationId, "first");
});
test("duplicate payment, duplicate batch and recipient changes cannot create extra contribution", () => {
  const f = fixture(); f.donation("d", "100"); f.task(); f.allocate("d", "100"); f.lock("c", "100"); f.pay("p", "c", "b", "10");
  unchanged(f.ledger, () => f.pay("p", "c", "next", "10"), "DUPLICATE_BUSINESS_ID");
  unchanged(f.ledger, () => f.pay("p2", "c", "b", "10"), "BATCH_ALREADY_PAID");
  unchanged(f.ledger, () => f.apply("BatchPaid", { paymentId: "p2", contractId: "c", batchId: "b2", recipient: address(6), amountWei: "10" }), "RECIPIENT_MISMATCH");
  assert.equal(f.ledger.snapshot().totals.spentWei, "10");
});
test("wei arithmetic remains exact above Number.MAX_SAFE_INTEGER and inputs reject floats and numbers", () => {
  const f = fixture(), n = "900719925474099312345678901234567890"; f.donation("d", n); f.task(); f.allocate("d", n); f.lock("c", n); f.pay("p", "c", "b", n);
  assert.equal(f.ledger.snapshot().totals.spentWei, n);
  for (const value of [1, 1.5, "1.0", "1e18", "-1", "01", (1n << 256n).toString()]) unchanged(f.ledger, () => f.ledger.previewPayment("c", value), "INVALID_WEI");
});
test("snapshots, previews, exports and caller inputs cannot mutate the ledger", () => {
  const f = fixture(); f.donation("d", "100"); f.task(); f.allocate("d", "100"); f.lock("c", "100");
  f.ledger.snapshot().donations[0].availableWei = "999"; f.ledger.exportState().events[0].data.amountWei = "999";
  f.ledger.previewPayment("c", "1").sources[0].amountWei = "999";
  assert.equal(f.ledger.snapshot().totals.amountWei, "100");
  assert.deepEqual(createFundingDomain(f.ledger.exportState(), config).snapshot(), f.ledger.snapshot());
  let called = false; const input = {}; Object.defineProperty(input, "type", { enumerable: true, get() { called = true; return "TaskRegistered"; } });
  unchanged(f.ledger, () => f.ledger.apply(input), "INVALID_DATA"); assert.equal(called, false);
  const cyclic = {}; cyclic.self = cyclic; unchanged(f.ledger, () => f.ledger.apply(cyclic), "INVALID_DATA");
});
test("replay rejects corrupted events instead of synthesizing a balance", () => {
  const f = fixture(); f.donation("d", "50"); f.task(); f.allocate("d", "50"); f.lock("c", "50"); f.pay("p", "c", "b", "50");
  const exportValue = f.ledger.exportState(); exportValue.events[0].data.amountWei = "40";
  assert.throws(() => createFundingDomain(exportValue, config), error => error.code === "BALANCE_OUT_OF_RANGE");
  assert.throws(() => createFundingDomain({ schemaVersion: 1, events: [], donations: [] }, config), error => error.code === "UNKNOWN_FIELD");
});
test("closing fully paid contracts releases zero but still precedes task closure", () => {
  const f = fixture(); f.donation("d", "50"); f.task(); f.allocate("d", "50"); f.lock("c", "50"); f.pay("p", "c", "b", "50");
  f.apply("ContractClosed", { contractId: "c", releasedWei: "0" }); f.apply("TaskClosed", { taskId: "task-a", releasedWei: "0" });
  assert.equal(f.ledger.snapshot().totals.balanceWei, "0");
});

module.exports = { fixture, config, address, hash };
