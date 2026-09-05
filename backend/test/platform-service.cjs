"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");
const { DatabaseSync } = require("node:sqlite");
const { createPlatformService } = require("../platform-service");
const { createOperatorRegistry } = require("../operator-registry");
const { createProcurementStore } = require("../procurement-store");

test("real accounts, wallet proofs, independent operator roles and persistent procurement HTTP workflow", { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-platform-http-"));
  const adminToken = crypto.randomBytes(32).toString("hex"), pool = "0x" + "12".repeat(20);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const end = once(child, "exit"); child.kill(); await end; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-platform-http-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    const env = { ...process.env, PORT: "0", DATA_DIR: directory, PUBLIC_BASE_URL: "http://localhost", NODE_ENV: "test",
      RELIEF_ADMIN_TOKEN: adminToken, RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false",
      MONAD_PROCUREMENT_POOL_ADDRESS: pool, MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
    for (const key of ["NODE_OPTIONS", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK"]) delete env[key];
    const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const base = await new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => reject(new Error("Startup timeout: " + stderr)), 15000);
      child.stderr.on("data", part => { stderr += part; });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error("Backend exit " + code + ": " + stderr)); });
      child.stdout.on("data", part => { stdout += part; const match = stdout.match(/listening on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timeout); resolve("http://127.0.0.1:" + match[1]); } });
    });
    return { child, base };
  }
  let server = await start();
  async function request(url, body, cookie, extra = {}) {
    const response = await fetch(server.base + url, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
  }
  function data(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body.data; }
  const adminHeaders = { "X-Relief-Actor": "admin" };
  let adminCookie = (await request("/v1/admin/session", { token: adminToken }, null, adminHeaders)).cookie;
  assert.ok(adminCookie);
  assert.deepEqual(data(await request("/v1/platform/catalog")), []);
  assert.equal((await request("/v1/platform/procurement")).status, 401);

  async function registerRole(role, organizationId, label) {
    const wallet = Wallet.createRandom(), email = label + "@example.com", password = "Password-test-12345";
    const registered = await request("/v1/wallet/register", { name: label, email, password });
    const user = data(registered, 201).user, cookie = registered.cookie;
    const challenge = data(await request("/v1/wallet/challenge", { address: wallet.address }, cookie));
    data(await request("/v1/wallet/verify", { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) }, cookie));
    const invitation = data(await request("/v1/platform/operators/invitations", { email, organizationId, role }, adminCookie, adminHeaders), 201);
    const assigned = data(await request("/v1/platform/operators/claim", { code: invitation.code }, cookie));
    assert.equal(assigned.role, role);
    assert.notEqual((await request("/v1/platform/operators/claim", { code: invitation.code }, cookie)).status, 200);
    return { wallet, email, password, cookie, userId: user.id };
  }
  const supplier = await registerRole("supplier", "supplier-org", "supplier-user");
  const dispatcher = await registerRole("dispatcher", "platform-org", "dispatcher-user");
  const buyer = await registerRole("contract_approver", "platform-org", "buyer-user");
  const other = await registerRole("supplier", "other-org", "other-user");
  assert.equal((await request("/v1/platform/operators/invitations", { email: "x@example.com", organizationId: "supplier-org", role: "finance" }, supplier.cookie)).status, 403);
  const now = Math.floor(Date.now() / 1000), idem = { "Idempotency-Key": crypto.randomUUID() };
  const quote = { id: "quote-http", resourceId: "MAT-WATER", unitPriceWei: "12000000000000000000", availableQuantity: 20, validUntil: now + 3600, etaHours: 2, expectedVersion: 0 };
  let result = await request("/v1/platform/quotes", quote, supplier.cookie, idem);
  data(result, 201); assert.equal(result.body.version, 1);
  result = await request("/v1/platform/quotes", quote, supplier.cookie, idem);
  data(result, 201); assert.equal(result.body.replayed, true);
  const catalog = data(await request("/v1/platform/catalog"));
  assert.equal(catalog.length, 1); assert.equal(catalog[0].unitPriceWei, quote.unitPriceWei); assert.equal(catalog[0].supplierWallet, undefined);
  assert.deepEqual(Object.keys(catalog[0]).sort(), ["id", "resourceId", "name", "image", "unit", "category",
    "supplierOrganizationId", "unitPriceWei", "availableQuantity", "validUntil", "etaHours"].sort());
  for (const personal of [supplier.email, supplier.userId, supplier.wallet.address, "supplier-user"]) {
    assert.ok(!JSON.stringify(catalog).includes(personal));
  }
  const reservation = { id: "reserve-http", quoteId: quote.id, taskId: "TASK-001", quantity: 10, buyerWallet: buyer.wallet.address, expectedVersion: 1 };
  assert.equal((await request("/v1/platform/reservations", reservation, supplier.cookie, { "Idempotency-Key": "bad-role" })).status, 403);
  data(await request("/v1/platform/reservations", reservation, dispatcher.cookie, { "Idempotency-Key": "reserve" }), 201);
  const contractInput = { id: "contract-http", reservationId: reservation.id, termsText: "交付十箱饮用水。\n保留完整原包装。", acceptanceText: "逐箱清点数量，检查封口与保质期。", nonce: "1", expiresAt: now + 1800, expectedVersion: 2 };
  for (const field of ["termsText", "acceptanceText"]) {
    for (const value of [undefined, null, 12, "", "x", "x".repeat(16001), "\ud800x"]) {
      const invalid = await request("/v1/platform/contracts", { ...contractInput, [field]: value }, buyer.cookie, { "Idempotency-Key": "invalid" });
      assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, "INVALID_DOCUMENT");
    }
  }
  assert.equal((await request("/v1/platform/contracts", { ...contractInput, termsHash: "0x" + "34".repeat(32) }, buyer.cookie, { "Idempotency-Key": "hash-injection" })).status, 400);
  data(await request("/v1/platform/contracts", contractInput, buyer.cookie, { "Idempotency-Key": "contract" }), 201);
  const expectedDocument = { contractId: contractInput.id, version: 1, termsText: contractInput.termsText,
    acceptanceText: contractInput.acceptanceText, termsHash: keccak256(toUtf8Bytes(contractInput.termsText)),
    acceptanceCriteriaHash: keccak256(toUtf8Bytes(contractInput.acceptanceText)) };
  for (const actor of [buyer, supplier, dispatcher]) {
    assert.deepEqual(data(await request("/v1/platform/contracts/contract-http/document", undefined, actor.cookie)), expectedDocument);
  }
  assert.deepEqual(data(await request("/v1/platform/contracts/contract-http/document", undefined, adminCookie, adminHeaders)), expectedDocument);
  assert.equal((await request("/v1/platform/contracts/contract-http/document", undefined, other.cookie)).status, 403);
  assert.equal((await request("/v1/platform/contracts/contract-http/document")).status, 401);
  assert.equal((await request("/v1/platform/contracts/contract-http/typed-data", undefined, dispatcher.cookie)).status, 403);
  assert.equal((await request("/v1/platform/contracts/contract-http/typed-data", undefined, adminCookie, adminHeaders)).status, 403);
  result = await request("/v1/platform/contracts", contractInput, buyer.cookie, { "Idempotency-Key": "contract" });
  data(result, 201); assert.equal(result.body.replayed, true);
  for (const field of ["termsText", "acceptanceText"]) {
    result = await request("/v1/platform/contracts", { ...contractInput, [field]: contractInput[field] + " " }, buyer.cookie, { "Idempotency-Key": "contract" });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  }
  assert.equal((await request("/v1/platform/contracts/contract-http/typed-data", undefined, other.cookie)).status, 403);
  const typed = data(await request("/v1/platform/contracts/contract-http/typed-data", undefined, buyer.cookie));
  assert.equal(typed.value.termsHash, expectedDocument.termsHash);
  assert.equal(typed.value.acceptanceCriteriaHash, expectedDocument.acceptanceCriteriaHash);
  const context = data(await request("/v1/platform/context", undefined, dispatcher.cookie));
  assert.deepEqual(context.approvers, [{ userId: buyer.userId, name: "buyer-user", wallet: buyer.wallet.address }]);
  assert.ok(context.tasks.some(task => task.id === reservation.taskId));
  assert.deepEqual(Object.keys(context.resources[0]).sort(), ["category", "id", "image", "name", "unit"]);
  let version = 3;
  for (const actor of [buyer, supplier]) {
    const signature = await actor.wallet.signTypedData(typed.domain, typed.types, typed.value);
    data(await request("/v1/platform/contracts/contract-http/signatures", { version: 1, signature, expectedVersion: version++ }, actor.cookie, { "Idempotency-Key": "signature-" + actor.userId }), 201);
  }
  const overview = data(await request("/v1/platform/procurement", undefined, buyer.cookie));
  assert.equal(overview.contracts[0].status, "FUNDS_RESERVABLE");
  assert.equal(overview.escrows.length, 0);
  assert.equal(data(await request("/v1/platform/procurement", undefined, other.cookie)).contracts.length, 0);
  assert.equal((await request("/v1/platform/contracts/contract-http/escrow-confirm", { confirmed: true, expectedVersion: version }, buyer.cookie, { "Idempotency-Key": "fake-lock" })).status, 404, "HTTP clients cannot assert chain facts");
  assert.equal((await request("/v1/platform/quotes", { ...quote, id: "admin-quote", expectedVersion: version }, adminCookie + "; " + supplier.cookie, { ...adminHeaders, "Idempotency-Key": "admin-business" })).status, 403);

  const spareId = "unreferenced-quote", activeId = "active-other-quote", expiredId = "expired-own-quote", orphanId = "orphan-quote";
  for (const [id, actor, validUntil] of [[spareId, supplier, now + 3600], [activeId, other, now + 3600], [expiredId, supplier, now - 1]]) {
    data(await request("/v1/platform/quotes", { ...quote, id, validUntil, expectedVersion: version++ }, actor.cookie,
      { "Idempotency-Key": id }), 201);
  }
  // An imported quote may have a registry assignment but no registered account.
  const seed = createProcurementStore({ file: path.join(directory, "platform.sqlite"), escrowContract: pool });
  const orphanRegistry = createOperatorRegistry({ file: path.join(directory, "platform.sqlite") });
  try {
    const orphan = { id: "unregistered-supplier", email: "orphan@example.com", wallet: Wallet.createRandom().address };
    const invitation = orphanRegistry.issue({ email: orphan.email, organizationId: "supplier-org", role: "supplier", issuedBy: "fixture" });
    orphanRegistry.claim({ code: invitation.code, user: orphan });
    const { expectedVersion, ...fields } = quote;
    seed.execute({ method: "addQuote", input: { ...fields, id: orphanId, supplierWallet: orphan.wallet,
      supplierOrganizationId: "supplier-org" }, actorId: "fixture", expectedVersion: version++, idempotencyKey: orphanId });
  } finally { seed.close(); orphanRegistry.close(); }

  async function assignSupplier(role = "supplier", organizationId = "supplier-org") {
    const invitation = data(await request("/v1/platform/operators/invitations", { email: supplier.email, organizationId, role }, adminCookie, adminHeaders), 201);
    data(await request("/v1/platform/operators/claim", { code: invitation.code }, supplier.cookie));
  }
  async function bindSupplier(wallet) {
    const challenge = data(await request("/v1/wallet/challenge", { address: wallet.address }, supplier.cookie));
    data(await request("/v1/wallet/verify", { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) }, supplier.cookie));
  }
  async function assertUnavailable(quoteId, code = "SUPPLIER_NOT_AUTHORIZED") {
    const denied = await request("/v1/platform/reservations", { ...reservation, id: "denied-" + crypto.randomUUID(),
      quoteId, quantity: 1, expectedVersion: version }, dispatcher.cookie, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(denied.status, code === "SUPPLIER_NOT_AUTHORIZED" ? 403 : 409);
    assert.equal(denied.body.error.code, code);
  }
  async function assertSupplierInvalid() {
    assert.deepEqual(data(await request("/v1/platform/catalog")).map(item => item.id), [activeId]);
    await assertUnavailable(quote.id);
    await assertUnavailable(spareId);
    for (const actor of [buyer, dispatcher]) {
      const state = data(await request("/v1/platform/procurement", undefined, actor.cookie));
      assert.deepEqual(state.quotes.map(item => item.id), [quote.id, activeId]);
      assert.deepEqual(state.quotes.map(item => item.purchasable), [false, true]);
      assert.ok(state.quotes[0].validUntil > Math.floor(Date.now() / 1000) && state.quotes[0].availableQuantity > 0,
        "Historical contract quotes with time and stock remaining are still not purchasable");
      assert.deepEqual(state.contracts, overview.contracts, "Signed terms, signatures and original payment wallet must not change");
      assert.equal(state.quotes[0].resourceId, quote.resourceId);
      assert.equal(state.quotes[0].supplierWallet, supplier.wallet.address.toLowerCase());
      assert.equal(state.version, version, "Rejected reservations and reads must not mutate procurement");
      assert.deepEqual(data(await request("/v1/platform/contracts/contract-http/document", undefined, actor.cookie)), expectedDocument);
    }
    assert.deepEqual(data(await request("/v1/platform/procurement", undefined, other.cookie)).quotes.map(item => item.id), [activeId]);
    const adminState = data(await request("/v1/platform/procurement", undefined, adminCookie, adminHeaders));
    assert.deepEqual(adminState.quotes.map(item => item.id), [quote.id, spareId, activeId, expiredId, orphanId]);
    assert.deepEqual(adminState.quotes.map(item => item.purchasable), [false, false, true, false, false]);
    assert.deepEqual(adminState.contracts, overview.contracts);
  }
  await t.test("HTTP excludes orphan and expired quotes while suppliers retain their own audit history", async () => {
    assert.deepEqual(data(await request("/v1/platform/catalog")).map(item => item.id), [quote.id, spareId, activeId]);
    const supplierQuotes = data(await request("/v1/platform/procurement", undefined, supplier.cookie)).quotes;
    assert.deepEqual(supplierQuotes.map(item => item.id), [quote.id, spareId, activeId, expiredId]);
    assert.deepEqual(supplierQuotes.map(item => item.purchasable), [true, true, true, false]);
    assert.deepEqual(data(await request("/v1/platform/procurement", undefined, dispatcher.cookie)).quotes.map(item => item.id),
      [quote.id, spareId, activeId]);
    await assertUnavailable(orphanId);
    await assertUnavailable(expiredId, "EXPIRED");
    await assertUnavailable("unknown-quote", "NOT_FOUND");
  });
  data(await request(`/v1/platform/operators/${supplier.userId}/revoke`, {}, adminCookie, adminHeaders));
  assert.equal((await request("/v1/platform/quotes", { ...quote, id: "revoked-quote", expectedVersion: version }, supplier.cookie, { "Idempotency-Key": "revoked" })).status, 403);
  await t.test("HTTP rejects revoked suppliers but preserves signed contract resources", assertSupplierInvalid);
  await assignSupplier();
  await t.test("HTTP rejects wallet rebinding, including a new supplier assignment on the new wallet", async () => {
    assert.ok(data(await request("/v1/platform/catalog")).some(item => item.id === quote.id));
    await bindSupplier(Wallet.createRandom());
    await assertSupplierInvalid();
    data(await request(`/v1/platform/operators/${supplier.userId}/revoke`, {}, adminCookie, adminHeaders));
    await assignSupplier();
    await assertSupplierInvalid();
  });
  data(await request(`/v1/platform/operators/${supplier.userId}/revoke`, {}, adminCookie, adminHeaders));
  await bindSupplier(supplier.wallet);
  await assignSupplier("finance");
  await t.test("HTTP rejects a former supplier reinvited to another role", async () => {
    await assertSupplierInvalid();
    assert.deepEqual(data(await request("/v1/platform/procurement", undefined, supplier.cookie)).quotes.map(item => item.id), [quote.id, activeId]);
  });
  data(await request(`/v1/platform/operators/${supplier.userId}/revoke`, {}, adminCookie, adminHeaders));
  await assignSupplier("supplier", "changed-org");
  await t.test("HTTP requires the quote's original supplier organization", async () => {
    await assertSupplierInvalid();
    assert.deepEqual(data(await request("/v1/platform/procurement", undefined, supplier.cookie)).quotes.map(item => item.id), [activeId]);
  });
  await t.test("HTTP retains uncontracted reservation resources with purchasable false when stock is exhausted", async () => {
    data(await request("/v1/platform/reservations", { ...reservation, id: "active-reservation", quoteId: activeId,
      quantity: quote.availableQuantity, expectedVersion: version++ }, dispatcher.cookie, { "Idempotency-Key": "active-reserve" }), 201);
    assert.deepEqual(data(await request("/v1/platform/catalog")), []);
    for (const actor of [buyer, dispatcher]) {
      const state = data(await request("/v1/platform/procurement", undefined, actor.cookie));
      assert.deepEqual(state.quotes.map(item => item.id), [quote.id, activeId]);
      assert.deepEqual(state.quotes.map(item => item.purchasable), [false, false]);
      const reserved = state.reservations.find(item => item.id === "active-reservation");
      assert.equal(reserved.status, "RESERVED");
      const resourceQuote = state.quotes.find(item => item.id === reserved.quoteId);
      assert.equal(resourceQuote.resourceId, quote.resourceId);
      assert.ok(context.resources.some(item => item.id === resourceQuote.resourceId && item.name));
      assert.ok(!state.contracts.some(item => item.versions.some(terms => terms.quoteId === activeId)));
    }
    const ownQuotes = data(await request("/v1/platform/procurement", undefined, other.cookie)).quotes;
    assert.deepEqual(ownQuotes.map(item => item.id), [activeId]);
    assert.equal(ownQuotes[0].purchasable, false);
    const unrelated = data(await request("/v1/platform/procurement", undefined, supplier.cookie));
    assert.deepEqual(unrelated.reservations, []);
    assert.deepEqual(unrelated.quotes, [], "Another organization's reservation must not expose its historical quote");
    const auditQuotes = data(await request("/v1/platform/procurement", undefined, adminCookie, adminHeaders)).quotes;
    assert.deepEqual(auditQuotes.map(item => item.id), [quote.id, spareId, activeId, expiredId, orphanId]);
    assert.ok(auditQuotes.every(item => item.purchasable === false));
    await assertUnavailable(activeId, "INSUFFICIENT_AVAILABILITY");
  });

  const stopped = once(server.child, "exit"); server.child.kill(); await stopped; server = await start();
  buyer.cookie = (await request("/v1/wallet/login", { email: buyer.email, password: buyer.password })).cookie;
  const restored = data(await request("/v1/platform/procurement", undefined, buyer.cookie));
  assert.deepEqual(restored.contracts, overview.contracts); assert.equal(restored.version, version);
  assert.deepEqual(restored.quotes.map(item => item.id), [quote.id, activeId]);
  assert.ok(restored.quotes.every(item => item.purchasable === false));
  assert.deepEqual(data(await request("/v1/platform/catalog")), []);
  assert.equal(restored.configuration.escrowContract, pool);
  assert.deepEqual(data(await request("/v1/platform/contracts/contract-http/document", undefined, buyer.cookie)), expectedDocument);
  result = await request("/v1/platform/contracts", contractInput, buyer.cookie, { "Idempotency-Key": "contract" });
  data(result, 201); assert.equal(result.body.replayed, true);
});

function serviceFixture(t, escrowContract = "0x" + "12".repeat(20)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-platform-service-"));
  const file = path.join(directory, "platform.sqlite"), users = new Map(), tasks = [];
  const registry = createOperatorRegistry({ file });
  const accounts = {
    requireUser(req) {
      const user = users.get(req.headers.user);
      if (!user) throw Object.assign(new Error("Login required"), { code: "AUTH_REQUIRED", status: 401 });
      return user;
    },
    getByWallet(wallet) { return [...users.values()].find(user => user.wallet?.toLowerCase() === wallet.toLowerCase()) || null; },
    assertOrigin() {}
  };
  const service = createPlatformService({ file, accounts, escrowContract, isAdmin: req => req.headers["x-relief-actor"] === "admin",
    send(res, status, body) { res.status = status; res.body = body; }, readBody: async req => req.body,
    getTasks: () => tasks,
    getResources: () => [{ id: "water", name: "Water", unit: "case", category: "material", image: "water.png", privateCost: 12 }] });
  const store = createProcurementStore({ file, escrowContract });
  t.after(() => {
    service.close(); registry.close(); store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-platform-service-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function actor(id, role, organizationId) {
    const wallet = Wallet.createRandom(), user = { id, name: id, email: id + "@example.com", wallet: wallet.address };
    users.set(id, user);
    const invitation = registry.issue({ email: user.email, role, organizationId, issuedBy: "admin" });
    registry.claim({ code: invitation.code, user });
    return { user, wallet };
  }
  async function request(path, user, body, key = crypto.randomUUID()) {
    const res = { setHeader() {} };
    const req = { method: body === undefined ? "GET" : "POST", body,
      headers: { user, "content-type": "application/json", "idempotency-key": key, ...(user === "admin" ? { "x-relief-actor": "admin" } : {}) } };
    assert.equal(await service.handle(req, res, path), true);
    return res;
  }
  return { file, users, tasks, registry, store, actor, request };
}

test("context projects safe fields, scopes private tasks and excludes invalid approvers", async t => {
  const f = serviceFixture(t), { request } = f;
  f.actor("dispatcher", "dispatcher", "buyer-org");
  const buyer = f.actor("buyer", "contract_approver", "buyer-org");
  f.actor("other", "contract_approver", "other-org");
  f.actor("revoked", "contract_approver", "buyer-org");
  f.registry.revoke({ userId: "revoked", revokedBy: "admin" });
  f.actor("changed", "contract_approver", "buyer-org");
  f.users.get("changed").wallet = Wallet.createRandom().address;
  f.actor("deleted", "contract_approver", "buyer-org"); f.users.delete("deleted");
  f.actor("reassigned", "contract_approver", "buyer-org");
  f.users.get("reassigned").id = "different-user";
  f.users.set("unassigned", { id: "unassigned", wallet: Wallet.createRandom().address });
  const base = { title: "Verified water delivery", status: "DISPATCHING", verificationStatus: "VERIFIED", organizationId: "other-org", secret: "hidden" };
  f.tasks.push({ ...base, id: "public" }, { ...base, id: "lowercase", visibility: "public", status: "EXECUTING" },
    { ...base, id: "own-private", organizationId: "buyer-org", visibility: "PRIVATE" },
    { ...base, id: "foreign-private", visibility: "PRIVATE" }, { ...base, id: "flag-private", isPrivate: true },
    { ...base, id: "legacy-private", private: true }, { ...base, id: "unknown-visibility", visibility: "INTERNAL" },
    { ...base, id: "unverified", verificationStatus: "PENDING" }, { ...base, id: "paused", status: "PAUSED" },
    { ...base, id: "completed", status: "COMPLETED" }, { ...base, id: "in-progress", status: "IN_PROGRESS" });
  assert.equal((await request("/v1/platform/context")).status, 401);
  assert.equal((await request("/v1/platform/context", "unassigned")).status, 403);
  const context = await request("/v1/platform/context", "dispatcher");
  assert.equal(context.status, 200);
  assert.deepEqual(context.body, { data: {
    resources: [{ id: "water", name: "Water", unit: "case", category: "material", image: "water.png" }],
    tasks: f.tasks.filter(task => ["public", "lowercase", "own-private"].includes(task.id)).map(task => ({
      id: task.id, title: task.title, status: task.status, verificationStatus: task.verificationStatus,
      organizationId: task.organizationId, visibility: task.id === "own-private" ? "PRIVATE" : "PUBLIC"
    })), approvers: [{ userId: "buyer", name: "buyer", wallet: buyer.wallet.address }]
  } });
  const admin = await request("/v1/platform/context", "admin");
  assert.equal(admin.body.data.tasks.length, 7); assert.deepEqual(admin.body.data.approvers, []);
  assert.ok(admin.body.data.tasks.every(task => !["COMPLETED", "IN_PROGRESS"].includes(task.status)));
  const supplier = f.actor("supplier", "supplier", "supplier-org");
  const quote = { id: "q1", resourceId: "water", unitPriceWei: "1", availableQuantity: 10, validUntil: Math.floor(Date.now() / 1000) + 3600, etaHours: 1, expectedVersion: 0 };
  assert.equal((await request("/v1/platform/quotes", supplier.user.id, quote)).status, 201);
  const reservation = { id: "r1", quoteId: "q1", taskId: "foreign-private", quantity: 1, buyerWallet: buyer.wallet.address, expectedVersion: 1 };
  for (const taskId of ["foreign-private", "flag-private", "legacy-private", "unknown-visibility"]) {
    const denied = await request("/v1/platform/reservations", "dispatcher", { ...reservation, taskId });
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, "SCOPE_DENIED");
  }
  for (const taskId of ["completed", "in-progress"]) {
    assert.equal((await request("/v1/platform/reservations", "dispatcher", { ...reservation, taskId })).body.error.code, "TASK_NOT_APPROVED");
  }
  assert.equal((await request("/v1/platform/reservations", "dispatcher", { ...reservation, taskId: "own-private" })).status, 201);
});

test("missing document blocks typed data and valid signatures; signer roles remain strict", async t => {
  const f = serviceFixture(t), { request } = f;
  const buyer = f.actor("buyer", "contract_approver", "buyer-org"), supplier = f.actor("supplier", "supplier", "supplier-org");
  f.actor("other", "supplier", "other-org");
  const now = Math.floor(Date.now() / 1000);
  function write(method, input) { return f.store.execute({ method, input, actorId: "fixture", expectedVersion: f.store.read().version, idempotencyKey: crypto.randomUUID() }); }
  write("addQuote", { id: "q", resourceId: "water", supplierOrganizationId: "supplier-org", supplierWallet: supplier.wallet.address, unitPriceWei: "1", availableQuantity: 2, validUntil: now + 3600, etaHours: 1 });
  write("reserve", { id: "r", quoteId: "q", taskId: "private-task", quantity: 2, buyerWallet: buyer.wallet.address, buyerOrganizationId: "buyer-org", now });
  const input = { id: "c", reservationId: "r", termsText: "Deliver two water cases.", acceptanceText: "Inspect all seals.", nonce: "1", expiresAt: now + 3000, expectedVersion: 2 };
  assert.equal((await request("/v1/platform/contracts", "buyer", input)).status, 201);
  const typed = (await request("/v1/platform/contracts/c/typed-data", "buyer")).body.data;
  const signature = await buyer.wallet.signTypedData(typed.domain, typed.types, typed.value);
  f.registry.revoke({ userId: "buyer", revokedBy: "admin" });
  const invite = f.registry.issue({ email: buyer.user.email, organizationId: "buyer-org", role: "supplier", issuedBy: "admin" });
  f.registry.claim({ code: invite.code, user: buyer.user });
  for (const [path, body] of [["typed-data", undefined], ["signatures", { version: 1, signature, expectedVersion: 3 }]]) {
    const denied = await request("/v1/platform/contracts/c/" + path, "buyer", body);
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, "SIGNER_REQUIRED");
  }
  assert.equal((await request("/v1/platform/contracts/c/document", "buyer")).status, 200);
  const raw = new DatabaseSync(f.file);
  try { raw.exec("DELETE FROM procurement_documents"); } finally { raw.close(); }
  for (const user of ["supplier", "admin"]) {
    const missing = await request("/v1/platform/contracts/c/document", user);
    assert.equal(missing.status, 404); assert.equal(missing.body.data, null); assert.equal(missing.body.error.code, "CONTRACT_DOCUMENT_MISSING");
  }
  assert.equal((await request("/v1/platform/contracts/c/document", "other")).status, 403);
  assert.equal((await request("/v1/platform/contracts/c/typed-data", "supplier")).body.error.code, "CONTRACT_DOCUMENT_MISSING");
  const supplierSignature = await supplier.wallet.signTypedData(typed.domain, typed.types, typed.value);
  const denied = await request("/v1/platform/contracts/c/signatures", "supplier", { version: 1, signature: supplierSignature, expectedVersion: 3 });
  assert.equal(denied.body.error.code, "CONTRACT_DOCUMENT_MISSING");
  assert.deepEqual(f.store.read().contracts[0].signatures, {}); assert.equal(f.store.read().version, 3);
});

test("HTTP remains closed to signing and payments without chain configuration", async t => {
  const f = serviceFixture(t, null), { request } = f;
  const buyer = f.actor("buyer", "contract_approver", "buyer-org"), supplier = f.actor("supplier", "supplier", "supplier-org");
  f.actor("dispatcher", "dispatcher", "buyer-org");
  f.tasks.push({ id: "task", title: "Water delivery", status: "DISPATCHING", verificationStatus: "VERIFIED" });
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await request("/v1/platform/quotes", supplier.user.id, { id: "q", resourceId: "water", unitPriceWei: "1", availableQuantity: 1, validUntil: now + 3600, etaHours: 1, expectedVersion: 0 })).status, 201);
  assert.equal((await request("/v1/platform/reservations", "dispatcher", { id: "r", quoteId: "q", taskId: "task", quantity: 1, buyerWallet: buyer.wallet.address, expectedVersion: 1 })).status, 201);
  const result = await request("/v1/platform/contracts", "buyer", { id: "c", reservationId: "r", termsText: "Delivery terms", acceptanceText: "Inspect seals", nonce: "1", expiresAt: now + 3000, expectedVersion: 2 });
  assert.equal(result.status, 503); assert.equal(result.body.error.code, "CHAIN_CONFIGURATION_REQUIRED");
  assert.equal((await request("/v1/platform/contracts/c/typed-data", "buyer")).status, 404);
  assert.equal((await request("/v1/platform/contracts/c/signatures", "buyer", { version: 1, signature: "0xab", expectedVersion: 2 })).status, 404);
  assert.equal((await request("/v1/platform/payments", "buyer", {})).status, 404);
  assert.equal(f.store.read().version, 2); assert.deepEqual(f.store.read().payments, []);
  const raw = new DatabaseSync(f.file);
  try { assert.equal(raw.prepare("SELECT count(*) AS n FROM procurement_documents").get().n, 0); } finally { raw.close(); }
});
