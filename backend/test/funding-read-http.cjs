"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { id, Wallet } = require("ethers");
const { DatabaseSync } = require("node:sqlite");
const { fixture } = require("./helpers/funding-read-fixture.cjs");
const route = "/v1/funding/admin/donations", own = "/v1/funding/me/donations";

test("actual server exposes an authenticated unconfigured view without inventing a zero balance or creating funding files", async t => {
  const f = await fixture({ configured: false }); t.after(f.close);
  assert.equal((await f.request(null, route)).status, 401);
  assert.equal((await f.request({ admin: true }, route)).status, 401);
  const result = await f.request(f.admin, route);
  assert.equal(result.status, 200); assert.equal(result.json.data.connection.configured, false);
  assert.equal(result.json.data.connection.live, false); assert.equal(result.json.data.summary, null);
  assert.deepEqual(result.json.data.items, []);
  assert.equal(fs.existsSync(path.join(f.directory, "funding")), false);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.match(result.headers.get("vary"), /Cookie/);
  assert.equal((await f.request(f.admin, route, {})).status, 405);
  assert.equal((await f.request(f.admin, route, undefined, { Origin: "https://other.invalid" })).status, 403);
  await f.request(f.admin, "/v1/admin/logout", {});
  assert.equal((await f.request(f.admin, route)).status, 401);
});

test("prepared identity and exact recorded funds are separate, scoped, filtered and privately detailed", async t => {
  const f = await fixture(); t.after(f.close);
  const alice = await f.user("Alice"), bob = await f.user("Bob");
  const a = f.prepare(alice, "alice-recorded"), pending = f.prepare(alice, "alice-prepared", { purpose: 2 }), b = f.prepare(bob, "bob-recorded");
  f.received(a); f.received(b);
  const result = (await f.request(f.admin, route)).json.data;
  assert.equal(result.summary.recordedCount, 2); assert.equal(result.summary.preparedCount, 1);
  assert.equal(result.summary.donatedWei, "200000000000000000002");
  assert.equal(result.summary.availableWei, "200000000000000000000");
  assert.equal(result.summary.gasReservedWei, "2");
  assert.equal(result.connection.live, false);
  assert.equal(JSON.stringify(result).includes(alice.user.email), false);
  for (const key of ["salt", "nonce", "password", "registrationHash"]) assert.equal(JSON.stringify(result).includes(`"${key}"`), false);
  const filtered = (await f.request(f.admin, route + "?status=PREPARED&purpose=2&limit=1")).json.data;
  assert.equal(filtered.pagination.total, 1); assert.equal(filtered.items[0].id, pending.permit.donationId);
  assert.deepEqual(filtered.summary, result.summary);
  const page1 = (await f.request(f.admin, route + "?limit=1&offset=0")).json.data;
  const page2 = (await f.request(f.admin, route + "?limit=1&offset=1")).json.data;
  assert.notEqual(page1.items[0].id, page2.items[0].id);
  assert.equal((await f.request(f.admin, route + "?q=" + a.permit.donationId)).json.data.items.length, 1);
  const detail = (await f.request(f.admin, route + "/" + a.permit.donationId)).json.data;
  assert.equal(detail.profile.email, alice.user.email); assert.equal(detail.profile.emailVerified, false);
  assert.equal(detail.registrationHash, a.registrationHash); assert.equal(detail.balances.availableWei, "100000000000000000000");
  assert.equal(detail.salt, undefined); assert.equal(detail.permit, undefined);
  const preparedDetail = (await f.request(f.admin, route + "/" + pending.permit.donationId)).json.data;
  assert.equal(preparedDetail.balances, null); assert.equal(preparedDetail.txHash, null); assert.deepEqual(preparedDetail.activity, []);
  assert.equal((await f.request(alice, route)).status, 401);
  const mine = (await f.request(alice, own)).json.data;
  assert.equal(mine.items.length, 2); assert.equal(mine.summary.recordedCount, 1); assert.equal(mine.summary.donatedWei, a.permit.amountWei);
  assert.equal((await f.request(alice, own + "/" + b.permit.donationId)).status, 404);
  const originalWallet = alice.wallet;
  await f.bind(alice, Wallet.createRandom()); await f.bind(bob, originalWallet);
  assert.equal((await f.request(bob, own + "/" + a.permit.donationId)).status, 404);
  assert.equal((await f.request(alice, own + "/" + a.permit.donationId)).json.data.profile.wallet, a.wallet);
});

test("donation timeline shows FIFO source amounts and excludes another donor's payment in the same contract", async t => {
  const f = await fixture(); t.after(f.close);
  const alice = await f.user("Alice"), bob = await f.user("Bob");
  const a = f.prepare(alice, "first", { amountWei: "100", gasReservedWei: "0" });
  const b = f.prepare(bob, "second", { amountWei: "100", gasReservedWei: "0" });
  f.received(a); f.received(b);
  const taskId = id("task"), contractId = id("contract"), recipient = "0x" + "44".repeat(20);
  f.append("TaskRegistered", { taskId, purpose: 1, projectId: id("project") });
  for (const record of [b, a]) f.append("DonationAllocated", { taskId, donationId: record.permit.donationId, amountWei: "100" });
  f.append("ContractLocked", { contractId, taskId, recipient, amountWei: "200" });
  f.append("BatchPaid", { paymentId: id("pay1"), contractId, batchId: id("batch1"), recipient, amountWei: "50" });
  f.append("BatchPaid", { paymentId: id("pay2"), contractId, batchId: id("batch2"), recipient, amountWei: "80" });
  const detail = (await f.request(bob, own + "/" + b.permit.donationId)).json.data;
  assert.deepEqual(detail.activity.filter(item => item.type === "BatchPaid").map(item => item.amountWei), ["30"]);
  assert.deepEqual(detail.payments.map(item => item.amountWei), ["30"]);
  assert.deepEqual(detail.activity.filter(item => item.type === "ContractLocked").map(item => item.amountWei), ["100"]);
  assert.equal(detail.balances.spentWei, "30"); assert.equal(detail.balances.lockedWei, "70");
  f.append("ContractClosed", { contractId, releasedWei: "70" });
  f.append("TaskClosed", { taskId, releasedWei: "70" });
  f.append("DonationRefunded", { refundId: id("refund"), donationId: b.permit.donationId, recipient: b.wallet, amountWei: "70" });
  const closed = (await f.request(bob, own + "/" + b.permit.donationId)).json.data;
  assert.equal(closed.balances.refundedWei, "70"); assert.equal(closed.refunds[0].amountWei, "70");
  assert.equal(closed.activity.at(-1).type, "DonationRefunded");
  const prior = f.funding.read();
  f.funding.replaceFromBlock({ fromBlock: 7, events: [], expectedVersion: prior.storeVersion, reason: "Isolated verified reorg fixture" });
  const rewound = (await f.request(bob, own + "/" + b.permit.donationId)).json.data;
  assert.deepEqual(rewound.payments, []); assert.equal(rewound.activity.some(item => item.type === "BatchPaid"), false);
});

test("query validation and unavailable or inconsistent private records fail closed without disclosing identity", async t => {
  const f = await fixture(); t.after(f.close);
  const alice = await f.user("Alice"), record = f.prepare(alice, "record"); f.received(record);
  for (const query of ["limit=0", "limit=101", "offset=-1", "offset=01", "limit=1&limit=2", "q=alice@example.test", "purpose=6", "status=CONFIRMED", "unknown=1"]) {
    const response = await f.request(f.admin, route + "?" + query); assert.equal(response.status, 400, query);
    assert.equal(response.json.error.code, "INVALID_FUNDING_QUERY");
  }
  assert.equal((await f.request(f.admin, route + "/bad")).status, 400);
  assert.equal((await f.request(f.admin, route + "/" + id("missing"))).status, 404);
  f.append("DonationReceived", { donationId: id("missing-intent"), donorUserId: alice.user.id, donorWallet: alice.user.wallet,
    amountWei: "1", gasReservedWei: "0", purpose: 1, projectId: null });
  const orphan = await f.request(f.admin, route);
  assert.equal(orphan.status, 503); assert.equal(orphan.json.error.code, "FUNDING_RECORDS_UNAVAILABLE");
  assert.equal(orphan.json.data, null); assert.equal(JSON.stringify(orphan.json).includes(alice.user.email), false);
  const raw = new DatabaseSync(path.join(f.directory, "funding/donation-intents.sqlite"));
  raw.exec("DROP TRIGGER donation_intents_no_update"); raw.close();
  assert.equal((await f.request(f.admin, route)).status, 503);
});

test("an orphaned donation is not disguised as a never-submitted preparation and retains its original receipt", async t => {
  const f = await fixture(); t.after(f.close);
  const donor = await f.user("Donor"), record = f.prepare(donor, "reorged"); f.received(record);
  const original = (await f.request(f.admin, route + "/" + record.permit.donationId)).json.data;
  f.funding.replaceFromBlock({ fromBlock: 1, events: [], expectedVersion: 1, reason: "Verified orphan block test" });
  const list = (await f.request(f.admin, route + "?status=REORGED")).json.data;
  assert.equal(list.items[0].status, "REORGED"); assert.equal(list.summary.reorgedCount, 1);
  assert.equal(list.summary.preparedCount, 0); assert.equal(list.summary.donatedWei, "0");
  const detail = (await f.request(donor, own + "/" + record.permit.donationId)).json.data;
  assert.equal(detail.balances, null); assert.deepEqual(detail.activity, []);
  assert.equal(detail.orphanedReceipts[0].txHash, original.txHash);
  f.received(record);
  const recovered = (await f.request(donor, own)).json.data;
  assert.equal(recovered.items[0].status, "RECORDED"); assert.equal(recovered.summary.reorgedCount, 0);
  assert.equal(recovered.summary.donatedWei, record.permit.amountWei);
});

test("public pool publishes only exact recorded aggregates without identity, pending amounts or donation IDs", async t => {
  const f = await fixture(); t.after(f.close);
  const a = await f.user("Alice"), b = await f.user("Bob");
  const first = f.prepare(a, "public-a"), second = f.prepare(b, "public-b");
  f.prepare(a, "never-recorded", { amountWei: "999999999999999999999999" });
  f.received(first); f.received(second);
  const response = await f.request(null, "/v1/funding/pool"), data = response.json.data;
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(data).sort(), ["connection", "projectionVersion", "summary"]);
  assert.equal(data.summary.donorCount, 2); assert.equal(data.summary.donatedWei, "200000000000000000002");
  for (const privateValue of [a.user.id, a.user.name, a.user.email, a.user.wallet, first.salt, first.permit.donationId, second.permit.donationId]) {
    assert.equal(JSON.stringify(data).includes(privateValue), false);
  }
  assert.equal(data.summary.preparedCount, undefined);
  const ownDetail = (await f.request(a, own + "/" + first.permit.donationId)).json.data;
  assert.equal(ownDetail.accountSummary.donatedWei, first.permit.amountWei);
  assert.equal((await f.request(null, "/v1/funding/pool?q=Alice")).status, 400);
  assert.equal((await f.request(null, "/v1/funding/pool", {})).status, 405);
  f.funding.replaceFromBlock({ fromBlock: 2, events: [], expectedVersion: 2, reason: "Verified public projection rollback" });
  const next = (await f.request(null, "/v1/funding/pool")).json.data;
  assert.equal(next.summary.donorCount, 1); assert.equal(next.summary.donatedWei, first.permit.amountWei);
});
