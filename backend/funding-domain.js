"use strict";

const { getAddress } = require("ethers");

// Projection of normalized, verified chain events. This module does not verify RPC
// receipts, registration permits or acceptance signatures and must not be exposed
// as a public mutation API. Only the chain adapter may supply these facts.
const MAX_WEI = (1n << 256n) - 1n;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) fail(code); }
function record(value, allowed) {
  check(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, "INVALID_RECORD");
  check(Object.keys(value).every(key => allowed.includes(key)), "UNKNOWN_FIELD");
}
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") { check(Number.isSafeInteger(value), "INVALID_NUMBER"); return value; }
  check(value && typeof value === "object" && !ancestors.has(value), "INVALID_DATA");
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, "INVALID_DATA");
  ancestors.add(value); const output = Array.isArray(value) ? [] : {};
  const keys = Reflect.ownKeys(value); check(keys.every(key => typeof key === "string"), "INVALID_DATA");
  if (!Array.isArray(value)) keys.sort();
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "INVALID_DATA");
    if (Array.isArray(value)) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length, "INVALID_DATA");
    Object.defineProperty(output, key, { value: json(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  if (Array.isArray(value)) check(Object.keys(output).length === value.length, "INVALID_DATA");
  ancestors.delete(value); return output;
}
function id(value) { check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value), "INVALID_ID"); return value; }
function wei(value, minimum = 0n) {
  check(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "INVALID_WEI");
  const n = BigInt(value); check(n >= minimum && n <= MAX_WEI, "INVALID_WEI"); return n;
}
function integer(value) { check(Number.isSafeInteger(value) && value >= 0, "INVALID_POSITION"); return value; }
function hash(value) { check(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value), "INVALID_HASH"); return value.toLowerCase(); }
function wallet(value) { try { const address = getAddress(value); check(!/^0x0{40}$/i.test(address), "INVALID_WALLET"); return address.toLowerCase(); } catch (_) { fail("INVALID_WALLET"); } }
function purpose(value, any = false) { check(Number.isSafeInteger(value) && value >= (any ? 0 : 1) && value <= 5, "INVALID_PURPOSE"); return value; }
function project(value) { return value === null ? null : id(value); }
function compare(a, b) { return a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex; }
function sum(values) { return values.reduce((total, value) => total + BigInt(value), 0n); }
function change(object, field, delta) { const result = BigInt(object[field]) + delta; check(result >= 0n && result <= MAX_WEI, "BALANCE_OUT_OF_RANGE"); object[field] = result.toString(); }
function find(items, value, code) { const item = items.find(entry => entry.id === value); check(item, code); return item; }
function unused(items, value) { id(value); check(!items.some(item => item.id === value), "DUPLICATE_BUSINESS_ID"); }
function availableForTask(state, taskId) { return state.allocations.filter(item => item.taskId === taskId && BigInt(item.availableWei) > 0n).sort((a, b) => compare(find(state.donations, a.donationId), find(state.donations, b.donationId))); }
function sourcesFrom(items, amount, field) {
  let remaining = amount; const sources = [];
  for (const item of items) {
    const balance = BigInt(item[field]); const take = balance < remaining ? balance : remaining;
    if (take > 0n) sources.push({ donationId: item.donationId, amountWei: take.toString() });
    remaining -= take; if (remaining === 0n) break;
  }
  check(remaining === 0n, "INSUFFICIENT_ELIGIBLE_FUNDS"); return sources;
}

function createFundingDomain(initial, options) {
  const config = json(options); record(config, ["chainId", "poolAddress"]);
  const chainId = wei(config.chainId, 1n).toString(), poolAddress = wallet(config.poolAddress);
  let state = { donations: [], tasks: [], allocations: [], contracts: [], payments: [], refunds: [], events: [] };
  let journal = [];
  function normalize(raw) {
    const event = json(raw);
    record(event, ["type", "chainId", "poolAddress", "txHash", "blockHash", "blockNumber", "transactionIndex", "logIndex", "data"]);
    check(typeof event.type === "string" && Object.hasOwn(handlers, event.type), "UNKNOWN_EVENT");
    check(wei(event.chainId, 1n).toString() === chainId && wallet(event.poolAddress) === poolAddress, "CHAIN_OR_POOL_MISMATCH");
    return { ...event, chainId, poolAddress, txHash: hash(event.txHash), blockHash: hash(event.blockHash), blockNumber: integer(event.blockNumber), transactionIndex: integer(event.transactionIndex), logIndex: integer(event.logIndex) };
  }
  function eventRef(event) { return { txHash: event.txHash, blockHash: event.blockHash, blockNumber: event.blockNumber, transactionIndex: event.transactionIndex, logIndex: event.logIndex }; }
  function matches(donation, task) { return (donation.purpose === 0 || donation.purpose === task.purpose) && (donation.projectId === null || donation.projectId === task.projectId); }
  function contractSources(s, contract) {
    return contract.sources.slice().sort((a, b) => compare(find(s.donations, a.donationId), find(s.donations, b.donationId)));
  }
  function invariant(s) {
    for (const donation of s.donations) {
      const allocated = sum(s.allocations.filter(item => item.donationId === donation.id).map(item => item.availableWei));
      const locked = sum(s.contracts.flatMap(item => item.sources.filter(source => source.donationId === donation.id).map(source => source.remainingWei)));
      const paid = sum(s.payments.flatMap(item => item.sources.filter(source => source.donationId === donation.id).map(source => source.amountWei)));
      const refunded = sum(s.refunds.filter(item => item.donationId === donation.id).map(item => item.amountWei));
      check(BigInt(donation.amountWei) === BigInt(donation.availableWei) + BigInt(donation.gasReservedWei) + allocated + locked + paid + refunded, "SOURCE_CONSERVATION_FAILED");
    }
    for (const contract of s.contracts) {
      const paid = sum(s.payments.filter(item => item.contractId === contract.id).map(item => item.amountWei));
      check(BigInt(contract.amountWei) === paid + BigInt(contract.releasedWei) + sum(contract.sources.map(source => source.remainingWei)), "CONTRACT_CONSERVATION_FAILED");
    }
  }
  const handlers = {
    DonationReceived(s, event) {
      const d = event.data; record(d, ["donationId", "donorUserId", "donorWallet", "purpose", "projectId", "amountWei", "gasReservedWei"]);
      unused(s.donations, d.donationId); id(d.donorUserId);
      const amount = wei(d.amountWei, 1n), reserve = wei(d.gasReservedWei); check(reserve <= amount, "GAS_RESERVE_EXCEEDS_DONATION");
      s.donations.push({ id: d.donationId, donorUserId: d.donorUserId, donorWallet: wallet(d.donorWallet), purpose: purpose(d.purpose, true), projectId: project(d.projectId), amountWei: amount.toString(), gasReservedWei: reserve.toString(), availableWei: (amount - reserve).toString(), ...eventRef(event) });
    },
    TaskRegistered(s, event) {
      const d = event.data; record(d, ["taskId", "purpose", "projectId"]); unused(s.tasks, d.taskId);
      s.tasks.push({ id: d.taskId, purpose: purpose(d.purpose), projectId: project(d.projectId), status: "OPEN", ...eventRef(event) });
    },
    TaskActivityChanged(s, event) {
      const d = event.data; record(d, ["taskId", "active"]); check(typeof d.active === "boolean", "INVALID_TASK_ACTIVITY");
      const task = find(s.tasks, d.taskId, "TASK_NOT_FOUND"); check(task.status !== "CLOSED", "TASK_CLOSED");
      task.status = d.active ? "OPEN" : "PAUSED";
    },
    DonationAllocated(s, event) {
      const d = event.data; record(d, ["donationId", "taskId", "amountWei"]);
      const donation = find(s.donations, d.donationId, "DONATION_NOT_FOUND"), task = find(s.tasks, d.taskId, "TASK_NOT_FOUND");
      check(task.status === "OPEN", "TASK_CLOSED"); check(matches(donation, task), "DONATION_RESTRICTION_MISMATCH");
      const amount = wei(d.amountWei, 1n); change(donation, "availableWei", -amount);
      let allocation = s.allocations.find(item => item.taskId === task.id && item.donationId === donation.id);
      if (!allocation) { allocation = { taskId: task.id, donationId: donation.id, availableWei: "0" }; s.allocations.push(allocation); }
      change(allocation, "availableWei", amount);
    },
    ContractLocked(s, event) {
      const d = event.data; record(d, ["contractId", "taskId", "recipient", "amountWei"]); unused(s.contracts, d.contractId);
      const task = find(s.tasks, d.taskId, "TASK_NOT_FOUND"); check(task.status === "OPEN", "TASK_CLOSED");
      const amount = wei(d.amountWei, 1n), allocations = availableForTask(s, task.id);
      const sources = sourcesFrom(allocations, amount, "availableWei");
      for (const source of sources) change(allocations.find(item => item.donationId === source.donationId), "availableWei", -BigInt(source.amountWei));
      s.contracts.push({ id: d.contractId, taskId: task.id, recipient: wallet(d.recipient), amountWei: amount.toString(), releasedWei: "0", status: "LOCKED", sources: sources.map(source => ({ ...source, remainingWei: source.amountWei })), ...eventRef(event) });
    },
    BatchPaid(s, event) {
      const d = event.data; record(d, ["paymentId", "contractId", "batchId", "recipient", "amountWei"]); unused(s.payments, d.paymentId); id(d.batchId);
      check(!s.payments.some(item => item.contractId === d.contractId && item.batchId === d.batchId), "BATCH_ALREADY_PAID");
      const contract = find(s.contracts, d.contractId, "CONTRACT_NOT_FOUND"); check(contract.status === "LOCKED", "CONTRACT_CLOSED");
      check(wallet(d.recipient) === contract.recipient, "RECIPIENT_MISMATCH");
      const amount = wei(d.amountWei, 1n), sources = sourcesFrom(contractSources(s, contract), amount, "remainingWei");
      for (const source of sources) change(contract.sources.find(item => item.donationId === source.donationId), "remainingWei", -BigInt(source.amountWei));
      s.payments.push({ id: d.paymentId, contractId: contract.id, batchId: d.batchId, taskId: contract.taskId, recipient: contract.recipient, amountWei: amount.toString(), sources, ...eventRef(event) });
    },
    ContractClosed(s, event) {
      const d = event.data; record(d, ["contractId", "releasedWei"]);
      const contract = find(s.contracts, d.contractId, "CONTRACT_NOT_FOUND"); check(contract.status === "LOCKED", "CONTRACT_CLOSED");
      const remaining = sum(contract.sources.map(item => item.remainingWei)); check(wei(d.releasedWei) === remaining, "RELEASE_AMOUNT_MISMATCH");
      for (const source of contract.sources) {
        const allocation = s.allocations.find(item => item.taskId === contract.taskId && item.donationId === source.donationId);
        change(allocation, "availableWei", BigInt(source.remainingWei)); source.remainingWei = "0";
      }
      contract.releasedWei = remaining.toString(); contract.status = "CLOSED";
    },
    TaskClosed(s, event) {
      const d = event.data; record(d, ["taskId", "releasedWei"]);
      const task = find(s.tasks, d.taskId, "TASK_NOT_FOUND"); check(task.status !== "CLOSED", "TASK_CLOSED");
      check(!s.contracts.some(item => item.taskId === task.id && item.status !== "CLOSED"), "OPEN_CONTRACT_OBLIGATIONS");
      const allocations = s.allocations.filter(item => item.taskId === task.id);
      check(wei(d.releasedWei) === sum(allocations.map(item => item.availableWei)), "RELEASE_AMOUNT_MISMATCH");
      for (const allocation of allocations) { change(find(s.donations, allocation.donationId), "availableWei", BigInt(allocation.availableWei)); allocation.availableWei = "0"; }
      task.status = "CLOSED";
    },
    DonationRefunded(s, event) {
      const d = event.data; record(d, ["refundId", "donationId", "recipient", "amountWei"]); unused(s.refunds, d.refundId);
      const donation = find(s.donations, d.donationId, "DONATION_NOT_FOUND");
      check(wallet(d.recipient) === donation.donorWallet, "REFUND_OWNER_MISMATCH");
      const amount = wei(d.amountWei, 1n); change(donation, "availableWei", -amount);
      s.refunds.push({ id: d.refundId, donationId: donation.id, recipient: donation.donorWallet, amountWei: amount.toString(), ...eventRef(event) });
    }
  };
  function apply(raw) {
    const event = normalize(raw), duplicate = journal.find(item => item.txHash === event.txHash && item.logIndex === event.logIndex);
    if (duplicate) { check(JSON.stringify(duplicate) === JSON.stringify(event), "EVENT_CONFLICT"); return { replayed: true, version: journal.length }; }
    const last = journal[journal.length - 1];
    if (last) {
      check(compare(last, event) < 0, "EVENT_ORDER_VIOLATION");
      if (last.blockNumber === event.blockNumber) {
        check(last.blockHash === event.blockHash, "BLOCK_HASH_CONFLICT");
        check(event.logIndex > last.logIndex, "EVENT_ORDER_VIOLATION");
      }
      if (last.blockNumber === event.blockNumber && last.transactionIndex === event.transactionIndex) check(last.txHash === event.txHash, "TRANSACTION_HASH_CONFLICT");
    }
    const transaction = journal.find(item => item.txHash === event.txHash);
    if (transaction) check(transaction.blockNumber === event.blockNumber && transaction.blockHash === event.blockHash && transaction.transactionIndex === event.transactionIndex, "TRANSACTION_HASH_CONFLICT");
    const next = json(state); handlers[event.type](next, event); invariant(next);
    next.events.push({ type: event.type, ...eventRef(event) }); state = next; journal.push(event);
    return { replayed: false, version: journal.length };
  }
  function snapshot() {
    const result = json(state);
    result.donations = result.donations.map(donation => ({ ...donation,
      allocatedWei: sum(state.allocations.filter(item => item.donationId === donation.id).map(item => item.availableWei)).toString(),
      lockedWei: sum(state.contracts.flatMap(item => item.sources.filter(source => source.donationId === donation.id).map(source => source.remainingWei))).toString(),
      spentWei: sum(state.payments.flatMap(item => item.sources.filter(source => source.donationId === donation.id).map(source => source.amountWei))).toString(),
      refundedWei: sum(state.refunds.filter(item => item.donationId === donation.id).map(item => item.amountWei)).toString() }));
    const totals = {};
    for (const field of ["amountWei", "gasReservedWei", "availableWei", "allocatedWei", "lockedWei", "spentWei", "refundedWei"]) totals[field] = sum(result.donations.map(item => item[field])).toString();
    totals.balanceWei = (BigInt(totals.amountWei) - BigInt(totals.spentWei) - BigInt(totals.refundedWei)).toString();
    return { ...result, chainId, poolAddress, version: journal.length, totals };
  }
  function previewPayment(contractId, amountWei) {
    const contract = find(state.contracts, id(contractId), "CONTRACT_NOT_FOUND"); check(contract.status === "LOCKED", "CONTRACT_CLOSED");
    return { contractId, amountWei: wei(amountWei, 1n).toString(), sources: sourcesFrom(contractSources(state, contract), wei(amountWei, 1n), "remainingWei"), version: journal.length };
  }
  if (initial !== undefined) {
    const replay = json(initial); record(replay, ["schemaVersion", "events"]); check(replay.schemaVersion === 1 && Array.isArray(replay.events), "INVALID_JOURNAL");
    for (const event of replay.events) apply(event);
  }
  return { apply, snapshot, previewPayment, exportState: () => ({ schemaVersion: 1, events: json(journal) }) };
}

module.exports = { createFundingDomain };
