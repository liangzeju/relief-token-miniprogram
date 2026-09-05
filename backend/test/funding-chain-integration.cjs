"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { id, keccak256 } = require("ethers");
const { fixture, sent } = require("./helpers/donation-ledger-fixture.cjs");
const { createFundingReceiptVerifier } = require("../funding-receipts");
const { createFundingIndexer } = require("../funding-indexer");
const { createFundingStore } = require("../funding-store");
const { createDonationIntentStore } = require("../donation-intent-store");

test("local EVM receipts link authorized donation and task flow to durable private funding ledger", { timeout: 120000 }, async t => {
  const f = await fixture(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-chain-ledger-"));
  let store = createFundingStore({ file: path.join(directory, "funding.sqlite"), chainId: "1337", poolAddress: f.address });
  const intentOptions = { file: path.join(directory, "donation-intents.sqlite"), chainId: "1337", poolAddress: f.address };
  let intents = createDonationIntentStore(intentOptions);
  t.after(() => { store.close(); intents.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("relief-chain-ledger-")); fs.rmSync(directory, { recursive: true, force: true }); });
  const verifierOptions = { provider: f.provider, chainId: "1337", poolAddress: f.address,
    runtimeCodeHash: keccak256(await f.provider.getCode(f.address)), confirmations: 1, resolveRegistration: async key => intents.get(key) };
  const verifier = createFundingReceiptVerifier(verifierOptions);
  async function ingest(receipt) {
    const result = await verifier.verify(receipt.hash);
    store.append(result.events, { expectedVersion: store.read().storeVersion }); return result;
  }
  await ingest(await f.register("medical", 2, id("project-a"), 3, 100n));
  await ingest(await f.register("water", 1, id("project-a"), 2, 60n));
  const initialPermit = await f.permit({ purpose: 1, projectId: id("project-a"), amountWei: 100n, gasReservedWei: 10n });
  const terms = Object.fromEntries(Object.entries(initialPermit).filter(([key]) => !["donor", "registrationHash"].includes(key))
    .map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
  assert.equal(terms.feePolicyHash, id("LOCAL_TEST_POLICY_ONLY"));
  const profile = { id: "private-registered-user", name: "Private Chain Person", email: "private.chain@example.invalid",
    organization: "Private Chain Organization", wallet: f.donor.address, registeredAt: "2026-09-01T00:00:00.000Z",
    emailVerified: false, emailTestVerified: false, emailTestVerifiedAt: null, emailVerificationMode: "local-test" };
  const prepared = await intents.prepare({ profile, terms });
  const historical = structuredClone(prepared);
  const permit = historical.permit;
  assert.equal(historical.userId, profile.id);
  assert.equal(historical.wallet.toLowerCase(), f.donor.address.toLowerCase());
  assert.equal(historical.chainId, "1337");
  assert.equal(historical.poolAddress.toLowerCase(), f.address.toLowerCase());
  assert.equal(historical.registrationHash, permit.registrationHash);
  assert.equal(historical.profile.name, profile.name);
  assert.equal(historical.profile.email, profile.email);
  assert.equal(historical.profile.emailVerified, false);
  assert.equal(historical.profile.emailVerificationMode, "local-test");
  assert.ok(historical.salt);
  assert.ok(historical.createdAt);
  assert.notEqual(permit.registrationHash, initialPermit.registrationHash);
  for (const key of ["amountWei", "gasReservedWei", "nonce", "deadline", "authorizationEpoch"]) {
    assert.equal(permit[key], terms[key]); assert.equal(typeof permit[key], "string");
  }
  profile.name = "Changed Current Name"; profile.email = "changed.current@example.invalid";
  profile.organization = "Changed Current Organization"; profile.wallet = f.other.address;
  assert.deepEqual(intents.get(permit.donationId), historical);
  intents.close(); intents = createDonationIntentStore(intentOptions);
  assert.deepEqual(intents.get(permit.donationId), historical);
  const receipt = await f.donate(permit), normalized = await ingest(receipt);
  assert.equal(normalized.events.length, 2);
  assert.equal(normalized.events[1].data.taskId, id("water"));
  const privateLedgerEvents = JSON.stringify(normalized.events);
  for (const privateValue of [historical.profile.name, historical.profile.email, historical.profile.organization,
    historical.salt, historical.registrationHash, profile.name, profile.email, profile.organization]) {
    assert.equal(privateLedgerEvents.includes(privateValue), false);
  }
  for (const event of normalized.events) {
    for (const privateKey of ["profile", "salt", "registrationHash", "name", "email", "organization", "emailVerified", "emailTestVerified"]) {
      assert.equal(Object.hasOwn(event.data, privateKey), false);
    }
  }
  const before = store.read();
  assert.equal(before.donations[0].donorUserId, "private-registered-user");
  assert.equal(before.donations[0].availableWei, "30"); assert.equal(before.donations[0].gasReservedWei, "10");
  assert.equal(before.allocations[0].availableWei, "60"); assert.equal(before.payments.length, 0);
  assert.equal(store.append(normalized.events, { expectedVersion: 0 }).replayed, true);
  const refund = await sent(f.ledger.connect(f.donor).refundUnallocated(id("refund-one"), permit.donationId, 20n));
  await ingest(refund);
  assert.equal(store.read().totals.balanceWei, (await f.provider.getBalance(f.address)).toString());
  assert.equal(store.read().totals.refundedWei, "20"); assert.equal(store.read().totals.availableWei, "10");
  const stable = store.read(); store.close(); intents.close();
  store = createFundingStore({ file: path.join(directory, "funding.sqlite"), chainId: "1337", poolAddress: f.address });
  intents = createDonationIntentStore(intentOptions);
  assert.deepEqual(store.read(), stable);
  assert.deepEqual(intents.get(permit.donationId), historical);
  assert.deepEqual((await verifier.verify(receipt.hash)).events, normalized.events);
  const missingLookup = createFundingReceiptVerifier({ ...verifierOptions, resolveRegistration: async () => null });
  await assert.rejects(() => missingLookup.verify(receipt.hash), { code: "REGISTRATION_LINK_MISMATCH" });
  assert.deepEqual(intents.get(permit.donationId), historical);
  assert.deepEqual(store.read(), stable);
});

test("durable indexer discovers confirmed local EVM task, donation, allocation and activity events", { timeout: 120000 }, async t => {
  const f = await fixture(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-chain-indexer-"));
  const store = createFundingStore({ file: path.join(directory, "funding.sqlite"), chainId: "1337", poolAddress: f.address });
  const intents = createDonationIntentStore({ file: path.join(directory, "donation-intents.sqlite"), chainId: "1337", poolAddress: f.address });
  const deployment = await f.ledger.deploymentTransaction().wait(); let indexer;
  t.after(() => {
    try { indexer?.close(); } finally { store.close(); intents.close(); }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-chain-indexer-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await f.register("medical-indexed", 2, id("project-indexed"), 3, 100n);
  const original = await f.permit({ purpose: 2, projectId: id("project-indexed"), amountWei: 100n, gasReservedWei: 10n });
  const terms = Object.fromEntries(Object.entries(original).filter(([key]) => !["donor", "registrationHash"].includes(key))
    .map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
  const prepared = intents.prepare({ profile: { id: "indexed-user", name: "Indexed User", email: "indexed@example.invalid",
    organization: "Indexer Test", wallet: f.donor.address, registeredAt: "2026-09-01T00:00:00.000Z",
    emailVerified: false, emailTestVerified: false, emailTestVerifiedAt: null, emailVerificationMode: "local-test" }, terms });
  await f.donate(prepared.permit);
  indexer = createFundingIndexer({ provider: f.provider, chainId: "1337", poolAddress: f.address,
    runtimeCodeHash: keccak256(await f.provider.getCode(f.address)), confirmations: 1, startBlock: deployment.blockNumber,
    range: 16, file: path.join(directory, "indexer.sqlite"), fundingStore: store,
    resolveRegistration: async donationId => intents.get(donationId) });
  await indexer.scanOnce();
  let state = store.read();
  assert.equal(state.donations[0].donorUserId, "indexed-user"); assert.equal(state.donations[0].allocatedWei, "90");
  assert.equal(state.tasks[0].status, "OPEN");
  await sent(f.ledger.connect(f.operator).setTaskActive(id("medical-indexed"), false));
  await indexer.scanOnce(); state = store.read();
  assert.equal(state.tasks[0].status, "PAUSED"); assert.equal(indexer.status().throughBlock, await f.provider.getBlockNumber());
});
