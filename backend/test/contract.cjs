'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const ganache = require('ganache');
const solc = require('solc');
const { BrowserProvider, ContractFactory, Interface, ZeroAddress, ZeroHash, id, keccak256 } = require('ethers');
const { compileContract, artifactPath } = require('../scripts/compile-contract.cjs');

const artifact = compileContract({ write: false });
const iface = new Interface(artifact.abi);
const key = (name) => id(name);
const sent = async (transaction) => (await transaction).wait();
const events = (receipt, name) => receipt.logs.map((log) => {
  try { return iface.parseLog(log); } catch { return null; }
}).filter((event) => event && event.name === name);

async function reverts(action, errorName) {
  await assert.rejects(async () => {
    const result = await action();
    if (result && result.wait) await result.wait();
  }, (error) => {
    if (!errorName) return error.code === 'CALL_EXCEPTION';
    assert.equal(error.revert?.name, errorName, error.shortMessage || error.message);
    return true;
  });
}

async function fixture(t) {
  const rpc = ganache.provider({
    chain: { chainId: 1337, hardfork: 'merge' },
    logging: { quiet: true },
    wallet: { totalAccounts: 6, defaultBalance: 100 },
  });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await rpc.disconnect(); });
  const signers = await Promise.all(Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
  const [owner, donor, other, recipient, alternate] = signers;
  const pool = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy(owner.address);
  await pool.waitForDeployment();
  const address = await pool.getAddress();
  const configure = (name, purpose, urgency, target, active = true, receiver = recipient.address) =>
    sent(pool.configureTask(key(name), purpose, urgency, target, receiver, active));
  const donate = (name, purpose, value) => sent(pool.connect(donor).donate(key(name), purpose, { value }));
  const balance = (account) => provider.getBalance(account);
  return { rpc, provider, owner, donor, other, recipient, alternate, pool, address, configure, donate, balance };
}

async function accounting(f) {
  const tasks = await f.pool.getTasks();
  assert.equal(tasks.reduce((sum, task) => sum + task.allocatedWei, 0n), await f.pool.totalAllocatedWei());
  assert.equal(tasks.reduce((sum, task) => sum + task.releasedWei, 0n), await f.pool.totalReleasedWei());
  for (const task of tasks) {
    assert.ok(task.releasedWei <= task.allocatedWei);
    assert.ok(task.allocatedWei <= task.targetWei);
  }
  assert.equal(await f.balance(f.address),
    await f.pool.totalDonatedWei() - await f.pool.totalReleasedWei() - await f.pool.totalRefundedWei());
}

test('artifact ABI, deployed runtime and owner are exact', async (t) => {
  assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), artifact, 'Persisted artifact is stale');
  assert.match(artifact.bytecode, /^0x(?:[0-9a-f]{2})+$/);
  assert.match(artifact.deployedBytecode, /^0x(?:[0-9a-f]{2})+$/);
  assert.equal(artifact.compiler.evmVersion, 'paris');
  assert.deepEqual(iface.deploy.inputs.map((v) => [v.name, v.type]), [['initialOwner', 'address']]);
  assert.deepEqual(iface.getFunction('getTasks').outputs[0].arrayChildren.components.map((v) => [v.name, v.type]), [
    ['id', 'bytes32'], ['purpose', 'uint8'], ['urgency', 'uint8'], ['targetWei', 'uint256'],
    ['allocatedWei', 'uint256'], ['releasedWei', 'uint256'], ['recipient', 'address'], ['active', 'bool'],
  ]);
  assert.deepEqual(iface.getFunction('donations').outputs.map((v) => [v.name, v.type]), [
    ['donor', 'address'], ['purpose', 'uint8'], ['amountWei', 'uint256'], ['unallocatedWei', 'uint256'],
  ]);
  for (const signature of [
    'configureTask(bytes32,uint8,uint8,uint256,address,bool)', 'donate(bytes32,uint8)',
    'allocateRemaining(bytes32)', 'releaseTask(bytes32,uint256)', 'refundUnallocated(bytes32)',
  ]) assert.equal(iface.getFunction(signature).format('sighash'), signature);
  const f = await fixture(t);
  assert.equal(await f.pool.owner(), f.owner.address);
  assert.equal(await f.provider.getCode(f.address), artifact.deployedBytecode);
  assert.equal(keccak256(await f.provider.getCode(f.address)), keccak256(artifact.deployedBytecode));
  const second = await new ContractFactory(artifact.abi, artifact.bytecode, f.owner).deploy(f.other.address);
  await second.waitForDeployment();
  assert.equal(await second.owner(), f.other.address);
  assert.equal(await f.provider.getCode(await second.getAddress()), artifact.deployedBytecode);
});

test('purpose filter, stable priority, split, inactive tasks and escrow', async (t) => {
  const f = await fixture(t);
  await f.configure('low', 1, 1, 100n);
  await f.configure('wrong-purpose', 2, 3, 100n);
  await f.configure('high-first', 1, 3, 30n);
  await f.configure('high-second', 1, 3, 40n);
  await f.configure('middle', 1, 2, 50n);
  await f.configure('inactive', 1, 3, 100n, false);
  const before = await f.balance(f.recipient.address);
  const receipt = await f.donate('filtered', 1, 90n);
  assert.deepEqual(events(receipt, 'DonationAllocated').map((v) => [v.args.taskId, v.args.amountWei]),
    [[key('high-first'), 30n], [key('high-second'), 40n], [key('middle'), 20n]]);
  const received = events(receipt, 'DonationReceived')[0].args;
  assert.deepEqual(Array.from(received), [key('filtered'), f.donor.address, 1n, 90n]);
  assert.equal(events(receipt, 'DonationUnallocated').length, 0);
  assert.equal(await f.balance(f.recipient.address), before);
  assert.equal(await f.balance(f.address), 90n);
  const unrestricted = await f.donate('any-purpose', 0, 125n);
  assert.deepEqual(events(unrestricted, 'DonationAllocated').map((v) => [v.args.taskId, v.args.amountWei]),
    [[key('wrong-purpose'), 100n], [key('middle'), 25n]]);
  assert.equal((await f.pool.getTasks())[5].allocatedWei, 0n);
  await accounting(f);
});

test('excess refund belongs only to donor, keeps ID consumed and preserves allocated escrow', async (t) => {
  const f = await fixture(t);
  await f.configure('budget', 5, 3, 50n);
  const receipt = await f.donate('excess', 5, 80n);
  assert.equal(events(receipt, 'DonationUnallocated')[0].args.amountWei, 30n);
  assert.deepEqual(Array.from(await f.pool.donations(key('excess'))), [f.donor.address, 5n, 80n, 30n]);
  await reverts(() => f.pool.connect(f.other).refundUnallocated.staticCall(key('excess')), 'NotDonor');
  const donorBefore = await f.balance(f.donor.address);
  const refund = await sent(f.pool.connect(f.donor).refundUnallocated(key('excess')));
  assert.deepEqual(Array.from(events(refund, 'DonationRefunded')[0].args), [key('excess'), f.donor.address, 30n]);
  assert.equal(await f.balance(f.donor.address), donorBefore + 30n - refund.fee);
  assert.equal(await f.pool.totalRefundedWei(), 30n);
  assert.equal(await f.balance(f.address), 50n);
  assert.equal((await f.pool.donations(key('excess'))).unallocatedWei, 0n);
  await reverts(() => f.pool.connect(f.donor).refundUnallocated.staticCall(key('excess')), 'InvalidAmount');
  await reverts(() => f.pool.connect(f.other).donate.staticCall(key('excess'), 0, { value: 1n }), 'DuplicateDonation');
  await f.configure('new-budget', 5, 3, 100n);
  assert.equal(events(await sent(f.pool.allocateRemaining(key('excess'))), 'DonationAllocated').length, 0);
  await accounting(f);
});

test('permissionless reallocation respects original purpose and current priority', async (t) => {
  const f = await fixture(t);
  await f.donate('waiting', 2, 100n);
  await f.configure('wrong', 1, 3, 100n);
  await f.configure('paused', 2, 3, 100n, false);
  await f.configure('later-low', 2, 1, 20n);
  await f.configure('later-high', 2, 3, 30n);
  const receipt = await sent(f.pool.connect(f.other).allocateRemaining(key('waiting')));
  assert.deepEqual(events(receipt, 'DonationAllocated').map((v) => [v.args.taskId, v.args.amountWei]),
    [[key('later-high'), 30n], [key('later-low'), 20n]]);
  assert.equal((await f.pool.donations(key('waiting'))).unallocatedWei, 50n);
  await f.configure('later-high', 2, 3, 80n);
  await sent(f.pool.connect(f.other).allocateRemaining(key('waiting')));
  assert.equal((await f.pool.donations(key('waiting'))).unallocatedWei, 0n);
  assert.equal(await f.pool.totalDonatedWei(), 100n);
  assert.equal(await f.pool.totalAllocatedWei(), 100n);
  await f.donate('unrestricted-wait', 0, 200n);
  await f.configure('new-purpose', 4, 2, 150n);
  await sent(f.pool.connect(f.other).allocateRemaining(key('unrestricted-wait')));
  assert.equal((await f.pool.getTasks())[4].allocatedWei, 100n);
  await accounting(f);
});

test('release authorization, fixed recipient, lifetime budget and rollback on over-release', async (t) => {
  const f = await fixture(t);
  await f.configure('release', 3, 2, 60n);
  await f.configure('release', 3, 2, 60n, true, f.alternate.address);
  await f.donate('release-lot', 3, 60n);
  await reverts(() => f.pool.connect(f.other).releaseTask.staticCall(key('release'), 1n), 'OwnableUnauthorizedAccount');
  await reverts(() => f.pool.configureTask.staticCall(key('release'), 3, 2, 59n, f.alternate.address, true), 'TargetBelowAllocated');
  await reverts(() => f.pool.configureTask.staticCall(key('release'), 3, 2, 60n, f.recipient.address, true), 'RecipientLocked');
  const before = await f.balance(f.alternate.address);
  const release = await sent(f.pool.releaseTask(key('release'), 25n));
  assert.deepEqual(Array.from(events(release, 'TaskReleased')[0].args), [key('release'), f.alternate.address, 25n]);
  assert.equal(await f.balance(f.alternate.address), before + 25n);
  await reverts(() => f.pool.releaseTask.staticCall(key('release'), 36n), 'InvalidAmount');
  await sent(f.pool.releaseTask(key('release'), 35n));
  await reverts(() => f.pool.releaseTask.staticCall(key('release'), 1n), 'InvalidAmount');
  await reverts(() => f.pool.configureTask.staticCall(key('release'), 3, 2, 60n, f.recipient.address, true), 'RecipientLocked');
  await f.donate('budget-not-replenished', 3, 10n);
  assert.equal((await f.pool.donations(key('budget-not-replenished'))).unallocatedWei, 10n);
  assert.equal((await f.pool.getTasks())[0].allocatedWei, 60n);
  await accounting(f);
});

test('invalid inputs, owner checks, unique IDs, direct payment rejection and 32-task cap', async (t) => {
  const f = await fixture(t);
  await reverts(() => f.pool.connect(f.other).configureTask.staticCall(key('x'), 1, 1, 1n, f.recipient.address, true), 'OwnableUnauthorizedAccount');
  for (const [taskId, purpose, urgency, recipient, error] of [
    [ZeroHash, 1, 1, f.recipient.address, 'InvalidId'],
    [key('x'), 0, 1, f.recipient.address, 'InvalidPurpose'],
    [key('x'), 6, 1, f.recipient.address, 'InvalidPurpose'],
    [key('x'), 1, 0, f.recipient.address, 'InvalidUrgency'],
    [key('x'), 1, 4, f.recipient.address, 'InvalidUrgency'],
    [key('x'), 1, 1, ZeroAddress, 'InvalidRecipient'],
  ]) await reverts(() => f.pool.configureTask.staticCall(taskId, purpose, urgency, 1n, recipient, true), error);
  await reverts(() => f.pool.donate.staticCall(ZeroHash, 0, { value: 1n }), 'InvalidId');
  await reverts(() => f.pool.donate.staticCall(key('x'), 6, { value: 1n }), 'InvalidPurpose');
  await reverts(() => f.pool.donate.staticCall(key('x'), 0), 'InvalidAmount');
  await reverts(() => f.pool.allocateRemaining.staticCall(key('unknown')), 'UnknownDonation');
  await reverts(() => f.pool.refundUnallocated.staticCall(key('unknown')), 'UnknownDonation');
  await reverts(() => f.pool.releaseTask.staticCall(key('unknown'), 1n), 'UnknownTask');
  for (const value of [0n, 1n]) await reverts(() => f.owner.sendTransaction({ to: f.address, value, gasLimit: 100000 }));
  await reverts(() => f.owner.sendTransaction({ to: f.address, data: '0x12345678', gasLimit: 100000 }));
  for (let i = 0; i < 32; i++) await f.configure(`cap-${i}`, 1 + i % 5, 1 + i % 3, 1n);
  assert.equal((await f.pool.getTasks()).length, 32);
  await reverts(() => f.pool.configureTask.staticCall(key('cap-32'), 1, 1, 1n, f.recipient.address, true), 'TaskLimitReached');
  await f.configure('cap-0', 1, 3, 2n);
  await reverts(() => f.pool.releaseTask.staticCall(key('cap-0'), 0n), 'InvalidAmount');
  await f.donate('all-32', 0, 34n);
  await reverts(() => f.pool.connect(f.other).donate.staticCall(key('all-32'), 0, { value: 1n }), 'DuplicateDonation');
  assert.equal(await f.pool.totalAllocatedWei(), 33n);
  assert.equal((await f.pool.donations(key('all-32'))).unallocatedWei, 1n);
  await accounting(f);
});

// This real EVM recipient exercises payout failure and callbacks into the pool.
const receiverSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IPool {
  function donate(bytes32, uint8) external payable;
  function refundUnallocated(bytes32) external;
}
contract Receiver {
  address public pool;
  bytes public payload;
  bool public rejectPayment;
  bool public callbackSucceeded;
  function setup(address p, bytes calldata data, bool reject) external {
    pool = p; payload = data; rejectPayment = reject;
  }
  function sendDonation(bytes32 donationId) external payable {
    IPool(pool).donate{value: msg.value}(donationId, 5);
  }
  function refund(bytes32 donationId) external { IPool(pool).refundUnallocated(donationId); }
  function execute(bytes calldata data) external {
    (bool ok,) = pool.call(data); require(ok, "execute failed");
  }
  receive() external payable {
    require(!rejectPayment, "payment rejected");
    (callbackSucceeded,) = pool.call(payload);
  }
}`;

test('failed transfers roll back and refund/release callbacks cannot reenter', async (t) => {
  const f = await fixture(t);
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'Receiver.sol': { content: receiverSource } },
    settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  assert.equal((output.errors || []).filter((e) => e.severity === 'error').length, 0);
  const compiled = output.contracts['Receiver.sol'].Receiver;
  const receiver = await new ContractFactory(compiled.abi, `0x${compiled.evm.bytecode.object}`, f.owner).deploy();
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  const refundPayload = iface.encodeFunctionData('refundUnallocated', [key('callback-refund')]);
  await sent(receiver.setup(f.address, refundPayload, true));
  await sent(receiver.sendDonation(key('callback-refund'), { value: 40n }));
  await reverts(() => receiver.refund(key('callback-refund'), { gasLimit: 500000 }));
  assert.equal((await f.pool.donations(key('callback-refund'))).unallocatedWei, 40n);
  assert.equal(await f.pool.totalRefundedWei(), 0n);
  await sent(receiver.setup(f.address, refundPayload, false));
  await sent(receiver.refund(key('callback-refund')));
  assert.equal(await receiver.callbackSucceeded(), false);
  assert.equal(await f.balance(receiverAddress), 40n);
  assert.equal(await f.pool.totalRefundedWei(), 40n);
  await f.configure('callback-task', 1, 3, 50n, true, receiverAddress);
  await f.donate('callback-release', 1, 50n);
  const releasePayload = iface.encodeFunctionData('releaseTask', [key('callback-task'), 10n]);
  await sent(receiver.setup(f.address, releasePayload, true));
  await reverts(() => f.pool.releaseTask(key('callback-task'), 10n, { gasLimit: 500000 }));
  assert.equal((await f.pool.getTasks())[0].releasedWei, 0n);
  assert.equal(await f.pool.totalReleasedWei(), 0n);
  await sent(f.pool.transferOwnership(receiverAddress));
  await sent(receiver.setup(f.address, releasePayload, false));
  await sent(receiver.execute(releasePayload));
  assert.equal(await receiver.callbackSucceeded(), false);
  assert.equal((await f.pool.getTasks())[0].releasedWei, 10n);
  assert.equal(await f.balance(receiverAddress), 50n);
  await accounting(f);
});
