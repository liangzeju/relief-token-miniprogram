"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Interface, getAddress, id, keccak256, ZeroHash } = require("ethers");
const { FUNDING_ABI, createFundingReceiptVerifier } = require("../funding-receipts");
const iface = new Interface(FUNDING_ABI);
const wallet = "0x" + "1a".repeat(20), pool = "0x" + "2b".repeat(20), registrar = "0x" + "3c".repeat(20);
const decimalFields = ["amountWei", "gasReservedWei", "nonce", "deadline", "authorizationEpoch"];

function fixture() {
  const txHash = id("transaction"), blockHash = id("block"), code = "0x60006000";
  const permit = { donationId: id("donation"), donor: wallet, purpose: 1, projectId: ZeroHash, amountWei: 100n,
    gasReservedWei: 5n, registrationHash: id("private-salted-commitment"), nonce: 1n, deadline: 9999n, authorizationEpoch: 0n,
    feePolicyHash: id("test-fee-policy"), registrar };
  const log = (name, args, index) => ({ ...iface.encodeEventLog(iface.getEvent(name), args), index, address: pool, removed: false,
    blockNumber: 7, blockHash, transactionIndex: 0, transactionHash: txHash });
  const receipt = { hash: txHash, blockHash, blockNumber: 7, index: 0, from: wallet, to: pool, status: 1,
    logs: [log("DonationReceived", [permit.donationId, wallet, 1, ZeroHash, 100n, 5n, permit.registrationHash, permit.feePolicyHash], 0),
      log("DonationAllocated", [permit.donationId, id("task"), 80n], 1)] };
  const transaction = { hash: txHash, blockHash, blockNumber: 7, from: wallet, to: pool, chainId: 10143n, value: 100n,
    data: iface.encodeFunctionData("donate", [permit, registrar, "0x1234"]) };
  const block = { hash: blockHash, number: 7, transactions: [txHash] }, head = { number: 8 };
  const registration = { userId: "registered-user", wallet, registrationHash: permit.registrationHash,
    chainId: "10143", poolAddress: pool,
    permit: Object.fromEntries(Object.entries(permit).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])) };
  const provider = { getNetwork: async () => ({ chainId: 10143n }), getTransactionReceipt: async () => receipt,
    getTransaction: async () => transaction, getBlock: async tag => tag === "latest" ? head : block, getCode: async () => code };
  const config = { provider, chainId: "10143", poolAddress: pool, runtimeCodeHash: keccak256(code), confirmations: 2,
    resolveRegistration: async () => registration };
  return { txHash, blockHash, permit, log, receipt, transaction, block, head, registration, provider, config,
    verify: () => createFundingReceiptVerifier(config).verify(txHash) };
}

test("verified receipt becomes private normalized donation and exact task allocation", async () => {
  const f = fixture(), result = await f.verify();
  assert.equal(result.confirmations, 2); assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0].data, { donationId: f.permit.donationId, donorUserId: "registered-user", donorWallet: wallet,
    purpose: 1, projectId: null, amountWei: "100", gasReservedWei: "5" });
  assert.equal(result.events[1].type, "DonationAllocated"); assert.equal(result.events[1].data.amountWei, "80");
  assert.equal(result.events[1].logIndex, 1); assert.equal(result.events[0].chainId, "10143");
});

test("receipt verification rejects mismatched or incomplete chain evidence before returning events", async t => {
  const cases = [
    ["wrong network", f => { f.provider.getNetwork = async () => ({ chainId: 1n }); }, "CHAIN_MISMATCH"],
    ["pending", f => { f.provider.getTransactionReceipt = async () => null; }, "TRANSACTION_PENDING"],
    ["reverted", f => { f.receipt.status = 0; }, "TRANSACTION_REVERTED"],
    ["wrong receipt", f => { f.receipt.hash = id("other"); }, "RECEIPT_MISMATCH"],
    ["wrong target", f => { f.transaction.to = wallet; }, "TRANSACTION_MISMATCH"],
    ["wrong sender", f => { f.transaction.from = registrar; }, "TRANSACTION_MISMATCH"],
    ["wrong transaction chain", f => { f.transaction.chainId = 1n; }, "TRANSACTION_MISMATCH"],
    ["wrong canonical block", f => { f.block.hash = id("reorg"); }, "CANONICAL_BLOCK_MISMATCH"],
    ["transaction not in block", f => { f.block.transactions = [id("other")]; }, "CANONICAL_BLOCK_MISMATCH"],
    ["not confirmed", f => { f.head.number = 7; }, "CONFIRMATIONS_PENDING"],
    ["unknown runtime", f => { f.provider.getCode = async () => "0x6001"; }, "RUNTIME_CODE_MISMATCH"],
    ["missing runtime", f => { f.provider.getCode = async () => "0x"; }, "RUNTIME_CODE_MISMATCH"],
    ["wrong call", f => { f.transaction.data = "0xdeadbeef"; }, "UNSUPPORTED_FUNDING_CALL"],
    ["trailing calldata byte", f => { f.transaction.data += "00"; }, "NONCANONICAL_FUNDING_CALL"],
    ["trailing calldata word", f => { f.transaction.data += "00".repeat(32); }, "NONCANONICAL_FUNDING_CALL"],
    ["wrong value", f => { f.transaction.value = 99n; }, "TRANSACTION_VALUE_MISMATCH"],
    ["removed log", f => { f.receipt.logs[0].removed = true; }, "LOG_POSITION_MISMATCH"],
    ["duplicate log index", f => { f.receipt.logs[1].index = 0; }, "LOG_POSITION_MISMATCH"],
    ["wrong log transaction", f => { f.receipt.logs[0].transactionHash = id("other"); }, "LOG_POSITION_MISMATCH"],
    ["wrong log block", f => { f.receipt.logs[0].blockHash = id("other"); }, "LOG_POSITION_MISMATCH"],
    ["missing donation event", f => { f.receipt.logs.shift(); }, "DONATION_EVENT_REQUIRED"],
    ["duplicate donation event", f => { f.receipt.logs.push({ ...f.receipt.logs[0], index: 2 }); }, "DONATION_EVENT_REQUIRED"],
    ["unrecognized pool event", f => { f.receipt.logs[0].topics[0] = id("Unknown()"); }, "UNKNOWN_POOL_EVENT"],
    ["trailing log bytes", f => { f.receipt.logs[0].data += "00"; }, "NONCANONICAL_FUNDING_LOG"],
    ["unrelated allocation", f => { f.receipt.logs[1] = f.log("DonationAllocated", [id("other"), id("task"), 80n], 1); }, "ALLOCATION_CALL_MISMATCH"],
    ["wrong amount event", f => { f.receipt.logs[0] = f.log("DonationReceived", [f.permit.donationId, wallet, 1, ZeroHash, 99n, 5n, f.permit.registrationHash, f.permit.feePolicyHash], 0); }, "DONATION_CALL_MISMATCH"],
    ["unbound registrar", f => { f.transaction.data = iface.encodeFunctionData("donate", [{ ...f.permit, registrar: wallet }, registrar, "0x1234"]); }, "DONATION_CALL_MISMATCH"],
    ["unknown registration", f => { f.config.resolveRegistration = async () => null; }, "REGISTRATION_LINK_MISMATCH"],
    ["changed wallet registration", f => { f.registration.wallet = registrar; }, "REGISTRATION_LINK_MISMATCH"],
    ["changed commitment", f => { f.registration.registrationHash = id("changed"); }, "REGISTRATION_LINK_MISMATCH"],
    ["reorg during private lookup", f => { f.config.resolveRegistration = async () => { f.block.hash = id("changed"); return f.registration; }; }, "CHAIN_CHANGED_DURING_VERIFICATION"],
    ["confirmation lost during private lookup", f => { f.config.resolveRegistration = async () => { f.head.number = 7; return f.registration; }; }, "CONFIRMATIONS_PENDING"]
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async () => {
    const f = fixture(); mutate(f); await assert.rejects(f.verify, { code });
  });
});

test("private registration linkage requires a valid user ID, wallet and commitment", async t => {
  for (const key of ["userId", "wallet", "registrationHash"]) {
    for (const [label, value] of [["null", null], ["empty", ""], ["number", 1], ["object", {}], ["array", []], ["boolean", true]]) {
      await t.test(`${key}: ${label}`, async () => {
        const f = fixture(); f.registration[key] = value;
        await assert.rejects(f.verify, { code: "REGISTRATION_LINK_MISMATCH" });
      });
    }
    await t.test(`${key}: missing`, async () => {
      const f = fixture(); delete f.registration[key];
      await assert.rejects(f.verify, { code: "REGISTRATION_LINK_MISMATCH" });
    });
  }
  for (const userId of ["user with spaces", "../private", "x".repeat(161)]) {
    await t.test(`invalid user ID ${userId.slice(0, 24)}`, async () => {
      const f = fixture(); f.registration.userId = userId;
      await assert.rejects(f.verify, { code: "REGISTRATION_LINK_MISMATCH" });
    });
  }
});

test("every original permit field is required and must match the mined call with its exact type", async t => {
  const replacements = {
    donationId: id("different-donation"), donor: registrar, purpose: 2, projectId: id("different-project"),
    amountWei: "101", gasReservedWei: "6", registrationHash: id("different-registration"), nonce: "2",
    deadline: "10000", authorizationEpoch: "1", feePolicyHash: id("different-policy"), registrar: wallet
  };
  assert.deepEqual(Object.keys(fixture().registration.permit), iface.getFunction("donate").inputs[0].components.map(field => field.name));
  for (const [key, replacement] of Object.entries(replacements)) {
    const original = fixture().registration.permit[key];
    const wrongType = key === "purpose" ? String(original) : decimalFields.includes(key) ? BigInt(original) : 1;
    for (const [label, value] of [["different", replacement], ["wrong type", wrongType], ["null", null], ["object", {}], ["array", [original]], ["boolean", false]]) {
      await t.test(`${key}: ${label}`, async () => {
        const f = fixture(); f.registration.permit[key] = value;
        await assert.rejects(f.verify, { code: "DONATION_INTENT_MISMATCH" });
      });
    }
    await t.test(`${key}: missing`, async () => {
      const f = fixture(); delete f.registration.permit[key];
      await assert.rejects(f.verify, { code: "DONATION_INTENT_MISMATCH" });
    });
  }
  for (const purpose of [-1, 6, 1.5, 1n, NaN, Infinity]) {
    await t.test(`invalid purpose ${String(purpose)}`, async () => {
      const f = fixture(); f.registration.permit.purpose = purpose;
      await assert.rejects(f.verify, { code: "DONATION_INTENT_MISMATCH" });
    });
  }
});

test("original uint256 values require canonical decimal strings without numeric coercion", async t => {
  for (const key of decimalFields) {
    const canonical = fixture().registration.permit[key];
    for (const [label, value] of [
      ["number", Number(canonical)], ["leading zero", `0${canonical}`], ["plus sign", `+${canonical}`],
      ["leading space", ` ${canonical}`], ["trailing space", `${canonical} `], ["newline", `${canonical}\n`],
      ["hex", `0x${BigInt(canonical).toString(16)}`], ["exponent", `${canonical}e0`],
      ["fraction", `${canonical}.0`], ["negative", "-1"], ["empty", ""],
      ["uint256 overflow", (1n << 256n).toString()], ["oversized", "9".repeat(79)]
    ]) {
      await t.test(`${key}: ${label}`, async () => {
        const f = fixture(); f.registration.permit[key] = value;
        await assert.rejects(f.verify, { code: "DONATION_INTENT_MISMATCH" });
      });
    }
  }
});

test("original domain and complete intent record are mandatory, including for legacy registrations", async t => {
  const cases = [
    ["legacy three-field record", f => { delete f.registration.chainId; delete f.registration.poolAddress; delete f.registration.permit; }],
    ["missing chain", f => { delete f.registration.chainId; }],
    ["missing pool", f => { delete f.registration.poolAddress; }],
    ["missing permit", f => { delete f.registration.permit; }]
  ];
  for (const value of [null, 10143, 10143n, "1", "010143", "+10143", "10143.0", "10143e0", "0x279f", " 10143", "10143\n", {}, ["10143"], true]) {
    cases.push([`invalid chain ${String(value)}`, f => { f.registration.chainId = value; }]);
  }
  for (const value of [null, wallet, 1, "", pool.slice(2), `${pool}00`, "0x" + "zz".repeat(20), {}, [pool], true]) {
    cases.push([`invalid pool ${String(value)}`, f => { f.registration.poolAddress = value; }]);
  }
  for (const value of [null, "permit", 1, true, [], {}]) {
    cases.push([`invalid permit ${String(value)}`, f => { f.registration.permit = value; }]);
  }
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.verify, { code: "DONATION_INTENT_MISMATCH" });
  });
  for (const key of ["donor", "registrar", "donationId", "projectId", "registrationHash", "feePolicyHash"]) {
    for (const value of ["", "0x12", "invalid", `${fixture().registration.permit[key]}00`]) {
      await t.test(`malformed ${key}: ${value.slice(0, 12)}`, async () => {
        const f = fixture(); f.registration.permit[key] = value;
        await assert.rejects(f.verify, { code: "DONATION_INTENT_MISMATCH" });
      });
    }
  }
});

test("valid addresses compare case insensitively and private record details stay out of normalized events", async () => {
  const f = fixture();
  f.registration.wallet = getAddress(wallet);
  f.registration.poolAddress = "0x" + pool.slice(2).toUpperCase();
  f.registration.permit.donor = getAddress(wallet);
  f.registration.permit.registrar = "0x" + registrar.slice(2).toUpperCase();
  f.registration.profile = { name: "Private Receipt Person", email: "private.receipt@example.invalid", organization: "Private Receipt Organization" };
  f.registration.salt = "private-receipt-salt";
  const normalized = JSON.stringify((await f.verify()).events);
  for (const value of [...Object.values(f.registration.profile), f.registration.salt, f.registration.registrationHash]) {
    assert.equal(normalized.includes(value), false);
  }
});

test("task registration, activity changes, explicit allocation and refund calls each require matching events", async () => {
  const f = fixture(); f.transaction.value = 0n;
  f.transaction.data = iface.encodeFunctionData("registerTask", [id("task"), 2, id("project"), 3, 120n]);
  f.receipt.logs = [f.log("TaskRegistered", [id("task"), 2, id("project"), 3, 120n], 0), f.log("TaskActivityChanged", [id("task"), true], 1)];
  assert.equal((await f.verify()).events[0].data.projectId, id("project"));
  f.receipt.logs[1] = f.log("TaskActivityChanged", [id("task"), false], 1);
  await assert.rejects(f.verify, { code: "TASK_CALL_MISMATCH" });
  f.transaction.data = iface.encodeFunctionData("setTaskActive", [id("task"), false]);
  f.receipt.logs = [f.log("TaskActivityChanged", [id("task"), false], 0)];
  assert.deepEqual((await f.verify()).events[0].data, { taskId: id("task"), active: false });
  f.receipt.logs = [];
  await assert.rejects(f.verify, { code: "TASK_ACTIVITY_EVENT_REQUIRED" });
  f.receipt.logs = [f.log("TaskActivityChanged", [id("task"), true], 0)];
  await assert.rejects(f.verify, { code: "TASK_CALL_MISMATCH" });
  f.transaction.data = iface.encodeFunctionData("allocateRemaining", [f.permit.donationId]); f.receipt.logs = [];
  assert.deepEqual((await f.verify()).events, []);
  f.transaction.data = iface.encodeFunctionData("refundUnallocated", [id("refund"), f.permit.donationId, 15n]);
  f.receipt.logs = [f.log("DonationRefunded", [id("refund"), f.permit.donationId, wallet, 15n], 0)];
  assert.equal((await f.verify()).events[0].data.refundId, id("refund"));
  f.receipt.logs = [];
  await assert.rejects(f.verify, { code: "REFUND_EVENT_REQUIRED" });
});
