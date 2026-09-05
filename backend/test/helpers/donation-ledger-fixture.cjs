'use strict';

const assert = require('node:assert/strict');
const ganache = require('ganache');
const { BrowserProvider, ContractFactory, Wallet, ZeroHash, id } = require('ethers');
const { compileDonationLedger } = require('../../scripts/compile-donation-ledger.cjs');

const permitTypes = { DonationPermit: [
  { name: 'donationId', type: 'bytes32' }, { name: 'donor', type: 'address' },
  { name: 'purpose', type: 'uint8' }, { name: 'projectId', type: 'bytes32' },
  { name: 'amountWei', type: 'uint256' }, { name: 'gasReservedWei', type: 'uint256' },
  { name: 'registrationHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'authorizationEpoch', type: 'uint256' },
  { name: 'feePolicyHash', type: 'bytes32' },
  { name: 'registrar', type: 'address' },
] };
const feePolicyHash = id('LOCAL_TEST_POLICY_ONLY');
const sent = async (transaction) => (await transaction).wait();
let cachedArtifact;
const getArtifact = () => (cachedArtifact ||= compileDonationLedger());

async function reverts(action, expected) {
  await assert.rejects(async () => {
    const result = await action();
    if (result?.wait) await result.wait();
  }, (error) => {
    assert.equal(error.code, 'CALL_EXCEPTION', error.message);
    if (expected) assert.equal(error.revert?.name, expected, error.shortMessage || error.message);
    return true;
  });
}

async function fixture(t, { roles = true } = {}) {
  const artifact = getArtifact();
  const rpc = ganache.provider({
    chain: { chainId: 1337, hardfork: 'merge' },
    logging: { quiet: true },
    miner: { blockGasLimit: 30_000_000 },
    wallet: { totalAccounts: 7, defaultBalance: 100 },
  });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await rpc.disconnect(); });
  const signers = await Promise.all(Array.from({ length: 7 }, (_, i) => provider.getSigner(i)));
  const [admin, donor, other, registrar, operator, allocator, pauser] = signers;
  const registrarWallet = new Wallet(rpc.getInitialAccounts()[registrar.address.toLowerCase()].secretKey);
  const otherWallet = new Wallet(rpc.getInitialAccounts()[other.address.toLowerCase()].secretKey);
  const deploy = async (compiled, ...args) => {
    const contract = await new ContractFactory(compiled.abi, compiled.bytecode, admin).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const ledger = await deploy(artifact, admin.address);
  const address = await ledger.getAddress();
  const domain = { name: 'ReliefFunding', version: '2', chainId: 1337, verifyingContract: address };
  if (roles) {
    for (const [role, signer] of [['REGISTRAR_ROLE', registrar], ['TASK_OPERATOR_ROLE', operator], ['ALLOCATOR_ROLE', allocator], ['PAUSER_ROLE', pauser]]) {
      await sent(ledger.grantRole(await ledger[role](), signer.address));
    }
  }
  let sequence = 0;
  const permit = async (overrides = {}) => {
    const nonce = BigInt(++sequence);
    const block = await provider.getBlock('latest');
    return {
      donationId: id(`donation-${nonce}`), donor: donor.address, purpose: 0, projectId: ZeroHash,
      amountWei: 100n, gasReservedWei: 10n, registrationHash: id(`opaque-salted-registration-${nonce}`),
      nonce, deadline: BigInt(block.timestamp + 3600), authorizationEpoch: await ledger.authorizationEpochs(registrar.address),
      feePolicyHash, registrar: registrar.address, ...overrides,
    };
  };
  const sign = (value, overrides = {}, wallet = registrarWallet) => wallet.signTypedData({ ...domain, ...overrides }, permitTypes, value);
  const donate = async (value, options = {}) => sent(ledger.connect(options.sender || donor).donate(
    value, options.registrar || registrar.address, options.signature || await sign(value),
    { value: value.amountWei, ...options.transaction },
  ));
  const register = (name, purpose = 1, project = id('project-a'), urgency = 1, target = 100n) =>
    sent(ledger.connect(operator).registerTask(id(name), purpose, project, urgency, target));
  const events = (receipt, name) => receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase())
    .map((log) => ledger.interface.parseLog(log)).filter((event) => event?.name === name);
  return { artifact, rpc, provider, admin, donor, other, registrar, operator, allocator, pauser, registrarWallet,
    otherWallet, ledger, address, domain, deploy, permit, sign, donate, register, events };
}

async function accounting(f) {
  const count = await f.ledger.donationCount();
  let donated = 0n; let gas = 0n; let available = 0n; let refunded = 0n;
  for (let i = 0n; i < count; i++) {
    const donation = await f.ledger.donations(await f.ledger.donationIdAt(i));
    donated += donation.amountWei; gas += donation.gasReservedWei;
    available += donation.availableWei; refunded += donation.refundedWei;
    assert.ok(donation.gasReservedWei + donation.availableWei + donation.refundedWei <= donation.amountWei);
  }
  assert.equal(await f.ledger.totalDonatedWei(), donated);
  assert.equal(await f.ledger.totalGasReservedWei(), gas);
  assert.equal(await f.ledger.totalAvailableWei(), available);
  assert.equal(await f.ledger.totalRefundedWei(), refunded);
  assert.equal(donated, gas + available + refunded + await f.ledger.totalAllocatedWei());
  assert.equal(await f.ledger.accountedBalanceWei(), donated - refunded);
  assert.equal(await f.provider.getBalance(f.address), donated - refunded);
}

module.exports = { getArtifact, fixture, permitTypes, feePolicyHash, sent, reverts, accounting };
