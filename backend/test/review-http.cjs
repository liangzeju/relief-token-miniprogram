"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture } = require("./helpers/fulfillment-fixture.cjs");

test("case-specific independent review is registered, private, revocable and quantity based", { timeout: 90000 }, async t => {
  const f = await fixture(); t.after(f.close); f.seedLock();
  const reviewer = await f.role("reviewer", "review-org", "review-one");
  const second = await f.role("reviewer", "review-two-org", "review-two");
  const getBinding = async person => f.data(await f.request(person, "/v1/platform/operators/me"));
  const binding = await getBinding(reviewer), secondBinding = await getBinding(second);
  async function batch(id, outcome) {
    const delivery = await f.upload(f.supplier, id, "deliverBatch");
    f.data(await f.mutate(f.supplier, "/v1/platform/deliveries", { id, contractId: "C-F", quantity: 3, statement: "Delivery originals " + id, evidenceIds: [delivery.id] }), 201);
    const acceptance = await f.upload(f.acceptance, id, "acceptBatch");
    f.data(await f.mutate(f.acceptance, `/v1/platform/batches/${id}/acceptance`, { outcome, acceptedQuantity: outcome === "ACCEPTED" ? 3 : 0, statement: "Original assessment " + id, evidenceIds: [acceptance.id] }), 201);
    return { delivery, acceptance };
  }
  const disputed = await batch("B-R", "DISPUTED"), sibling = await batch("B-S", "ACCEPTED");
  const assign = (candidate, id = randomUUID()) => ({ id, assignmentId: candidate.id, reason: "Independent field review required" });
  let assignment;
  await t.test("unassigned reviewers cannot inherit organizational access or private materials", async () => {
    assert.deepEqual((await f.read(reviewer)).batches, []);
    for (const path of ["/contracts/C-F/document", "/contracts/C-F/attestations", `/evidence/${disputed.delivery.id}/content`]) {
      const response = await fetch(f.base + "/v1/platform" + path, { headers: { Cookie: reviewer.cookie } });
      assert.equal(response.status, 403);
    }
    const ordinaryContext = f.data(await f.request(reviewer, "/v1/platform/context"));
    assert.equal(ordinaryContext.reviewers, undefined);
    const candidates = f.data(await f.request(f.admin, "/v1/platform/context")).reviewers;
    assert.ok(candidates.some(item => item.assignmentId === binding.id));
  });
  await t.test("only admin assigns independent active registered role with version and retry safety", async () => {
    const body = assign(binding), key = randomUUID(), expectedVersion = (await f.read()).version;
    for (const person of [null, reviewer, f.buyer, f.supplier, f.finance]) assert.ok([401, 403].includes((await f.mutate(person, "/v1/platform/batches/B-R/reviewer-assignment", body)).status));
    assert.equal((await f.mutate(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", assign(await getBinding(f.buyer)))).status, 403);
    const related = await f.role("reviewer", "supplier-org", "related-review");
    assert.equal((await f.mutate(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", assign(await getBinding(related)))).json.error.code, "SEPARATION_OF_DUTIES");
    const first = await f.request(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", { ...body, expectedVersion }, key);
    assignment = f.data(first, 201).reviewAssignments.at(-1);
    const replay = await f.request(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", { ...body, expectedVersion }, key);
    f.data(replay, 201); assert.equal(replay.json.replayed, true);
    assert.equal((await f.request(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", { ...body, reason: "Changed decision", expectedVersion }, key)).json.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await f.request(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", { ...assign(secondBinding), expectedVersion }, randomUUID())).json.error.code, "VERSION_CONFLICT");
    assert.equal((await f.mutate(f.admin, "/v1/platform/batches/B-S/reviewer-assignment", assign(binding))).json.error.code, "BATCH_NOT_DISPUTED");
  });
  await t.test("assigned scope includes contract originals but excludes sibling batches and files", async () => {
    const own = await f.read(reviewer);
    assert.deepEqual(own.batches.map(item => item.id), ["B-R"]); assert.equal(own.contracts.length, 1); assert.equal(own.reservations.length, 0);
    const records = f.data(await f.request(reviewer, "/v1/platform/contracts/C-F/attestations"));
    assert.equal(records.length, 2); assert.ok(records.every(item => item.batchId === "B-R"));
    f.data(await f.request(reviewer, "/v1/platform/contracts/C-F/document"));
    for (const [id, status] of [[disputed.delivery.id, 200], [sibling.delivery.id, 403]]) {
      const response = await fetch(f.base + `/v1/platform/evidence/${id}/content`, { headers: { Cookie: reviewer.cookie } });
      assert.equal(response.status, status); await response.arrayBuffer();
    }
    const paid = f.data(await f.mutate(f.finance, "/v1/platform/batches/B-S/payable", {}), 201);
    assert.equal(paid.amountWei, "36000000000000000003");
    assert.equal((await f.read(reviewer)).payables.length, 0);
    assert.equal((await f.mutate(f.finance, "/v1/platform/batches/B-R/payable", {})).status, 409);
  });
  let staleEvidence;
  await t.test("reassignment removes old rights and returning to same person does not resurrect old drafts", async () => {
    staleEvidence = await f.upload(reviewer, "B-R", "resolveDispute", { reviewAssignmentId: assignment.id });
    f.data(await f.mutate(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", assign(secondBinding)), 201);
    assert.equal((await f.read(reviewer)).batches.length, 0);
    assert.equal((await f.request(reviewer, "/v1/platform/contracts/C-F/attestations")).status, 403);
    const oldResponse = await fetch(f.base + `/v1/platform/evidence/${staleEvidence.id}/content`, { headers: { Cookie: second.cookie } });
    assert.equal(oldResponse.status, 403); await oldResponse.arrayBuffer();
    assignment = f.data(await f.mutate(f.admin, "/v1/platform/batches/B-R/reviewer-assignment", assign(binding)), 201).reviewAssignments.at(-1);
    assert.notEqual(assignment.id, staleEvidence.reviewAssignmentId);
    const old = await f.mutate(reviewer, "/v1/platform/batches/B-R/review", { acceptedQuantity: 1, statement: "Independent verification", evidenceIds: [staleEvidence.id], reviewAssignmentId: assignment.id });
    assert.equal(old.status, 409);
    const response = await fetch(f.base + `/v1/platform/evidence/${staleEvidence.id}/content`, { headers: { Cookie: reviewer.cookie } });
    assert.equal(response.status, 403); await response.arrayBuffer();
  });
  await t.test("review requires own current-case originals, no amount injection, cannot be performed by admin", async () => {
    const evidence = await f.upload(reviewer, "B-R", "resolveDispute", { reviewAssignmentId: assignment.id });
    const body = { acceptedQuantity: 1, statement: "One verified intact case, two damaged", evidenceIds: [evidence.id], reviewAssignmentId: assignment.id };
    for (const person of [f.admin, f.supplier, f.buyer, f.acceptance, f.finance, second]) assert.equal((await f.mutate(person, "/v1/platform/batches/B-R/review", body)).status, 403);
    for (const extra of [{ value: "999" }, { actor: { role: "reviewer" } }]) assert.equal((await f.mutate(reviewer, "/v1/platform/batches/B-R/review", { ...body, ...extra })).status, 400);
    assert.equal((await f.mutate(reviewer, "/v1/platform/batches/B-R/review", { ...body, evidenceIds: [] })).status, 400);
    assert.equal((await f.mutate(reviewer, "/v1/platform/batches/B-R/review", { ...body, acceptedQuantity: 4 })).status, 409);
    const expectedVersion = (await f.read()).version, key = randomUUID();
    const result = f.data(await f.request(reviewer, "/v1/platform/batches/B-R/review", { ...body, expectedVersion }, key), 201);
    assert.equal(result.status, "PARTIAL"); assert.equal(result.acceptance.outcome, "DISPUTED");
    assert.equal(result.review.actor.id, reviewer.user.id); assert.equal(result.reviewAssignments.length, 3);
    const replay = await f.request(reviewer, "/v1/platform/batches/B-R/review", { ...body, expectedVersion }, key);
    f.data(replay, 201); assert.equal(replay.json.replayed, true);
    const records = f.data(await f.request(reviewer, "/v1/platform/contracts/C-F/attestations"));
    assert.equal(records.length, 3); assert.equal(records.at(-1).method, "resolveDispute");
    assert.equal(records.at(-1).evidence[0].reviewAssignmentId, assignment.id);
    assert.equal(f.data(await f.mutate(f.finance, "/v1/platform/batches/B-R/payable", {}), 201).amountWei, "12000000000000000001");
    assert.equal((await f.read()).payments.length, 0);
  });
  await t.test("revocation and reissuing identical role requires a new explicit case assignment", async () => {
    f.data(await f.request(f.admin, `/v1/platform/operators/${reviewer.user.id}/revoke`, {}));
    assert.equal((await f.request(reviewer, "/v1/platform/procurement")).status, 403);
    const invitation = f.data(await f.request(f.admin, "/v1/platform/operators/invitations", { email: reviewer.user.email, organizationId: reviewer.organizationId, role: "reviewer" }), 201);
    const replacement = f.data(await f.request(reviewer, "/v1/platform/operators/claim", { code: invitation.code }));
    assert.notEqual(replacement.id, binding.id);
    assert.equal((await f.read(reviewer)).batches.length, 0);
    assert.equal((await f.request(reviewer, "/v1/platform/contracts/C-F/document")).status, 403);
  });
  await t.test("former procurement dispatcher cannot review by changing organization and role", async () => {
    await batch("B-T", "DISPUTED");
    f.data(await f.request(f.admin, `/v1/platform/operators/${f.dispatcher.user.id}/revoke`, {}));
    const invitation = f.data(await f.request(f.admin, "/v1/platform/operators/invitations", { email: f.dispatcher.user.email, organizationId: "new-review-org", role: "reviewer" }), 201);
    const changed = f.data(await f.request(f.dispatcher, "/v1/platform/operators/claim", { code: invitation.code }));
    const result = await f.mutate(f.admin, "/v1/platform/batches/B-T/reviewer-assignment", assign(changed));
    assert.equal(result.status, 403); assert.equal(result.json.error.code, "SEPARATION_OF_DUTIES");
    assert.equal((await f.read()).batches.find(item => item.id === "B-T").reviewAssignments, undefined);
  });
});
