"use strict";

const { Interface, ZeroHash, getAddress, keccak256 } = require("ethers");

const PERMIT = "tuple(bytes32 donationId,address donor,uint8 purpose,bytes32 projectId,uint256 amountWei,uint256 gasReservedWei,bytes32 registrationHash,uint256 nonce,uint256 deadline,uint256 authorizationEpoch,bytes32 feePolicyHash,address registrar)";
const FUNDING_ABI = [
  `function donate(${PERMIT} permit,address registrar,bytes signature) payable`,
  "function registerTask(bytes32 taskId,uint8 purpose,bytes32 projectId,uint8 urgency,uint256 targetWei)",
  "function setTaskActive(bytes32 taskId,bool active)",
  "function allocateRemaining(bytes32 donationId)",
  "function refundUnallocated(bytes32 refundId,bytes32 donationId,uint256 amountWei)",
  "event DonationReceived(bytes32 indexed donationId,address indexed donor,uint8 purpose,bytes32 projectId,uint256 amountWei,uint256 gasReservedWei,bytes32 registrationHash,bytes32 feePolicyHash)",
  "event TaskRegistered(bytes32 indexed taskId,uint8 purpose,bytes32 projectId,uint8 urgency,uint256 targetWei)",
  "event TaskActivityChanged(bytes32 indexed taskId,bool active)",
  "event DonationAllocated(bytes32 indexed donationId,bytes32 indexed taskId,uint256 amountWei)",
  "event DonationRefunded(bytes32 indexed refundId,bytes32 indexed donationId,address indexed recipient,uint256 amountWei)"
];
const iface = new Interface(FUNDING_ABI);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) fail(code); }
function hash(value) { check(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && value !== ZeroHash, "INVALID_CHAIN_HASH"); return value.toLowerCase(); }
function address(value) { try { const result = getAddress(value).toLowerCase(); check(!/^0x0{40}$/.test(result), "INVALID_CHAIN_ADDRESS"); return result; } catch (_) { fail("INVALID_CHAIN_ADDRESS"); } }
function position(value) { check(Number.isSafeInteger(value) && value >= 0, "INVALID_CHAIN_POSITION"); return value; }
function quantity(value) { check(typeof value === "bigint" && value >= 0n && value < (1n << 256n), "INVALID_CHAIN_AMOUNT"); return value; }
function same(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function project(value) { return value === ZeroHash ? null : hash(value); }
function matchesIntent(record, permit, chainId, pool) {
  if (record.chainId !== chainId || !same(record.poolAddress, pool) || !record.permit) return false;
  const expected = record.permit;
  for (const key of ["donationId", "donor", "projectId", "registrationHash", "feePolicyHash", "registrar"]) {
    if (!same(expected[key], permit[key])) return false;
  }
  if (!Number.isInteger(expected.purpose) || expected.purpose < 0 || expected.purpose > 5 || BigInt(expected.purpose) !== permit.purpose) return false;
  for (const key of ["amountWei", "gasReservedWei", "nonce", "deadline", "authorizationEpoch"]) {
    const value = expected[key];
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) !== permit[key]) return false;
  }
  return true;
}

// No RPC URL, deployment, signing key or public mutation route is supplied here.
// The indexer must pin a reviewed deployed runtime hash and resolve registrations
// from immutable private donation intents, never from a client's request body.
// This verifies one transaction, not gap-free scanning or long-lived reorg recovery.
function createFundingReceiptVerifier({ provider, chainId, poolAddress, runtimeCodeHash, confirmations, resolveRegistration }) {
  check(typeof chainId === "string" && /^[1-9][0-9]*$/.test(chainId), "INVALID_CHAIN_CONFIGURATION");
  const chain = BigInt(chainId), pool = address(poolAddress), runtimeHash = hash(runtimeCodeHash);
  check(Number.isSafeInteger(confirmations) && confirmations >= 1, "INVALID_CONFIRMATIONS");
  check(typeof resolveRegistration === "function", "REGISTRATION_RESOLVER_REQUIRED");

  async function verify(txHash) {
    const requestedHash = hash(txHash);
    check((await provider.getNetwork()).chainId === chain, "CHAIN_MISMATCH");
    const receipt = await provider.getTransactionReceipt(requestedHash);
    check(receipt, "TRANSACTION_PENDING");
    check(receipt.status === 1, "TRANSACTION_REVERTED");
    check(same(receipt.hash, requestedHash) && address(receipt.to) === pool, "RECEIPT_MISMATCH");
    const number = position(receipt.blockNumber), blockHash = hash(receipt.blockHash), index = position(receipt.index);
    const transaction = await provider.getTransaction(requestedHash);
    check(transaction && same(transaction.hash, requestedHash) && transaction.chainId === chain &&
      transaction.blockNumber === number && same(transaction.blockHash, blockHash) &&
      address(transaction.to) === pool && same(transaction.from, receipt.from), "TRANSACTION_MISMATCH");
    const block = await provider.getBlock(number), head = await provider.getBlock("latest");
    check(block && same(block.hash, blockHash) && block.number === number && Array.isArray(block.transactions) &&
      same(block.transactions[index], requestedHash), "CANONICAL_BLOCK_MISMATCH");
    check(head && position(head.number) >= number && head.number - number + 1 >= confirmations, "CONFIRMATIONS_PENDING");
    const code = await provider.getCode(pool, number);
    check(typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code) && same(keccak256(code), runtimeHash), "RUNTIME_CODE_MISMATCH");
    let call;
    try { call = iface.parseTransaction({ data: transaction.data, value: transaction.value }); } catch (_) { fail("UNSUPPORTED_FUNDING_CALL"); }
    check(call, "UNSUPPORTED_FUNDING_CALL");
    check(same(iface.encodeFunctionData(call.fragment, call.args), transaction.data), "NONCANONICAL_FUNDING_CALL");
    check(quantity(transaction.value) === (call.name === "donate" ? call.args.permit.amountWei : 0n), "TRANSACTION_VALUE_MISMATCH");
    check(Array.isArray(receipt.logs) && receipt.logs.length <= 1000, "INVALID_RECEIPT_LOGS");
    const decoded = []; let lastIndex = -1;
    for (const log of receipt.logs) {
      const logIndex = position(log.index);
      check(logIndex > lastIndex && log.removed !== true && log.blockNumber === number && same(log.blockHash, blockHash) &&
        same(log.transactionHash, requestedHash) && log.transactionIndex === index, "LOG_POSITION_MISMATCH");
      lastIndex = logIndex;
      if (address(log.address) !== pool) continue;
      let parsed;
      try { parsed = iface.parseLog(log); } catch (_) { fail("INVALID_FUNDING_LOG"); }
      check(parsed, "UNKNOWN_POOL_EVENT");
      const canonical = iface.encodeEventLog(parsed.fragment, parsed.args);
      check(same(canonical.data, log.data) && Array.isArray(log.topics) && canonical.topics.length === log.topics.length &&
        canonical.topics.every((topic, n) => same(topic, log.topics[n])), "NONCANONICAL_FUNDING_LOG");
      decoded.push({ name: parsed.name, args: parsed.args, index: logIndex });
    }
    const allowed = { donate: ["DonationReceived", "DonationAllocated"], registerTask: ["TaskRegistered", "TaskActivityChanged"],
      setTaskActive: ["TaskActivityChanged"], allocateRemaining: ["DonationAllocated"], refundUnallocated: ["DonationRefunded"] }[call.name];
    check(allowed && decoded.every(event => allowed.includes(event.name)), "EVENT_CALL_MISMATCH");
    const count = name => decoded.filter(event => event.name === name).length;
    check(call.name !== "donate" || count("DonationReceived") === 1 && decoded[0]?.name === "DonationReceived", "DONATION_EVENT_REQUIRED");
    check(call.name !== "registerTask" || decoded.length === 2 && decoded[0]?.name === "TaskRegistered" && decoded[1]?.name === "TaskActivityChanged", "TASK_EVENT_REQUIRED");
    check(call.name !== "setTaskActive" || decoded.length === 1 && decoded[0]?.name === "TaskActivityChanged", "TASK_ACTIVITY_EVENT_REQUIRED");
    check(call.name !== "refundUnallocated" || decoded.length === 1, "REFUND_EVENT_REQUIRED");
    const normalized = [];
    for (const event of decoded) {
      const d = event.args; let data;
      if (event.name === "DonationReceived") {
        const permit = call.args.permit;
        check(same(permit.registrar, call.args.registrar), "DONATION_CALL_MISMATCH");
        for (const field of ["donationId", "purpose", "projectId", "amountWei", "gasReservedWei", "registrationHash", "feePolicyHash"]) {
          check(d[field] === permit[field], "DONATION_CALL_MISMATCH");
        }
        check(same(d.donor, permit.donor) && same(d.donor, transaction.from), "DONATION_CALL_MISMATCH");
        const registration = await resolveRegistration(hash(d.donationId));
        check(registration && typeof registration.userId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(registration.userId) &&
          same(registration.wallet, d.donor) && same(registration.registrationHash, d.registrationHash), "REGISTRATION_LINK_MISMATCH");
        check(matchesIntent(registration, permit, chainId, pool), "DONATION_INTENT_MISMATCH");
        data = { donationId: hash(d.donationId), donorUserId: registration.userId, donorWallet: address(d.donor),
          purpose: Number(d.purpose), projectId: project(d.projectId), amountWei: d.amountWei.toString(), gasReservedWei: d.gasReservedWei.toString() };
      } else if (event.name === "TaskRegistered") {
        for (const field of ["taskId", "purpose", "projectId", "urgency", "targetWei"]) check(d[field] === call.args[field], "TASK_CALL_MISMATCH");
        data = { taskId: hash(d.taskId), purpose: Number(d.purpose), projectId: project(d.projectId) };
      } else if (event.name === "TaskActivityChanged") {
        check(d.taskId === call.args.taskId && d.active === (call.name === "registerTask" ? true : call.args.active), "TASK_CALL_MISMATCH");
        if (call.name === "registerTask") continue;
        data = { taskId: hash(d.taskId), active: d.active };
      } else if (event.name === "DonationAllocated") {
        check(d.donationId === (call.name === "donate" ? call.args.permit.donationId : call.args.donationId), "ALLOCATION_CALL_MISMATCH");
        data = { donationId: hash(d.donationId), taskId: hash(d.taskId), amountWei: d.amountWei.toString() };
      } else if (event.name === "DonationRefunded") {
        check(d.refundId === call.args.refundId && d.donationId === call.args.donationId && d.amountWei === call.args.amountWei &&
          same(d.recipient, transaction.from), "REFUND_CALL_MISMATCH");
        data = { refundId: hash(d.refundId), donationId: hash(d.donationId), recipient: address(d.recipient), amountWei: d.amountWei.toString() };
      }
      normalized.push({ type: event.name, chainId, poolAddress: pool, txHash: requestedHash, blockHash,
        blockNumber: number, transactionIndex: index, logIndex: event.index, data });
    }
    // Recheck after async private record lookups; a changed network or canonical
    // block cannot be committed merely because it matched at the beginning.
    const finalBlock = await provider.getBlock(number), finalHead = await provider.getBlock("latest");
    check((await provider.getNetwork()).chainId === chain && finalBlock && same(finalBlock.hash, blockHash), "CHAIN_CHANGED_DURING_VERIFICATION");
    check(finalHead && position(finalHead.number) >= number && finalHead.number - number + 1 >= confirmations, "CONFIRMATIONS_PENDING");
    return { events: normalized, transactionHash: requestedHash, blockNumber: number, blockHash, confirmations: finalHead.number - number + 1 };
  }
  return { verify };
}

module.exports = { FUNDING_ABI, createFundingReceiptVerifier };
