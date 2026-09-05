/* eslint-disable no-console */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const port = 19000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-mon-smoke-"));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, RELIEF_ENABLE_LEGACY_DEMO: "true" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", chunk => process.stdout.write(`[backend] ${chunk}`));
server.stderr.on("data", chunk => process.stderr.write(`[backend] ${chunk}`));

let sequence = 0;
function key(prefix) { sequence += 1; return `smoke-${prefix}-${sequence}`; }
async function request(method, route, token, payload, idempotencyKey) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
  return { status: response.status, body };
}
function data(result) {
  assert.ok(!result.body.error, JSON.stringify(result.body));
  return result.body.data;
}
function expectError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body));
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await request("GET", "/v1/health");
      if (result.status === 200) return;
    } catch (_) { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("backend did not become healthy");
}

async function run() {
  await waitForHealth();
  const health = await request("GET", "/v1/health");
  assert.equal(health.body.ok, true);

  expectError(await request("GET", "/v1/donations"), 401, "AUTH_REQUIRED");
  expectError(await request("POST", "/v1/demo/reset", "demo-platform-admin", {}), 400, "IDEMPOTENCY_KEY_REQUIRED");
  data(await request("POST", "/v1/demo/reset", "demo-platform-admin", {}, key("reset")));

  const donationPayload = { donor: "Smoke Test Fund", fiatAmount: 5000, paymentProvider: "demo" };
  const donationKey = key("donation");
  const donationResult = await request("POST", "/v1/donations", "demo-donor", donationPayload, donationKey);
  assert.equal(donationResult.status, 201);
  const donation = data(donationResult);
  const duplicate = await request("POST", "/v1/donations", "demo-donor", donationPayload, donationKey);
  assert.equal(duplicate.status, 201);
  assert.equal(data(duplicate).id, donation.id);
  assert.ok(donation.id);
  // Verify key reuse behavior with a known key.
  const reusePayload = { donor: "Reuse Fund", fiatAmount: 12 };
  const reuseKey = key("reuse");
  assert.equal((await request("POST", "/v1/donations", "demo-donor", reusePayload, reuseKey)).status, 201);
  expectError(await request("POST", "/v1/donations", "demo-donor", { ...reusePayload, fiatAmount: 13 }, reuseKey), 409, "IDEMPOTENCY_KEY_REUSED");

  expectError(await request("POST", `/v1/donations/${donation.id}/payment-confirm`, "demo-donor", { paymentReference: "PAY-1" }, key("bad-payment")), 403, "ROLE_NOT_ALLOWED");
  data(await request("POST", `/v1/donations/${donation.id}/payment-confirm`, "demo-finance", { paymentReference: "PAY-1" }, key("payment")));
  data(await request("POST", `/v1/donations/${donation.id}/compliance-review`, "demo-compliance", { decision: "approve" }, key("compliance")));
  const deposit = data(await request("POST", `/v1/donations/${donation.id}/mon-deposit`, "demo-finance", { amountMon: 1000, priceSnapshot: { source: "smoke" } }, key("deposit")));
  assert.equal(deposit.status, "MON_DEPOSIT_PENDING");
  const depositTx = deposit.depositChainTransactionId;
  data(await request("POST", `/v1/chain/transactions/${depositTx}/advance`, "demo-finance", { status: "CONFIRMED" }, key("confirm-deposit")));
  const confirmedDonation = data(await request("GET", `/v1/donations/${donation.id}`, "demo-finance"));
  assert.equal(confirmedDonation.status, "MON_DEPOSIT_CONFIRMED");

  const task = data(await request("POST", "/v1/tasks", "demo-reporter", { disasterType: "洪涝", location: "Smoke Site", taskType: "物资", requirements: { material: "水" } }, key("task")));
  data(await request("POST", `/v1/tasks/${task.id}/verify`, "demo-verifier", {}, key("verify")));
  const approvedTask = data(await request("POST", `/v1/tasks/${task.id}/approve`, "demo-verifier", {}, key("approve-task")));
  const taskTx = approvedTask.approvalTxHash || (await request("GET", "/v1/chain/transactions", "demo-finance")).body.data.find(x => x.businessId === task.id).id;
  if (taskTx) await request("POST", `/v1/chain/transactions/${taskTx}/advance`, "demo-finance", { status: "CONFIRMED" }, key("confirm-task"));

  const response = data(await request("POST", `/v1/tasks/${task.id}/responses`, "demo-supplier", { resourceProfileId: "water", quantity: 10, unitPrice: 10, etaHours: 4 }, key("response")));
  const award = data(await request("POST", "/v1/awards", "demo-dispatcher", { responseId: response.id, reason: "Smoke selection" }, key("award")));
  data(await request("POST", `/v1/awards/${award.id}/approve`, "demo-approver", {}, key("approve-award")));
  const contract = data(await request("POST", "/v1/contracts", "demo-approver", { awardId: award.id, party: "Smoke Supplier", subject: "Water", amountMon: 100, plannedQuantity: 10 }, key("contract")));
  const pendingContract = data(await request("POST", `/v1/contracts/${contract.id}/approve`, "demo-approver", {}, key("approve-contract")));
  assert.equal(pendingContract.status, "FUNDS_RESERVATION_PENDING");
  const escrowTx = pendingContract.chainTransactionId;
  await request("POST", `/v1/chain/transactions/${escrowTx}/advance`, "demo-finance", { status: "CONFIRMED" }, key("confirm-escrow"));
  const contractAfterChain = data(await request("GET", `/v1/contracts/${contract.id}`, "demo-finance"));
  const reservedContract = contractAfterChain.status === "FUNDS_RESERVED"
    ? contractAfterChain
    : data(await request("POST", `/v1/contracts/${contract.id}/escrow-confirm`, "demo-finance", {}, key("escrow-confirm")));
  assert.equal(reservedContract.status, "FUNDS_RESERVED");
  const delivery = data(await request("POST", `/v1/contracts/${contract.id}/deliveries`, "demo-supplier", { plannedQuantity: 10 }, key("delivery")));
  expectError(await request("POST", `/v1/deliveries/${delivery.id}/accept`, "demo-acceptance", { deliveredQuantity: 11, acceptedQuantity: 10 }, key("bad-accept")), 409, "INVALID_QUANTITY");
  data(await request("POST", `/v1/deliveries/${delivery.id}/accept`, "demo-acceptance", { deliveredQuantity: 10, acceptedQuantity: 10 }, key("accept")));
  const settlement = data(await request("POST", `/v1/contracts/${contract.id}/settlements`, "demo-finance", { acceptedAmountMon: 100 }, key("settlement")));
  const redemption = data(await request("POST", `/v1/settlements/${settlement.id}/redemptions`, "demo-finance", { monAmount: 100, fiatAmount: 500, payoutAccountId: "acct-smoke" }, key("redemption")));
  const locked = data(await request("POST", `/v1/redemptions/${redemption.id}/approve`, "demo-finance", {}, key("lock")));
  assert.ok(["MON_LOCKED", "MON_REDEMPTION_LOCKED", "MON_LOCK_PENDING"].includes(locked.status));
  if (locked.status !== "MON_LOCKED") {
    const txs = data(await request("GET", "/v1/chain/transactions", "demo-finance"));
    const lockTx = txs.find(x => x.businessId === redemption.id && x.action === "MON_LOCKED");
    assert.ok(lockTx, "MON_LOCKED chain transaction should be created");
    await request("POST", `/v1/chain/transactions/${lockTx.id}/advance`, "demo-finance", { status: "CONFIRMED" }, key("confirm-lock"));
  }
  data(await request("POST", `/v1/redemptions/${redemption.id}/payout`, "demo-finance", { payoutReference: "BANK-SMOKE-1" }, key("payout")));
  const settled = data(await request("POST", `/v1/redemptions/${redemption.id}/settle`, "demo-finance", {}, key("settle")));
  assert.equal(settled.status, "SETTLEMENT_CHAIN_PENDING");
  const settleTxs = data(await request("GET", "/v1/chain/transactions", "demo-finance"));
  const settleTx = settleTxs.find(x => x.businessId === redemption.id && x.action === "MON_SETTLED");
  assert.ok(settleTx, "MON_SETTLED chain transaction should be created");
  await request("POST", `/v1/chain/transactions/${settleTx.id}/advance`, "demo-finance", { status: "CONFIRMED" }, key("confirm-settle"));
  const finalRedemption = data(await request("GET", `/v1/redemptions/${redemption.id}`, "demo-finance"));
  assert.equal(finalRedemption.status, "SETTLED");

  const trace = await request("GET", `/v1/public/trace/${donation.id}`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.data.watermark.id, donation.id);
  assert.equal(trace.body.data.watermark.fiatAmount, undefined);
  console.log("backend smoke: PASS");
}

run().catch(error => {
  console.error("backend smoke: FAIL", error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit"); server.kill(); await exited;
  }
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith("relief-mon-smoke-"));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}).catch(error => {
  console.error("backend smoke cleanup: FAIL", error.stack || error); process.exitCode = 1;
});
