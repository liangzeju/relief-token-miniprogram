"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ethers = require("ethers");
const { verifyActionRecovery } = require("../../web/mobile/wallet.js");
const artifact = require("../../web/shared/contracts/ReliefPool.json");
const iface = new ethers.Interface(artifact.abi);
const POOL = "0x" + "10".repeat(20);
const DONOR = "0x" + "20".repeat(20);
const OTHER = "0x" + "30".repeat(20);
const ID = ethers.id("donation");
const TX_HASH = ethers.id("transaction");
const BLOCK_HASH = ethers.id("block");

function event(name, args, address = POOL) {
  return { ...iface.encodeEventLog(iface.getEvent(name), args), address, removed: false };
}

function fixture(action = "refund") {
  const method = action === "refund" ? "refundUnallocated" : "allocateRemaining";
  const transaction = {
    from: DONOR, to: POOL, chainId: "0x279f", value: "0x0",
    data: iface.encodeFunctionData(method, [ID])
  };
  const f = {
    record: { id: ID, userId: "user", submitKey: "recovery", wallet: DONOR, action, transaction, phase: "SUBMITTED", txHash: TX_HASH },
    tx: { ...transaction, input: transaction.data, hash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: "0xa" },
    receipt: {
      from: DONOR, to: POOL, transactionHash: TX_HASH, blockHash: BLOCK_HASH,
      blockNumber: "0xa", status: "0x1",
      logs: action === "refund" ? [event("DonationRefunded", [ID, DONOR, 50n])] : []
    },
    block: { hash: BLOCK_HASH }, head: "0xb", chain: "0x279f", calls: [], onRequest: null
  };
  f.provider = { async request({ method: rpcMethod, params }) {
    f.calls.push(rpcMethod);
    if (f.onRequest) await f.onRequest(rpcMethod);
    switch (rpcMethod) {
      case "eth_chainId": return f.chain;
      case "eth_getTransactionByHash": assert.deepEqual(Array.from(params), [TX_HASH]); return f.tx;
      case "eth_getTransactionReceipt": assert.deepEqual(Array.from(params), [TX_HASH]); return f.receipt;
      case "eth_blockNumber": return f.head;
      case "eth_getBlockByNumber": assert.deepEqual(Array.from(params), ["0xa", false]); return f.block;
      default: throw new Error(`Unexpected RPC: ${rpcMethod}`);
    }
  } };
  f.verify = (confirmations = 2) => verifyActionRecovery(f.record, TX_HASH, f.provider, ethers, confirmations);
  return f;
}

test("confirmed refund uses the real ABI and requires its matching event", async () => {
  const f = fixture();
  assert.deepEqual(await f.verify(), { noAllocation: false });
  assert.ok(f.calls.includes("eth_getTransactionByHash"));
});

test("allocateRemaining accepts a confirmed no-op without allocation events", async () => {
  assert.deepEqual(await fixture("reallocate").verify(), { noAllocation: true });
});

test("allocateRemaining accepts one or several positive allocations", async () => {
  for (const count of [1, 2]) {
    const f = fixture("reallocate");
    f.receipt.logs = Array.from({ length: count }, (_, i) => event("DonationAllocated", [ID, ethers.id(`task-${i}`), 10n]));
    assert.deepEqual(await f.verify(), { noAllocation: false });
  }
});

const invalidCases = [
  ["wrong method despite matching refund event", "refund", f => { f.tx.input = iface.encodeFunctionData("allocateRemaining", [ID]); }],
  ["donate cannot recover reallocation", "reallocate", f => { f.tx.input = iface.encodeFunctionData("donate", [ID, 1]); }],
  ["wrong donation argument", "refund", f => { f.tx.input = iface.encodeFunctionData("refundUnallocated", [ethers.id("other")]); }],
  ["wrong donation argument for eventless allocation", "reallocate", f => { f.tx.input = iface.encodeFunctionData("allocateRemaining", [ethers.id("other")]); }],
  ["stored calldata inconsistent with record ID", "refund", f => { f.record.transaction.data = iface.encodeFunctionData("refundUnallocated", [ethers.id("other")]); }],
  ["wrong provider chain", "refund", f => { f.chain = "0x1"; }],
  ["wrong transaction chain", "refund", f => { f.tx.chainId = "0x1"; }],
  ["wrong stored chain", "refund", f => { f.record.transaction.chainId = "0x1"; }],
  ["chain switches during lookup", "refund", f => { f.onRequest = method => { if (method === "eth_getBlockByNumber") f.chain = "0x1"; }; }],
  ["wrong transaction sender", "refund", f => { f.tx.from = OTHER; }],
  ["wrong receipt sender", "refund", f => { f.receipt.from = OTHER; }],
  ["wrong destination", "refund", f => { f.tx.to = OTHER; }],
  ["nonzero call value", "refund", f => { f.tx.value = "0x1"; }],
  ["wrong transaction hash", "refund", f => { f.tx.hash = ethers.id("other"); }],
  ["wrong receipt hash", "refund", f => { f.receipt.transactionHash = ethers.id("other"); }],
  ["inconsistent inclusion block", "refund", f => { f.tx.blockHash = ethers.id("other"); }],
  ["reorganized block", "refund", f => { f.block.hash = ethers.id("other"); }],
  ["reverted refund", "refund", f => { f.receipt.status = "0x0"; f.receipt.logs = []; }],
  ["reverted eventless allocation", "reallocate", f => { f.receipt.status = "0x0"; }],
  ["unknown transaction", "refund", f => { f.tx = null; }],
  ["pending receipt", "refund", f => { f.receipt = null; }],
  ["pending inclusion block", "refund", f => { f.tx.blockNumber = null; }],
  ["insufficient confirmations", "refund", f => { f.head = "0xa"; }],
  ["future receipt block", "refund", f => { f.head = "0x9"; }],
  ["missing refund event", "refund", f => { f.receipt.logs = []; }],
  ["duplicate refund event", "refund", f => { f.receipt.logs.push(f.receipt.logs[0]); }],
  ["refund event for another donation", "refund", f => { f.receipt.logs = [event("DonationRefunded", [ethers.id("other"), DONOR, 50n])]; }],
  ["refund event for another donor", "refund", f => { f.receipt.logs = [event("DonationRefunded", [ID, OTHER, 50n])]; }],
  ["refund event from another contract", "refund", f => { f.receipt.logs[0].address = OTHER; }],
  ["zero refund amount", "refund", f => { f.receipt.logs = [event("DonationRefunded", [ID, DONOR, 0n])]; }],
  ["removed event", "refund", f => { f.receipt.logs[0].removed = true; }],
  ["malformed event", "refund", f => { f.receipt.logs[0].data = "0x"; }],
  ["missing logs cannot prove a no-op", "reallocate", f => { delete f.receipt.logs; }],
  ["allocation event for another donation", "reallocate", f => { f.receipt.logs = [event("DonationAllocated", [ethers.id("other"), ethers.id("task"), 1n])]; }],
  ["zero allocation amount", "reallocate", f => { f.receipt.logs = [event("DonationAllocated", [ID, ethers.id("task"), 0n])]; }],
  ["allocation with invalid task", "reallocate", f => { f.receipt.logs = [event("DonationAllocated", [ID, ethers.ZeroHash, 1n])]; }],
  ["unexpected pool event is not a no-op", "reallocate", f => { f.receipt.logs = [event("DonationUnallocated", [ID, 50n])]; }]
];

for (const [name, action, mutate] of invalidCases) {
  test(`rejects ${name} without modifying the recovery record`, async () => {
    const f = fixture(action);
    mutate(f);
    const original = structuredClone(f.record);
    await assert.rejects(f.verify());
    assert.deepEqual(f.record, original);
  });
}

test("uses configured confirmation threshold and rejects invalid thresholds", async () => {
  const f = fixture();
  await assert.rejects(f.verify(3), /等待确认/);
  for (const threshold of [0, -1, 1.5, "invalid"]) await assert.rejects(f.verify(threshold), /配置无效/);
  f.head = "0xc";
  assert.deepEqual(await f.verify(3), { noAllocation: false });
});

test("ignores external callback logs when a valid refund event exists", async () => {
  const f = fixture();
  f.receipt.logs.push({ address: OTHER, topics: [], data: "0x" });
  assert.deepEqual(await f.verify(), { noAllocation: false });
});

// Exercise the actual UI completion path with inert DOM/storage. Stop before
// startup listeners; keep production checkAction, guards and persistence intact.
const source = fs.readFileSync(path.resolve(__dirname, "../../web/mobile/wallet.js"), "utf8");
function uiHarness(f) {
  const nodes = new Map();
  const stored = new Map([["relief-wallet-pending-v1", JSON.stringify([f.record])]]);
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      textContent: "", innerHTML: "", classList: { toggle() {} }, querySelectorAll: () => []
    });
    return nodes.get(selector);
  } };
  const context = vm.createContext({
    document, location: { protocol: "http:" }, window: { ethers },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    mockProvider: f.provider
  });
  const marker = "  function startEvents() {";
  assert.equal(source.split(marker).length, 2);
  vm.runInContext(source.replace(marker, `
    provider = mockProvider;
    me.user = { id: "user" };
    config = { confirmations: 2 };
    refreshing = true;
    globalThis.harness = {
      check: hash => checkAction(pending[0], hash),
      records: () => pending,
      invalidate: () => { walletEpoch++; }
    };
    return;
${marker}`), context);
  return { ...context.harness, stored, nodes };
}

test("UI keeps failed, mismatched, pending and underconfirmed recovery records", async (t) => {
  for (const [name, action, mutate] of invalidCases) {
    await t.test(name, async () => {
      const f = fixture(action);
      mutate(f);
      const ui = uiHarness(f);
      const original = JSON.stringify(f.record);
      await ui.check();
      assert.equal(JSON.stringify(ui.records()[0]), original);
      assert.equal(ui.stored.get("relief-wallet-pending-v1"), `[${original}]`);
      assert.doesNotMatch(ui.nodes.get("#donateResult").textContent, /调用已确认/);
    });
  }
});

test("manual wrong hash remains editable and a corrected verified hash can recover", async () => {
  const f = fixture();
  f.record.txHash = null;
  f.record.phase = "UNKNOWN";
  const ui = uiHarness(f);
  const originalInput = f.tx.input;
  f.tx.input = iface.encodeFunctionData("allocateRemaining", [ID]);
  await ui.check(TX_HASH);
  assert.equal(ui.records()[0].txHash, null);
  assert.equal(ui.records()[0].phase, "UNKNOWN");
  assert.equal(JSON.parse(ui.stored.get("relief-wallet-pending-v1"))[0].txHash, null);
  f.tx.input = originalInput;
  await ui.check(TX_HASH);
  assert.equal(ui.records().length, 0);
  assert.equal(ui.stored.get("relief-wallet-pending-v1"), "[]");
  assert.match(ui.nodes.get("#donateResult").textContent, /调用已确认/);
});

test("UI clears only verified allocations and identifies no-op completion", async () => {
  for (const allocated of [false, true]) {
    const f = fixture("reallocate");
    if (allocated) f.receipt.logs = [event("DonationAllocated", [ID, ethers.id("task"), 10n])];
    const ui = uiHarness(f);
    await ui.check();
    assert.equal(ui.records().length, 0);
    assert.equal(ui.stored.get("relief-wallet-pending-v1"), "[]");
    assert.match(ui.nodes.get("#donateResult").textContent, allocated ? /以后端索引为准/ : /本次未产生分配/);
  }
});

test("UI retains the record if wallet identity changes while verifying", async () => {
  const f = fixture();
  const ui = uiHarness(f);
  f.onRequest = method => { if (method === "eth_getBlockByNumber") ui.invalidate(); };
  await ui.check();
  assert.equal(ui.records().length, 1);
  assert.match(ui.nodes.get("#donateResult").textContent, /已变化/);
});
