"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { Wallet } = require("ethers");
const { createProcurementStore } = require("../../procurement-store");
const evidencePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-fulfillment-"));
  const file = path.join(directory, "platform.sqlite"), pool = "0x" + "76".repeat(20);
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://localhost:${port}`, token = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DATA_DIR: directory, NODE_ENV: "test",
    RELIEF_ADMIN_TOKEN: token, RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false",
    MONAD_PROCUREMENT_POOL_ADDRESS: pool, MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const key of ["NODE_OPTIONS", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK"]) delete env[key];
  let child;
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) { const end = once(child, "exit"); child.kill(); await end; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-fulfillment-"));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    child = spawn(process.execPath, [path.resolve(__dirname, "../../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("Fixture startup: " + stderr)), 15000);
      child.stderr.on("data", part => { stderr += part; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error("Fixture exited " + code + ": " + stderr)); });
      child.stdout.on("data", part => { if (String(part).includes("backend listening")) { clearTimeout(timer); resolve(); } });
    });
    async function request(actor, url, body, key, extra = {}) {
      const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
          ...(actor?.admin ? { "X-Relief-Actor": "admin" } : {}), ...(key ? { "Idempotency-Key": key } : {}), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, json: await response.json(), cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
    }
    const data = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json.data; };
    const admin = { admin: true, cookie: (await request({ admin: true }, "/v1/admin/session", { token })).cookie };
    async function role(name, organizationId, label = name) {
      const wallet = Wallet.createRandom(), email = `${label}@example.com`;
      const response = await request(null, "/v1/wallet/register", { name: label, email, password: "Fulfillment-password-123" });
      const user = data(response, 201).user, person = { cookie: response.cookie, wallet, user, role: name, organizationId };
      const challenge = data(await request(person, "/v1/wallet/challenge", { address: wallet.address }));
      data(await request(person, "/v1/wallet/verify", { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) }));
      const invitation = data(await request(admin, "/v1/platform/operators/invitations", { email, organizationId, role: name }), 201);
      data(await request(person, "/v1/platform/operators/claim", { code: invitation.code }));
      return person;
    }
    const supplier = await role("supplier", "supplier-org"), buyer = await role("contract_approver", "platform-org");
    const dispatcher = await role("dispatcher", "platform-org"), acceptance = await role("acceptance", "platform-org");
    const finance = await role("finance", "platform-org"), outsider = await role("acceptance", "outside-org", "outsider");
    const read = async (person = admin) => data(await request(person, "/v1/platform/procurement"));
    const mutate = async (person, url, body, key = crypto.randomUUID()) => request(person, url, { ...body, expectedVersion: (await read()).version }, key);
    const now = Math.floor(Date.now() / 1000);
    data(await mutate(supplier, "/v1/platform/quotes", { id: "Q-F", resourceId: "MAT-WATER", unitPriceWei: "12000000000000000001", availableQuantity: 10, etaHours: 2, validUntil: now + 7200 }), 201);
    data(await mutate(dispatcher, "/v1/platform/reservations", { id: "R-F", quoteId: "Q-F", taskId: "TASK-001", quantity: 10, buyerWallet: buyer.wallet.address }), 201);
    data(await mutate(buyer, "/v1/platform/contracts", { id: "C-F", reservationId: "R-F", termsText: "Deliver ten water cases.", acceptanceText: "Count intact cases and record damage.", nonce: "1", expiresAt: now + 3600 }), 201);
    const typed = data(await request(buyer, "/v1/platform/contracts/C-F/typed-data"));
    for (const person of [buyer, supplier]) data(await mutate(person, "/v1/platform/contracts/C-F/signatures", { version: 1, signature: await person.wallet.signTypedData(typed.domain, typed.types, typed.value) }), 201);
    // Only this isolated test fixture supplies trusted lock facts. No HTTP route or
    // real deployment exists for accepting a client's assertion that funds are locked.
    function seedLock() {
      const store = createProcurementStore({ file, escrowContract: pool });
      const txHash = "0x" + "91".repeat(32);
      try { store.execute({ method: "recordEscrowConfirmed", actorId: "trusted-test-indexer", idempotencyKey: "fixture-lock", expectedVersion: store.read().version,
        input: { contractId: "C-F", version: 1, escrowBusinessId: "ESC-F", txHash,
          receipt: { status: 1, transactionHash: txHash, chainId: "10143", escrowContract: pool, value: "120000000000000000010", escrowBusinessId: "ESC-F", contractId: "C-F", contractVersion: 1 } } });
      } finally { store.close(); }
    }
    async function upload(person, batchId, method, options = {}) {
      const input = { id: "E-" + crypto.randomUUID(), contractVersion: 1, batchId, method, filename: "field-photo.png", mimeType: "image/png", contentBase64: evidencePng.toString("base64"), ...options };
      return data(await request(person, "/v1/platform/contracts/C-F/evidence", input, input.id), 201);
    }
    return { base, file, pool, close, request, data, read, mutate, role, seedLock, upload, admin, supplier, buyer, dispatcher, acceptance, finance, outsider };
  } catch (error) { await close(); throw error; }
}
module.exports = { fixture, evidencePng };
