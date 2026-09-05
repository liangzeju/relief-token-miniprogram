"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { keccak256, toUtf8Bytes } = require("ethers");
const { DatabaseSync } = require("node:sqlite");
const { fixture } = require("./helpers/fulfillment-fixture.cjs");

test("registered independent roles deliver, assess partial batches and derive exact payable without recording a payment", { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const delivery = { id: "B-1", contractId: "C-F", quantity: 4, statement: "Four sealed cases delivered; photos pending external verification." };
  const initial = await f.read();
  let result = await f.mutate(f.supplier, "/v1/platform/deliveries", delivery);
  assert.equal(result.status, 400); assert.equal(result.json.error.code, "EVIDENCE_REQUIRED");
  assert.deepEqual(await f.read(), initial);
  f.seedLock();
  delivery.evidenceIds = [(await f.upload(f.supplier, delivery.id, "deliverBatch")).id];
  await t.test("public, administrator and unrelated or wrong-role accounts cannot mutate fulfillment", async () => {
    for (const person of [null, f.admin, f.outsider, f.acceptance, f.buyer]) assert.ok([401, 403].includes((await f.mutate(person, "/v1/platform/deliveries", delivery)).status));
    const foreign = await f.role("supplier", "other-supplier", "foreign-supplier");
    assert.equal((await f.mutate(foreign, "/v1/platform/deliveries", delivery)).status, 403);
    assert.equal((await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, actor: { role: "supplier" } })).status, 400);
    assert.equal((await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, receipt: { status: 1 } })).status, 400);
  });
  await t.test("a statement is mandatory; trusted actor and atomic idempotency preserve the original", async () => {
    for (const statement of [undefined, null, " ", "x", "x".repeat(16001), "\ud800bad"]) assert.equal((await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, statement })).status, 400);
    const expectedVersion = (await f.read()).version;
    f.data(await f.request(f.supplier, "/v1/platform/deliveries", { ...delivery, expectedVersion }, "delivery-repeat"), 201);
    const replay = await f.request(f.supplier, "/v1/platform/deliveries", { ...delivery, expectedVersion }, "delivery-repeat");
    f.data(replay, 201); assert.equal(replay.json.replayed, true);
    assert.equal((await f.request(f.supplier, "/v1/platform/deliveries", { ...delivery, statement: "Altered original", expectedVersion }, "delivery-repeat")).json.error.code, "IDEMPOTENCY_KEY_REUSED");
    const records = f.data(await f.request(f.supplier, "/v1/platform/contracts/C-F/attestations"));
    assert.equal(records.length, 1); assert.equal(records[0].actor.id, f.supplier.user.id);
    assert.equal(records[0].statementHash, keccak256(toUtf8Bytes(delivery.statement)));
    assert.equal(records[0].contractVersion, 1);
  });
  await t.test("record read obeys the same contract scope and no public route reveals statements", async () => {
    assert.equal((await f.request(f.outsider, "/v1/platform/contracts/C-F/attestations")).status, 403);
    assert.equal((await f.request(null, "/v1/platform/contracts/C-F/attestations")).status, 401);
    assert.equal(f.data(await f.request(f.admin, "/v1/platform/contracts/C-F/attestations")).length, 1);
    assert.ok(!JSON.stringify(f.data(await f.request(null, "/v1/platform/catalog"))).includes(delivery.statement));
  });
  const assessment = { outcome: "PARTIAL", acceptedQuantity: 1, statement: "One case intact; three rejected after count and seal inspection.",
    evidenceIds: [(await f.upload(f.acceptance, delivery.id, "acceptBatch")).id] };
  await t.test("assessment is quantity constrained, buyer scoped, independent and cannot inject an amount", async () => {
    for (const person of [f.admin, f.supplier, f.buyer, f.finance, f.outsider]) assert.equal((await f.mutate(person, "/v1/platform/batches/B-1/acceptance", assessment)).status, 403);
    assert.equal((await f.mutate(f.acceptance, "/v1/platform/batches/B-1/acceptance", { ...assessment, amountWei: "1" })).status, 400);
    assert.equal((await f.mutate(f.acceptance, "/v1/platform/batches/B-1/acceptance", { ...assessment, acceptedQuantity: 4 })).json.error.code, "OUTCOME_QUANTITY_MISMATCH");
    f.data(await f.mutate(f.acceptance, "/v1/platform/batches/B-1/acceptance", assessment), 201);
    assert.equal((await f.read()).batches[0].acceptedQuantity, 1);
  });
  await t.test("finance creates one payable for accepted quantity only and cannot mark it paid", async () => {
    assert.equal((await f.mutate(f.acceptance, "/v1/platform/batches/B-1/payable", {})).status, 403);
    assert.equal((await f.mutate(f.finance, "/v1/platform/batches/B-1/payable", { value: "120000000000000000010" })).status, 400);
    const payable = f.data(await f.mutate(f.finance, "/v1/platform/batches/B-1/payable", {}), 201);
    assert.equal(payable.amountWei, "12000000000000000001"); assert.equal(payable.status, "PAYABLE");
    assert.equal(payable.to, f.supplier.wallet.address.toLowerCase());
    f.data(await f.mutate(f.finance, "/v1/platform/batches/B-1/payable", {}), 201);
    const state = await f.read(); assert.equal(state.payables.length, 1); assert.equal(state.payments.length, 0);
    assert.equal((await f.mutate(f.finance, "/v1/platform/batches/B-1/payment-confirm", { receipt: { status: 1 } })).status, 404);
  });
  await t.test("a disputed batch does not freeze another batch; disputed or rejected batches cannot become payable", async () => {
    for (const [id, outcome] of [["B-2", "DISPUTED"], ["B-3", "REJECTED"], ["B-4", "ACCEPTED"]]) {
      const deliveryEvidence = await f.upload(f.supplier, id, "deliverBatch");
      f.data(await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, id, quantity: 2, evidenceIds: [deliveryEvidence.id] }), 201);
      const acceptanceEvidence = await f.upload(f.acceptance, id, "acceptBatch");
      f.data(await f.mutate(f.acceptance, `/v1/platform/batches/${id}/acceptance`, { ...assessment, outcome, acceptedQuantity: outcome === "ACCEPTED" ? 2 : 0, evidenceIds: [acceptanceEvidence.id] }), 201);
      const result = await f.mutate(f.finance, `/v1/platform/batches/${id}/payable`, {});
      if (outcome === "ACCEPTED") assert.equal(f.data(result, 201).amountWei, "24000000000000000002");
      else { assert.equal(result.status, 409); assert.equal(result.json.error.code, "BATCH_NOT_PAYABLE"); }
    }
    assert.equal((await f.read()).payments.length, 0);
    assert.equal((await f.mutate(f.supplier, "/v1/platform/deliveries", { ...delivery, id: "OVER", quantity: 1 })).json.error.code, "CONTRACT_QUANTITY_EXCEEDED");
  });
  await t.test("revoked users lose read and write access immediately", async () => {
    f.data(await f.request(f.admin, `/v1/platform/operators/${f.acceptance.user.id}/revoke`, {}));
    assert.equal((await f.request(f.acceptance, "/v1/platform/contracts/C-F/attestations")).status, 403);
    assert.equal((await f.mutate(f.acceptance, "/v1/platform/batches/B-2/acceptance", assessment)).status, 403);
  });
  await t.test("changing an assessor's role to finance cannot bypass historical separation", async () => {
    const invitation = f.data(await f.request(f.admin, "/v1/platform/operators/invitations", {
      email: f.acceptance.user.email, organizationId: "platform-org", role: "finance"
    }), 201);
    f.data(await f.request(f.acceptance, "/v1/platform/operators/claim", { code: invitation.code }));
    const result = await f.mutate(f.acceptance, "/v1/platform/batches/B-4/payable", {});
    assert.equal(result.status, 403); assert.equal(result.json.error.code, "SEPARATION_OF_DUTIES");
  });
  await t.test("corrupt persisted attestation blocks downstream financial preparation", async () => {
    const raw = new DatabaseSync(f.file);
    try { raw.prepare("UPDATE procurement_attestations SET statement=? WHERE batch_id=? AND method=?").run("Tampered statement", "B-4", "acceptBatch"); }
    finally { raw.close(); }
    assert.notEqual((await f.request(f.finance, "/v1/platform/contracts/C-F/attestations")).status, 200);
    assert.notEqual((await f.mutate(f.finance, "/v1/platform/batches/B-4/payable", {})).status, 201);
  });
});
