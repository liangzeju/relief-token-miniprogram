'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Interface, TypedDataEncoder, ZeroHash, id, toUtf8Bytes, hexlify } = require('ethers');
const { getArtifact, fixture, permitTypes, feePolicyHash, sent, reverts, accounting } = require('./helpers/donation-ledger-fixture.cjs');

test('compiler returns only a local harness; base remains abstract and ABI stays frozen', async (t) => {
  const artifact = getArtifact();
  assert.equal(artifact.testOnly, true);
  assert.equal(artifact.productionDeployable, false);
  assert.equal(artifact.production.bytecode, '0x');
  assert.equal(artifact.production.deployedBytecode, '0x');
  assert.equal(artifact.harness.feePolicy, 'LOCAL_TEST_POLICY_ONLY');
  assert.equal(artifact.compiler.evmVersion, 'paris');
  assert.equal(typeof artifact.immutableReferences, 'object');
  const iface = new Interface(artifact.abi);
  assert.deepEqual(iface.getFunction('donate').inputs[0].components.map(({ name, type }) => ({ name, type })), permitTypes.DonationPermit);
  assert.deepEqual(iface.getFunction('donations').outputs.map((v) => v.name), [
    'donor', 'purpose', 'projectId', 'amountWei', 'gasReservedWei', 'availableWei', 'refundedWei', 'registrationHash', 'feePolicyHash', 'sequence',
  ]);
  assert.deepEqual(iface.getFunction('tasks').outputs.map((v) => v.name), [
    'id', 'purpose', 'projectId', 'urgency', 'targetWei', 'allocatedWei', 'sequence', 'active', 'closed',
  ]);
  const f = await fixture(t, { roles: false });
  assert.equal(await f.ledger.defaultAdmin(), f.admin.address);
  assert.equal(await f.ledger.defaultAdminDelay(), 172800n);
  for (const role of ['REGISTRAR_ROLE', 'TASK_OPERATOR_ROLE', 'ALLOCATOR_ROLE', 'PAUSER_ROLE']) {
    assert.equal(await f.ledger.hasRole(await f.ledger[role](), f.admin.address), false);
  }
  const runtime = (await f.provider.getCode(f.address)).slice(2).split('');
  const expected = artifact.deployedBytecode.slice(2).split('');
  for (const references of Object.values(artifact.immutableReferences)) {
    for (const { start, length } of references) {
      runtime.fill('0', start * 2, (start + length) * 2);
      expected.fill('0', start * 2, (start + length) * 2);
    }
  }
  assert.equal(runtime.join(''), expected.join(''));
  await sent(f.ledger.beginDefaultAdminTransfer(f.other.address));
  await reverts(() => f.ledger.connect(f.other).acceptDefaultAdminTransfer.staticCall(), 'AccessControlEnforcedDefaultAdminDelay');
  await f.rpc.request({ method: 'evm_increaseTime', params: [172801] });
  await f.rpc.request({ method: 'evm_mine', params: [] });
  await sent(f.ledger.connect(f.other).acceptDefaultAdminTransfer());
  assert.equal(await f.ledger.defaultAdmin(), f.other.address);
});

test('EIP-712 hash and signature bind every permit field, chain, pool, name and version', async (t) => {
  const f = await fixture(t);
  const value = await f.permit();
  const domainMetadata = await f.ledger.eip712Domain();
  assert.deepEqual(Array.from(domainMetadata).slice(0, 6), ['0x0f', 'ReliefFunding', '2', 1337n, f.address, ZeroHash]);
  assert.deepEqual(Array.from(domainMetadata.extensions), []);
  assert.equal(await f.ledger.donationPermitHash(value), TypedDataEncoder.hash(f.domain, permitTypes, value));
  const signature = await f.sign(value);
  const mutations = {
    donationId: id('different-id'), donor: f.other.address, purpose: 1, projectId: id('project-b'),
    amountWei: 101n, gasReservedWei: 11n, registrationHash: id('different-registration'), nonce: 999n,
    deadline: value.deadline + 1n, authorizationEpoch: 1n, feePolicyHash: id('other-policy'), registrar: f.other.address,
  };
  for (const [field, replacement] of Object.entries(mutations)) {
    const changed = { ...value, [field]: replacement };
    const sender = field === 'donor' ? f.other : f.donor;
    await reverts(() => f.ledger.connect(sender).donate.staticCall(changed, f.registrar.address, signature,
      { value: changed.amountWei }), 'InvalidAuthorization');
    assert.equal(await f.ledger.usedDonationNonces(sender.address, changed.nonce), false, field);
  }
  for (const overrides of [{ chainId: 1338 }, { verifyingContract: f.other.address }, { name: 'ReliefPool' }, { version: '1' }]) {
    const invalid = await f.sign(value, overrides);
    await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, f.registrar.address, invalid, { value: value.amountWei }), 'InvalidAuthorization');
  }
  const second = await f.deploy(f.artifact, f.admin.address);
  await sent(second.grantRole(await second.REGISTRAR_ROLE(), f.registrar.address));
  await reverts(() => second.connect(f.donor).donate.staticCall(value, f.registrar.address, signature, { value: value.amountWei }), 'InvalidAuthorization');
  await f.donate(value, { signature });
  await accounting(f);
});

test('donations reject sender/value mismatch, invalid fields and unsupported local fee policies', async (t) => {
  const f = await fixture(t);
  const value = await f.permit();
  const signature = await f.sign(value);
  await reverts(() => f.ledger.connect(f.other).donate.staticCall(value, f.registrar.address, signature, { value: 100n }), 'NotDonor');
  for (const amount of [0n, 99n, 101n]) {
    await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, f.registrar.address, signature, { value: amount }), 'InvalidAmount');
  }
  for (const [overrides, error] of [
    [{ donationId: ZeroHash }, 'InvalidId'], [{ amountWei: 0n, gasReservedWei: 0n }, 'InvalidAmount'],
    [{ gasReservedWei: 101n }, 'InvalidAmount'], [{ purpose: 6 }, 'InvalidPurpose'],
    [{ registrationHash: ZeroHash }, 'InvalidRegistration'], [{ feePolicyHash: ZeroHash }, 'InvalidFeePolicy'],
  ]) {
    const invalid = { ...value, ...overrides };
    await reverts(() => f.ledger.connect(f.donor).donate.staticCall(invalid, f.registrar.address, signature, { value: invalid.amountWei }), error);
  }
  const wrongPolicy = { ...value, feePolicyHash: id('not-the-local-policy') };
  const wrongPolicySignature = await f.sign(wrongPolicy);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(wrongPolicy, f.registrar.address, wrongPolicySignature, { value: 100n }), 'Error');
  for (const invalid of ['0x', '0x1234', await f.sign(value, {}, f.otherWallet)]) {
    await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, f.registrar.address, invalid, { value: 100n }), 'InvalidAuthorization');
  }
  assert.equal(await f.ledger.donationCount(), 0n);
  await accounting(f);
});

test('deadline, consumed nonces, cancellation and duplicate IDs cannot be replayed', async (t) => {
  const f = await fixture(t);
  const block = await f.provider.getBlock('latest');
  for (const deadline of [BigInt(block.timestamp - 1), BigInt(block.timestamp)]) {
    const expired = await f.permit({ deadline });
    const signature = await f.sign(expired);
    await reverts(() => f.ledger.connect(f.donor).donate.staticCall(expired, f.registrar.address, signature, { value: 100n }), 'AuthorizationExpired');
  }
  const cancelled = await f.permit();
  await sent(f.ledger.connect(f.other).cancelDonationNonce(cancelled.nonce));
  assert.equal(await f.ledger.usedDonationNonces(f.donor.address, cancelled.nonce), false);
  const receipt = await sent(f.ledger.connect(f.donor).cancelDonationNonce(cancelled.nonce));
  assert.deepEqual(Array.from(f.events(receipt, 'DonationNonceCancelled')[0].args), [f.donor.address, cancelled.nonce]);
  const cancelledSignature = await f.sign(cancelled);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(cancelled, f.registrar.address, cancelledSignature, { value: 100n }), 'NonceAlreadyUsed');
  await reverts(() => f.ledger.connect(f.donor).cancelDonationNonce.staticCall(cancelled.nonce), 'NonceAlreadyUsed');
  const value = await f.permit();
  await f.donate(value);
  const sameNonce = await f.permit({ nonce: value.nonce });
  const sameNonceSignature = await f.sign(sameNonce);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(sameNonce, f.registrar.address, sameNonceSignature, { value: 100n }), 'NonceAlreadyUsed');
  const duplicate = await f.permit({ donationId: value.donationId });
  const duplicateSignature = await f.sign(duplicate);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(duplicate, f.registrar.address, duplicateSignature, { value: 100n }), 'DuplicateDonation');
  await accounting(f);
});

test('revocation and renunciation invalidate registrar signatures through regrant', async (t) => {
  const f = await fixture(t);
  const role = await f.ledger.REGISTRAR_ROLE();
  const old = await f.permit();
  const signature = await f.sign(old);
  const revoke = await sent(f.ledger.revokeRole(role, f.registrar.address));
  assert.deepEqual(Array.from(f.events(revoke, 'AuthorizationEpochChanged')[0].args), [f.registrar.address, 1n]);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(old, f.registrar.address, signature, { value: 100n }), 'InvalidAuthorization');
  await sent(f.ledger.revokeRole(role, f.registrar.address));
  assert.equal(await f.ledger.authorizationEpochs(f.registrar.address), 1n);
  await sent(f.ledger.grantRole(role, f.registrar.address));
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(old, f.registrar.address, signature, { value: 100n }), 'InvalidAuthorization');
  await f.donate(await f.permit());
  await sent(f.ledger.connect(f.registrar).renounceRole(role, f.registrar.address));
  assert.equal(await f.ledger.authorizationEpochs(f.registrar.address), 2n);
});

test('ERC-1271 registrar accepts its signer and rejects invalid magic and stale epochs', async (t) => {
  const f = await fixture(t);
  const registrar = await f.deploy(f.artifact.testContracts.registrar, f.registrar.address);
  const address = await registrar.getAddress();
  const value = await f.permit({ registrar: address });
  const signature = await f.sign(value);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, address, signature, { value: 100n }), 'InvalidAuthorization');
  await sent(f.ledger.grantRole(await f.ledger.REGISTRAR_ROLE(), address));
  const invalid = await f.sign(value, {}, f.otherWallet);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, address, invalid, { value: 100n }), 'InvalidAuthorization');
  await f.donate(value, { registrar: address, signature });
  const stale = await f.permit({ registrar: address });
  const staleSignature = await f.sign(stale);
  await sent(f.ledger.revokeRole(await f.ledger.REGISTRAR_ROLE(), address));
  await sent(f.ledger.grantRole(await f.ledger.REGISTRAR_ROLE(), address));
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(stale, address, staleSignature, { value: 100n }), 'InvalidAuthorization');
  const fresh = { ...stale, authorizationEpoch: await f.ledger.authorizationEpochs(address) };
  await f.donate(fresh, { registrar: address, signature: await f.sign(fresh) });
  await accounting(f);
});

test('a revoked EOA permit cannot be replayed through its active ERC-1271 alias', async (t) => {
  const f = await fixture(t);
  const alias = await f.deploy(f.artifact.testContracts.registrar, f.registrar.address);
  const aliasAddress = await alias.getAddress();
  await sent(f.ledger.grantRole(await f.ledger.REGISTRAR_ROLE(), aliasAddress));
  const value = await f.permit();
  const signature = await f.sign(value);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, aliasAddress, signature, { value: 100n }), 'InvalidAuthorization');
  await sent(f.ledger.revokeRole(await f.ledger.REGISTRAR_ROLE(), f.registrar.address));
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(value, aliasAddress, signature, { value: 100n }), 'InvalidAuthorization');
  const altered = { ...value, registrar: aliasAddress };
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(altered, aliasAddress, signature, { value: 100n }), 'InvalidAuthorization');
  const legitimate = await f.permit({ registrar: aliasAddress, authorizationEpoch: 0n });
  await f.donate(legitimate, { registrar: aliasAddress, signature: await f.sign(legitimate) });
  assert.equal(await f.ledger.usedDonationNonces(f.donor.address, value.nonce), false);
  await accounting(f);
});

test('allocation honors purpose/project, urgency and stable registration order after reactivation', async (t) => {
  const f = await fixture(t);
  const project = id('project-a');
  await f.register('low', 1, project, 1, 100n);
  await f.register('high-first', 1, project, 3, 30n);
  await f.register('high-second', 1, project, 3, 40n);
  await f.register('middle', 1, project, 2, 50n);
  await f.register('wrong-purpose', 2, project, 3, 100n);
  await f.register('wrong-project', 1, id('project-b'), 3, 100n);
  await f.register('inactive', 1, project, 3, 100n);
  await sent(f.ledger.connect(f.operator).setTaskActive(id('high-first'), false));
  await f.register('newer-high', 1, project, 3, 10n);
  await sent(f.ledger.connect(f.operator).setTaskActive(id('inactive'), false));
  await sent(f.ledger.connect(f.operator).setTaskActive(id('high-first'), true));
  const value = await f.permit({ purpose: 1, projectId: project, amountWei: 150n });
  const receipt = await f.donate(value);
  const allocations = f.events(receipt, 'DonationAllocated').map((event) => Array.from(event.args));
  assert.deepEqual(allocations, [
    [value.donationId, id('high-first'), 30n], [value.donationId, id('high-second'), 40n],
    [value.donationId, id('newer-high'), 10n], [value.donationId, id('middle'), 50n], [value.donationId, id('low'), 10n],
  ]);
  for (const [, taskId, amount] of allocations) assert.equal(await f.ledger.allocationWei(taskId, value.donationId), amount);
  for (const name of ['wrong-purpose', 'wrong-project', 'inactive']) assert.equal((await f.ledger.tasks(id(name))).allocatedWei, 0n);
  const purposeAny = await f.permit({ purpose: 0, projectId: project, amountWei: 110n });
  assert.deepEqual(f.events(await f.donate(purposeAny), 'DonationAllocated').map((v) => v.args.taskId), [id('wrong-purpose')]);
  const projectAny = await f.permit({ purpose: 1, amountWei: 110n });
  assert.deepEqual(f.events(await f.donate(projectAny), 'DonationAllocated').map((v) => v.args.taskId), [id('wrong-project')]);
  const unrestricted = await f.permit({ amountWei: 20n, gasReservedWei: 0n });
  assert.deepEqual(f.events(await f.donate(unrestricted), 'DonationAllocated').map((v) => v.args.taskId), [id('low')]);
  await accounting(f);
});

test('remaining allocation requires donor or allocator, preserves restrictions and never transfers reserved gas', async (t) => {
  const f = await fixture(t);
  const value = await f.permit({ purpose: 2, projectId: id('project-a') });
  await f.donate(value);
  await f.register('wrong', 1, id('project-a'), 3, 100n);
  await f.register('right', 2, id('project-a'), 1, 40n);
  for (const signer of [f.other, f.admin, f.operator, f.registrar]) {
    await reverts(() => f.ledger.connect(signer).allocateRemaining.staticCall(value.donationId), 'AllocationNotAuthorized');
  }
  await sent(f.ledger.connect(f.donor).allocateRemaining(value.donationId));
  assert.equal(await f.ledger.allocationWei(id('right'), value.donationId), 40n);
  await f.register('later', 2, id('project-a'), 2, 100n);
  await sent(f.ledger.connect(f.allocator).allocateRemaining(value.donationId));
  assert.equal(await f.ledger.allocationWei(id('later'), value.donationId), 50n);
  const again = await sent(f.ledger.connect(f.donor).allocateRemaining(value.donationId));
  assert.equal(f.events(again, 'DonationAllocated').length, 0);
  assert.equal(await f.ledger.totalGasReservedWei(), 10n);
  assert.equal(await f.provider.getBalance(f.address), 100n);
  await reverts(() => f.ledger.connect(f.donor).allocateRemaining.staticCall(id('missing')), 'UnknownDonation');
  await accounting(f);
});

test('task identities are immutable, validation is bounded and freed active slots are reusable', async (t) => {
  const f = await fixture(t);
  const task = [id('invalid'), 1, id('project-a'), 1, 1n];
  for (const [index, value, error] of [
    [0, ZeroHash, 'InvalidId'], [1, 0, 'InvalidPurpose'], [1, 6, 'InvalidPurpose'],
    [2, ZeroHash, 'InvalidProject'], [3, 0, 'InvalidUrgency'], [3, 4, 'InvalidUrgency'], [4, 0n, 'InvalidAmount'],
  ]) {
    const args = [...task]; args[index] = value;
    await reverts(() => f.ledger.connect(f.operator).registerTask.staticCall(...args), error);
  }
  await reverts(() => f.ledger.connect(f.operator).setTaskActive.staticCall(id('missing'), false), 'UnknownTask');
  for (let i = 0; i < 32; i++) await f.register(`capacity-${i}`, 1, id('project-a'), 1, 1n);
  assert.equal(await f.ledger.MAX_ACTIVE_TASKS(), 32n);
  assert.equal((await f.ledger.activeTaskIds()).filter((v) => v !== ZeroHash).length, 32);
  await reverts(() => f.ledger.connect(f.operator).registerTask.staticCall(id('overflow'), 1, id('project-a'), 1, 1n), 'ActiveTaskLimitReached');
  assert.equal((await f.ledger.tasks(id('overflow'))).id, ZeroHash);
  const original = await f.ledger.tasks(id('capacity-0'));
  const deactivated = await sent(f.ledger.connect(f.operator).setTaskActive(id('capacity-0'), false));
  assert.deepEqual(Array.from(f.events(deactivated, 'TaskActivityChanged')[0].args), [id('capacity-0'), false]);
  await f.register('replacement', 1, id('project-a'), 1, 1n);
  assert.equal((await f.ledger.tasks(id('replacement'))).sequence, 33n);
  await reverts(() => f.ledger.connect(f.operator).setTaskActive.staticCall(id('capacity-0'), true), 'ActiveTaskLimitReached');
  await sent(f.ledger.connect(f.operator).setTaskActive(id('capacity-1'), false));
  await sent(f.ledger.connect(f.operator).setTaskActive(id('capacity-0'), true));
  assert.deepEqual(Array.from(await f.ledger.tasks(id('capacity-0'))), Array.from(original));
  await reverts(() => f.ledger.connect(f.operator).registerTask.staticCall(id('capacity-0'), 2, id('new-project'), 3, 500n), 'DuplicateTask');
  const value = await f.permit({ amountWei: 32n, gasReservedWei: 0n });
  const receipt = await f.donate(value);
  const allocatedIds = f.events(receipt, 'DonationAllocated').map((event) => event.args.taskId);
  assert.deepEqual(allocatedIds, [id('capacity-0'), ...Array.from({ length: 30 }, (_, i) => id(`capacity-${i + 2}`)), id('replacement')]);
  await accounting(f);
});

test('business roles, direct transfers and pause boundaries are enforced', async (t) => {
  const f = await fixture(t);
  for (const signer of [f.other, f.admin]) {
    const ledger = f.ledger.connect(signer);
    await reverts(() => ledger.registerTask.staticCall(id('unauthorized'), 1, id('project-a'), 1, 100n), 'AccessControlUnauthorizedAccount');
    await reverts(() => ledger.setTaskActive.staticCall(id('unauthorized'), true), 'AccessControlUnauthorizedAccount');
    await reverts(() => ledger.pause.staticCall(), 'AccessControlUnauthorizedAccount');
    await reverts(() => ledger.unpause.staticCall(), 'AccessControlUnauthorizedAccount');
  }
  const registrarRole = await f.ledger.REGISTRAR_ROLE();
  await reverts(() => f.ledger.connect(f.other).grantRole.staticCall(registrarRole, f.other.address), 'AccessControlUnauthorizedAccount');
  for (const data of ['0x', '0x12345678']) {
    await assert.rejects(f.provider.call({ from: f.donor.address, to: f.address, data, value: 1n }), (error) => {
      assert.equal(f.ledger.interface.parseError(error.data).name, 'DirectPaymentUnsupported'); return true;
    });
  }
  const value = await f.permit();
  await f.donate(value);
  await f.register('paused-task');
  await sent(f.ledger.connect(f.pauser).pause());
  const next = await f.permit(); const signature = await f.sign(next);
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(next, f.registrar.address, signature, { value: 100n }), 'EnforcedPause');
  await reverts(() => f.ledger.connect(f.operator).registerTask.staticCall(id('paused-new'), 1, id('project-a'), 1, 10n), 'EnforcedPause');
  await reverts(() => f.ledger.connect(f.operator).setTaskActive.staticCall(id('paused-task'), false), 'EnforcedPause');
  await reverts(() => f.ledger.connect(f.donor).allocateRemaining.staticCall(value.donationId), 'EnforcedPause');
  await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(id('paused-refund'), value.donationId, 1n), 'EnforcedPause');
  await sent(f.ledger.connect(f.donor).cancelDonationNonce(next.nonce));
  assert.equal(await f.ledger.usedDonationNonces(f.donor.address, next.nonce), true);
  await sent(f.ledger.connect(f.pauser).unpause());
  await reverts(() => f.ledger.connect(f.donor).donate.staticCall(next, f.registrar.address, signature, { value: 100n }), 'NonceAlreadyUsed');
  await sent(f.ledger.connect(f.donor).refundUnallocated(id('resumed-refund'), value.donationId, 1n));
  await f.donate(await f.permit());
  await accounting(f);
});

test('refunds belong to the original donor, preserve reserves/allocations and consume global refund IDs', async (t) => {
  const f = await fixture(t);
  await f.register('budget', 1, id('project-a'), 1, 40n);
  const value = await f.permit();
  await f.donate(value);
  for (const signer of [f.other, f.admin, f.allocator]) {
    await reverts(() => f.ledger.connect(signer).refundUnallocated.staticCall(id('wrong-donor'), value.donationId, 1n), 'NotDonor');
  }
  for (const amount of [0n, 51n, 60n, 100n]) {
    await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(id('bounds'), value.donationId, amount), 'InvalidAmount');
  }
  await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(ZeroHash, value.donationId, 1n), 'InvalidId');
  await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(id('unknown'), id('missing'), 1n), 'UnknownDonation');
  const before = await f.provider.getBalance(f.donor.address);
  const refundId = id('partial-refund');
  const receipt = await sent(f.ledger.connect(f.donor).refundUnallocated(refundId, value.donationId, 20n));
  assert.equal(await f.provider.getBalance(f.donor.address), before + 20n - receipt.fee);
  assert.deepEqual(Array.from(f.events(receipt, 'DonationRefunded')[0].args), [refundId, value.donationId, f.donor.address, 20n]);
  await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(refundId, value.donationId, 1n), 'DuplicateRefund');
  const another = await f.permit(); await f.donate(another);
  await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(refundId, another.donationId, 1n), 'DuplicateRefund');
  await sent(f.ledger.connect(f.donor).refundUnallocated(id('final-refund'), value.donationId, 30n));
  assert.equal((await f.ledger.donations(value.donationId)).refundedWei, 50n);
  assert.equal(await f.ledger.allocationWei(id('budget'), value.donationId), 40n);
  await reverts(() => f.ledger.connect(f.donor).refundUnallocated.staticCall(id('over-refund'), value.donationId, 1n), 'InvalidAmount');
  const reserveOnly = await f.permit({ amountWei: 10n, gasReservedWei: 10n });
  await f.donate(reserveOnly);
  assert.equal((await f.ledger.donations(reserveOnly.donationId)).availableWei, 0n);
  await accounting(f);
});

test('failed refund recipients roll back all effects and reentrant refunds cannot withdraw twice', async (t) => {
  const f = await fixture(t);
  const recipient = await f.deploy(f.artifact.testContracts.refundRecipient, f.address);
  const address = await recipient.getAddress();
  const value = await f.permit({ donor: address });
  await sent(recipient.donate(value, f.registrar.address, await f.sign(value), { value: 100n }));
  await sent(recipient.setMode(1));
  const failedId = id('failed-recipient');
  await reverts(() => recipient.refund(failedId, 20n, { gasLimit: 500000 }));
  assert.equal(await f.ledger.refundIds(failedId), false);
  assert.equal((await f.ledger.donations(value.donationId)).availableWei, 90n);
  assert.equal((await f.ledger.donations(value.donationId)).refundedWei, 0n);
  assert.equal(await f.ledger.totalRefundedWei(), 0n);
  assert.equal(await f.provider.getBalance(address), 0n);
  await accounting(f);
  await sent(recipient.setMode(2));
  await sent(recipient.refund(failedId, 20n));
  assert.equal(await recipient.reentrySucceeded(), false);
  assert.equal(await recipient.reentryError(), id('ReentrancyGuardReentrantCall()').slice(0, 10));
  assert.equal(await f.ledger.refundIds(id('nested-refund')), false);
  assert.equal(await f.provider.getBalance(address), 20n);
  assert.equal((await f.ledger.donations(value.donationId)).availableWei, 70n);
  assert.equal(await f.ledger.totalRefundedWei(), 20n);
  await accounting(f);
});

test('raw logs expose only the frozen opaque commitments and numeric funding data', async (t) => {
  const f = await fixture(t);
  const privateMarker = 'Private Person private.person@example.invalid +15550001234';
  const value = await f.permit({ registrationHash: id(`test-salt:${privateMarker}`) });
  const taskReceipt = await f.register('log-task', 1, id('project-a'), 2, 30n);
  const receipt = await f.donate(value);
  const refund = await sent(f.ledger.connect(f.donor).refundUnallocated(id('log-refund'), value.donationId, 20n));
  const event = f.events(receipt, 'DonationReceived')[0];
  assert.deepEqual(Array.from(event.args), [value.donationId, f.donor.address, 0n, ZeroHash, 100n, 10n, value.registrationHash, feePolicyHash]);
  assert.deepEqual(Array.from(f.events(taskReceipt, 'TaskRegistered')[0].args), [id('log-task'), 1n, id('project-a'), 2n, 30n]);
  assert.equal(await f.ledger.donationCount(), 1n);
  assert.equal(await f.ledger.donationIdAt(0), value.donationId);
  const stored = await f.ledger.donations(value.donationId);
  assert.deepEqual(Array.from(stored), [f.donor.address, 0n, ZeroHash, 100n, 10n, 40n, 20n, value.registrationHash, feePolicyHash, 1n]);
  for (const name of ['DonationReceived', 'TaskRegistered', 'DonationAllocated', 'DonationRefunded', 'DonationNonceCancelled', 'AuthorizationEpochChanged', 'TaskActivityChanged']) {
    assert.ok(f.ledger.interface.getEvent(name).inputs.every((input) => !['string', 'bytes'].includes(input.type)));
  }
  assert.deepEqual(f.ledger.interface.getEvent('DonationReceived').inputs.filter((v) => v.indexed).map((v) => v.name), ['donationId', 'donor']);
  assert.deepEqual(f.ledger.interface.getEvent('DonationRefunded').inputs.filter((v) => v.indexed).map((v) => v.name), ['refundId', 'donationId', 'recipient']);
  for (const log of [...taskReceipt.logs, ...receipt.logs, ...refund.logs]) {
    const raw = `${log.topics.join('')}${log.data}`.toLowerCase();
    for (const marker of ['Private Person', 'private.person@example.invalid', '+15550001234']) {
      assert.equal(raw.includes(hexlify(toUtf8Bytes(marker)).slice(2)), false);
    }
  }
  await accounting(f);
});
