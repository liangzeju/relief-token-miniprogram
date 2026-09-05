const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const admin = "demo-platform-admin";
const supplier = "demo-supplier";
const verifier = "demo-verifier";
const publicFields = ["id", "title", "disasterType", "location", "taskType", "severity", "status",
  "verificationStatus", "monTarget", "monRaised", "participants", "participantTarget", "articleId",
  "sections", "urgencyLabel", "need", "image", "dataMode"].sort();

function seed() {
  const task = { title: "Boundary fixture", disasterType: "Exercise", location: "Test site",
    taskType: "Supplies", severity: "normal", status: "DISPATCHING", verificationStatus: "VERIFIED",
    reporterUserId: "demo-reporter", organizationId: "org-relief", need: "Public supplies",
    requirements: { internal: "PRIVATE_REQUIREMENTS" }, internalNote: "PRIVATE_NOTE",
    evidenceIds: ["PRIVATE_EVIDENCE"], verifiedBy: verifier };
  const contract = { taskId: "TASK-PUBLIC", status: "FUNDS_RESERVED", plannedQuantity: 100,
    progress: 15, amountMon: 100, organizationId: "org-platform" };
  const delivery = { status: "IN_PROGRESS", plannedQuantity: 1, evidenceIds: ["DELIVERY_EVIDENCE"] };
  return {
    tasks: [
      { ...task, id: "TASK-PUBLIC" },
      { ...task, id: "TASK-PRIVATE", visibility: "PRIVATE" },
      { ...task, id: "TASK-PRIVATE-FLAG", isPrivate: true },
      { ...task, id: "TASK-LEGACY-PRIVATE", private: true },
      { ...task, id: "TASK-REPORTED", status: "REPORTED", verificationStatus: "PENDING" },
      { ...task, id: "TASK-VERIFYING", status: "VERIFYING" },
      { ...task, id: "TASK-UNVERIFIED", verificationStatus: "PENDING" },
      { ...task, id: "TASK-SELF-VERIFY", status: "REPORTED", verificationStatus: "PENDING", reporterUserId: verifier },
      { ...task, id: "TASK-SELF-APPROVE", status: "VERIFYING", reporterUserId: verifier }
    ],
    contracts: [
      { ...contract, id: "CTR-OWN", supplierOrganizationId: "org-supplier" },
      { ...contract, id: "CTR-OTHER", supplierOrganizationId: "org-other" },
      { ...contract, id: "CTR-BUYER", organizationId: "org-supplier", supplierOrganizationId: "org-other" },
      { ...contract, id: "CTR-UNASSIGNED", supplierOrganizationId: null }
    ],
    deliveries: [
      { ...delivery, id: "DEL-OWN", contractId: "CTR-OTHER", organizationId: "org-supplier" },
      { ...delivery, id: "DEL-CONTRACT", contractId: "CTR-OWN", organizationId: "org-platform" },
      { ...delivery, id: "DEL-OTHER", contractId: "CTR-OTHER", organizationId: "org-other" },
      { ...delivery, id: "DEL-UNASSIGNED", contractId: "missing" }
    ],
    redemptions: [
      { id: "SET-OWN", contractId: "CTR-OWN", status: "SETTLEMENT_PENDING", acceptedAmountMon: 1 },
      { id: "SET-OTHER", contractId: "CTR-OTHER", status: "SETTLEMENT_PENDING", acceptedAmountMon: 1 },
      { id: "RED-OWN", settlementId: "SET-OWN", organizationId: "org-supplier", status: "REQUESTED", monAmount: 1 },
      { id: "RED-OTHER", settlementId: "SET-OTHER", organizationId: "org-other", status: "REQUESTED", monAmount: 1 }
    ],
    donations: [], responses: [], awards: [], traces: [], chainTransactions: [], auditEvents: [], idempotency: {}
  };
}

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-access-boundaries-"));
  const stateFile = path.join(dataDir, "state.json");
  let server;
  t.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("relief-access-boundaries-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.writeFileSync(stateFile, JSON.stringify(seed()));
  const env = { ...process.env, PORT: "0", DATA_DIR: dataDir, RELIEF_ENABLE_LEGACY_DEMO: "true",
    PUBLIC_BASE_URL: "http://127.0.0.1", CORS_ORIGIN: "http://127.0.0.1",
    MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1",
    MONAD_CONFIRMATIONS: "2" };
  // Never inherit a live pool or Node preload into the isolated server.
  for (const name of ["MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "NODE_OPTIONS"]) delete env[name];
  server = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  const base = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 10000);
    const fail = error => { clearTimeout(timer); reject(error); };
    server.once("error", fail);
    server.once("exit", code => fail(new Error(`Server exited ${code}: ${errors}`)));
    server.stderr.on("data", chunk => { errors += chunk; });
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  let sequence = 0;
  async function request(method, route, token, payload) {
    const response = await fetch(base + route, {
      method, signal: AbortSignal.timeout(5000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": `boundary-${++sequence}` }) },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json(), route };
  }
  return { get: (route, token) => request("GET", route, token),
    post: (route, token, payload = {}) => request("POST", route, token, payload),
    saved: () => fs.readFileSync(stateFile, "utf8") };
}

function data(result, status = 200) {
  assert.equal(result.status, status, `${result.route}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, undefined);
  return result.body.data;
}
function denied(result, status, code) {
  assert.equal(result.status, status, `${result.route}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error.code, code);
  assert.equal(result.body.data, null);
}

test("HTTP access boundaries with isolated data", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await t.test("public detail uses the list whitelist; private and unpublished tasks require scope", async () => {
    for (const token of [undefined, "invalid-token", "demo-donor", supplier]) {
      const visible = data(await f.get("/v1/tasks", token));
      assert.deepEqual(visible.map(task => task.id), ["TASK-PUBLIC"]);
      const detail = data(await f.get("/v1/tasks/TASK-PUBLIC", token));
      assert.deepEqual(detail, visible[0]);
      assert.deepEqual(Object.keys(detail).sort(), publicFields);
      assert.ok(!JSON.stringify(detail).includes("PRIVATE_"));
      for (const task of seed().tasks.filter(task => task.id !== "TASK-PUBLIC")) {
        denied(await f.get(`/v1/tasks/${task.id}`, token), token && token !== "invalid-token" ? 403 : 401,
          token && token !== "invalid-token" ? "SCOPE_DENIED" : "AUTH_REQUIRED");
      }
    }
    for (const token of ["demo-reporter", "demo-acceptance", verifier, "demo-dispatcher", "demo-finance", "demo-compliance", admin]) {
      assert.equal(data(await f.get("/v1/tasks/TASK-PRIVATE", token)).internalNote, "PRIVATE_NOTE");
      assert.equal(data(await f.get("/v1/tasks/TASK-PUBLIC", token)).reporterUserId, "demo-reporter");
    }
    denied(await f.get("/v1/tasks/missing"), 404, "NOT_FOUND");
  });

  await t.test("delivery list and detail honor ownership and contract supplier scope", async () => {
    const own = data(await f.get("/v1/deliveries", supplier));
    assert.deepEqual(own.map(item => item.id).sort(), ["DEL-CONTRACT", "DEL-OWN"]);
    for (const item of own) assert.deepEqual(data(await f.get(`/v1/deliveries/${item.id}`, supplier)).item, item);
    for (const id of ["DEL-OTHER", "DEL-UNASSIGNED"]) {
      denied(await f.get(`/v1/deliveries/${id}`, supplier), 403, "SCOPE_DENIED");
    }
    for (const token of ["demo-acceptance", "demo-finance", admin]) {
      assert.equal(data(await f.get("/v1/deliveries", token)).length, 4);
      assert.equal(data(await f.get("/v1/deliveries/DEL-OTHER", token)).item.id, "DEL-OTHER");
    }
    for (const token of [undefined, "demo-donor", "demo-compliance"]) {
      denied(await f.get("/v1/deliveries", token), 401, "AUTH_REQUIRED");
      denied(await f.get("/v1/deliveries/DEL-OWN", token), 401, "AUTH_REQUIRED");
    }
  });

  await t.test("contract, settlement and redemption reads retain existing role gates and scopes", async () => {
    for (const [route, ids, tokens] of [
      ["contracts", seed().contracts.map(item => item.id), ["demo-finance", "demo-approver", admin]],
      ["redemptions", ["RED-OWN", "RED-OTHER"], ["demo-finance", "demo-compliance", admin]],
      ["settlements", ["SET-OWN", "SET-OTHER"], ["demo-finance", admin]]
    ]) {
      for (const token of tokens) {
        assert.deepEqual(data(await f.get(`/v1/${route}`, token)).map(item => item.id).sort(), [...ids].sort());
        for (const id of ids) {
          const item = data(await f.get(`/v1/${route}/${id}`, token));
          assert.equal((route === "settlements" ? item.item : item).id, id);
        }
      }
      denied(await f.get(`/v1/${route}`, supplier), 401, "AUTH_REQUIRED");
      denied(await f.get(`/v1/${route}`), 401, "AUTH_REQUIRED");
    }
    for (const [route, id] of [["contracts", "CTR-OWN"], ["redemptions", "RED-OWN"]]) {
      for (const token of [undefined, supplier, "demo-dispatcher", "demo-donor"]) {
        denied(await f.get(`/v1/${route}/${id}`, token), 401, "AUTH_REQUIRED");
      }
      denied(await f.get(`/v1/${route}/missing`, admin), 404, "NOT_FOUND");
    }
    denied(await f.get("/v1/redemptions/SET-OWN", admin), 404, "NOT_FOUND");
    for (const [type, own, other] of [["contract", "CTR-OWN", "CTR-OTHER"],
      ["settlement", "SET-OWN", "SET-OTHER"], ["redemption", "RED-OWN", "RED-OTHER"]]) {
      assert.equal(data(await f.get(`/v1/details/${type}/${own}`, supplier)).item.id, own);
      denied(await f.get(`/v1/details/${type}/${other}`, supplier), 403, "SCOPE_DENIED");
    }
    assert.equal(data(await f.get("/v1/settlements/SET-OWN", supplier)).item.id, "SET-OWN");
    denied(await f.get("/v1/settlements/SET-OTHER", supplier), 403, "SCOPE_DENIED");
  });

  await t.test("supplier cannot create delivery for another supplier, even as contract buyer", async () => {
    const before = data(await f.get("/v1/overview", admin));
    const saved = f.saved();
    for (const id of ["CTR-OTHER", "CTR-BUYER", "CTR-UNASSIGNED"]) {
      denied(await f.post(`/v1/contracts/${id}/deliveries`, supplier,
        { plannedQuantity: 1, organizationId: "org-other" }), 403, "SCOPE_DENIED");
    }
    denied(await f.post("/v1/contracts/CTR-OWN/deliveries", "demo-donor", { plannedQuantity: 1 }), 403, "ROLE_NOT_ALLOWED");
    assert.equal(f.saved(), saved);
    assert.deepEqual(data(await f.get("/v1/overview", admin)), before);
    const own = data(await f.post("/v1/contracts/CTR-OWN/deliveries", supplier, { plannedQuantity: 1 }), 201);
    assert.equal(own.organizationId, "org-supplier");
    assert.equal(own.createdBy, supplier);
    assert.equal(data(await f.post("/v1/contracts/CTR-OTHER/deliveries", admin, { plannedQuantity: 1 }), 201).createdBy, admin);
    assert.deepEqual(data(await f.get("/v1/overview", admin)).process.moneyFlow, before.process.moneyFlow);
  });

  await t.test("reporter cannot verify or approve their own task, including platform admins", async () => {
    const created = data(await f.post("/v1/tasks", admin, { title: "Admin self-review", visibility: "PRIVATE" }), 201);
    // A different user can verify it, so self-approval is tested in a valid state.
    data(await f.post(`/v1/tasks/${created.id}/verify`, verifier));
    const before = data(await f.get("/v1/overview", admin));
    const saved = f.saved();
    for (const [id, token, action] of [["TASK-SELF-VERIFY", verifier, "verify"],
      ["TASK-SELF-APPROVE", verifier, "approve"], [created.id, admin, "verify"], [created.id, admin, "approve"]]) {
      denied(await f.post(`/v1/tasks/${id}/${action}`, token), 403, "SELF_REVIEW_NOT_ALLOWED");
    }
    denied(await f.post("/v1/tasks/TASK-REPORTED/verify", "demo-reporter"), 403, "ROLE_NOT_ALLOWED");
    assert.equal(f.saved(), saved);
    assert.deepEqual(data(await f.get("/v1/overview", admin)), before);
    // Same organization and same verifier for both steps remain allowed.
    assert.equal(data(await f.post("/v1/tasks/TASK-REPORTED/verify", verifier)).verificationStatus, "VERIFIED");
    assert.equal(data(await f.post("/v1/tasks/TASK-REPORTED/approve", verifier)).status, "DISPATCHING");
    assert.equal(data(await f.post(`/v1/tasks/${created.id}/approve`, verifier)).status, "DISPATCHING");
    for (const [id, action] of [["TASK-REPORTED", "verify"], ["TASK-REPORTED", "approve"],
      ["TASK-VERIFYING", "verify"], ["TASK-PUBLIC", "approve"]]) {
      denied(await f.post(`/v1/tasks/${id}/${action}`, verifier), 409, "INVALID_STATE_TRANSITION");
    }
    denied(await f.post("/v1/tasks/TASK-UNVERIFIED/responses", supplier,
      { resourceProfileId: "MAT-WATER", quantity: 1, unitPrice: 1 }), 409, "INVALID_STATE_TRANSITION");
    assert.deepEqual(data(await f.get("/v1/overview", admin)).process.moneyFlow, before.process.moneyFlow);
  });
});
