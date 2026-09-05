const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-integration-"));
const stateFile = path.join(dataDir, "state.json");
const admin = "demo-platform-admin", donor = "demo-donor";
let server, base, sequence = 0;
const key = () => `integration-${++sequence}`;

async function start() {
  server = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
    env: { ...process.env, PORT: "0", DATA_DIR: dataDir, RELIEF_ENABLE_LEGACY_DEMO: "true" }, stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Startup timed out")), 10000);
    server.once("error", reject);
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    let output = "";
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timer); resolve(); }
    });
    server.stderr.on("data", chunk => process.stderr.write(chunk));
  });
}
async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}
async function request(method, route, token, payload, idem) {
  const response = await fetch(base + route, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, type, body: type.includes("application/json") ? await response.json() : await response.arrayBuffer() };
}
function data(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error, undefined);
  return result.body.data;
}
function failure(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
}
const get = (route, token) => request("GET", route, token);
const post = (route, token, payload = {}, idem = key()) => request("POST", route, token, payload, idem);

function assertInitialFunds(view) {
  const first = view.donations.find(d => d.id === "DON-001");
  const second = view.donations.find(d => d.id === "DON-002");
  assert.equal(first.fund.availableMon, 6754640);
  assert.equal(first.fund.escrowedMon, 45360);
  assert.equal(second.fund.availableMon, 2100000);
  assert.equal(second.fund.escrowedMon, 0);
  const flow = view.process.moneyFlow;
  assert.equal(flow.depositedMon, 8900000);
  assert.equal(flow.availableMon, 8854640);
  assert.equal(flow.escrowedMon, 45360);
  assert.equal(flow.pendingMon, 0);
  assert.equal(flow.availableMon + flow.escrowedMon + flow.lockedMon + flow.settledMon, flow.depositedMon);
  for (const donation of [first, second]) assert.equal(donation.fund.availableMon + donation.fund.escrowedMon, donation.monAmount);
  assert.equal(view.dashboard.availableMon, flow.availableMon);
  assert.equal(view.dashboard.escrowMon, flow.escrowedMon);
  assert.equal(view.contracts.find(c => c.id === "CTR-001").escrowDebited, true);
}

async function run() {
  await start();
  const publicView = data(await get("/v1/public/overview"));
  const privateView = data(await get("/v1/overview", admin));
  assertInitialFunds(privateView);
  assert.deepEqual(data(await get("/v1/donations", donor)), [], "Unowned seed donations are not personal funds");
  const items = data(await get("/v1/marketplace"));
  assert.ok(items.length >= 10);
  assert.deepEqual(publicView.marketplace, items);
  assert.deepEqual(privateView.marketplace, items);
  assert.deepEqual(publicView.dashboard, privateView.dashboard);
  assert.equal(publicView.dataMode, "demo");
  assert.ok(!Number.isNaN(Date.parse(publicView.updatedAt)));
  for (const field of ["donations", "marketOrders", "traces", "process"]) assert.equal(publicView[field], undefined);
  assert.equal(new Set(items.map(item => item.category)).size, 5);
  for (const item of items) {
    for (const field of ["id", "name", "category", "priceMon", "unit", "stock", "supplier", "etaHours", "image", "description", "specs"]) assert.notEqual(item[field], undefined);
    assert.ok(item.specs.every(spec => typeof spec === "string"));
    assert.match(item.image, /^\/shared\/assets\/[a-z-]+\.png$/);
    const image = await get(item.image);
    assert.equal(image.status, 200);
    assert.equal(image.type, "image/png");
    assert.equal(Buffer.from(image.body).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  for (const task of publicView.tasks) {
    assert.equal(task.dataMode, "demo");
    for (const field of ["monTarget", "monRaised", "participants", "participantTarget", "articleId", "sections", "urgencyLabel", "need"]) assert.notEqual(task[field], undefined);
    assert.ok(task.sections.every(section => "title" in section && "value" in section));
    for (const title of ["物资目标", "人力人数", "交付验收", "合同进度"]) assert.ok(task.sections.some(section => section.title === title));
    for (const field of Object.keys(task)) assert.deepEqual(task[field], privateView.tasks.find(t => t.id === task.id)[field]);
  }
  assert.equal(publicView.dashboard.poolTargetMon, publicView.tasks.reduce((sum, t) => sum + t.monTarget, 0));
  assert.equal(publicView.dashboard.participantCount, publicView.tasks.reduce((sum, t) => sum + t.participants, 0));
  assert.ok(publicView.disasterUpdates.length >= 2);
  for (const article of publicView.disasterUpdates) {
    assert.equal(article.dataMode, "reported");
    assert.ok(article.sourceUrl.startsWith("https://"));
    assert.deepEqual(article.relatedTasks, []);
    assert.ok(article.stats.length && article.paragraphs.length);
    assert.ok(!publicView.tasks.some(t => t.articleId === article.id));
  }
  failure(await get("/v1/overview"), 401, "AUTH_REQUIRED");
  failure(await get("/v1/overview", donor), 403, "ROLE_NOT_ALLOWED");
  failure(await get("/v1/market-orders"), 401, "AUTH_REQUIRED");
  failure(await get("/v1/market-orders", "demo-supplier"), 403, "ROLE_NOT_ALLOWED");

  const item = items[0], taskId = publicView.tasks[0].id;
  const payload = { itemId: item.id, taskId, quantity: 2, unitPriceMon: 0, totalMon: 0 };
  failure(await post("/v1/market-orders", "demo-supplier", payload), 403, "ROLE_NOT_ALLOWED");
  failure(await request("POST", "/v1/market-orders", donor, payload), 400, "IDEMPOTENCY_KEY_REQUIRED");
  for (const quantity of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    failure(await post("/v1/market-orders", donor, { ...payload, quantity }), 400, "INVALID_QUANTITY");
  }
  failure(await post("/v1/market-orders", donor, { ...payload, quantity: item.stock + 1 }), 409, "INSUFFICIENT_STOCK");
  failure(await post("/v1/market-orders", donor, { ...payload, itemId: "missing" }), 404, "NOT_FOUND");
  failure(await post("/v1/market-orders", donor, { ...payload, taskId: "missing" }), 404, "NOT_FOUND");
  const creationKey = key();
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => post("/v1/market-orders", donor, payload, creationKey)));
  const order = data(duplicates[0], 201);
  duplicates.forEach(result => assert.deepEqual(data(result, 201), order));
  assert.equal(order.unitPriceMon, item.priceMon);
  assert.equal(order.totalMon, 2 * item.priceMon);
  assert.equal(order.status, "PENDING_REVIEW");
  assert.equal(order.contractId, null);
  assert.equal(data(await get("/v1/marketplace"))[0].stock, item.stock);
  failure(await post("/v1/market-orders", donor, { ...payload, quantity: 3 }, creationKey), 409, "IDEMPOTENCY_KEY_REUSED");
  failure(await post(`/v1/market-orders/${order.id}/approve`, donor), 403, "ROLE_NOT_ALLOWED");
  const approvalKey = key();
  const approved = data(await post(`/v1/market-orders/${order.id}/approve`, admin, {}, approvalKey));
  assert.equal(approved.status, "APPROVED");
  assert.ok(approved.contractId);
  assert.deepEqual(data(await post(`/v1/market-orders/${order.id}/approve`, admin, {}, approvalKey)), approved);
  assert.deepEqual(data(await post(`/v1/market-orders/${order.id}/approve`, admin)), approved);
  failure(await post(`/v1/market-orders/${order.id}/approve`, donor, {}, approvalKey), 403, "ROLE_NOT_ALLOWED");
  failure(await post(`/v1/market-orders/${order.id}/reject`, admin), 409, "INVALID_STATE_TRANSITION");
  assert.deepEqual(data(await post("/v1/market-orders", donor, payload, creationKey), 201), order);
  const contract = data(await get(`/v1/contracts/${approved.contractId}`, admin));
  assert.equal(contract.status, "PENDING_APPROVAL");
  assert.equal(contract.taskId, taskId);
  assert.equal(contract.marketOrderId, order.id);
  assert.equal(contract.amountMon, order.totalMon);
  assert.equal(contract.chainTransactionId, undefined);
  assert.equal(data(await get("/v1/marketplace"))[0].stock, item.stock - 2);

  const rejectedOrder = data(await post("/v1/market-orders", donor, payload), 201);
  failure(await post(`/v1/market-orders/${rejectedOrder.id}/reject`, "demo-finance"), 403, "ROLE_NOT_ALLOWED");
  const rejected = data(await post(`/v1/market-orders/${rejectedOrder.id}/reject`, admin));
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.contractId, null);
  assert.deepEqual(data(await post(`/v1/market-orders/${rejected.id}/reject`, admin)), rejected);
  failure(await post(`/v1/market-orders/${rejected.id}/approve`, admin), 409, "INVALID_STATE_TRANSITION");
  assert.equal(data(await get("/v1/marketplace"))[0].stock, item.stock - 2);

  const limited = items.find(x => x.id === "SVC-RESCUE");
  const competing = await Promise.all([1, 2].map(() => post("/v1/market-orders", donor, { itemId: limited.id, taskId, quantity: limited.stock })));
  const outcomes = await Promise.all(competing.map(result => post(`/v1/market-orders/${data(result, 201).id}/approve`, admin)));
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
  failure(outcomes.find(result => result.status === 409), 409, "INSUFFICIENT_STOCK");
  const afterOrders = data(await get("/v1/overview", admin));
  assert.equal(afterOrders.marketplace.find(x => x.id === limited.id).stock, 0);
  assert.equal(afterOrders.contracts.length, privateView.contracts.length + 2);
  assert.deepEqual(afterOrders.process.moneyFlow, privateView.process.moneyFlow);
  assert.deepEqual(data(await get("/v1/chain/transactions", admin)), []);

  const donationKey = key(), intent = { donor: "Private test donor", monIntentAmount: 150, policy: { region: "demo" } };
  for (const monIntentAmount of [0, -1, "150", null]) failure(await post("/v1/donations", donor, { ...intent, monIntentAmount }), 400, "INVALID_AMOUNT");
  const donation = data(await post("/v1/donations", donor, intent, donationKey), 201);
  assert.equal(donation.status, "MON_REVIEW_PENDING");
  assert.equal(donation.fiatAmount, 0);
  assert.deepEqual(data(await post("/v1/donations", donor, intent, donationKey), 201), donation);
  failure(await post(`/v1/donations/${donation.id}/mon-deposit`, "demo-finance", {}), 409, "INVALID_STATE_TRANSITION");
  failure(await post(`/v1/donations/${donation.id}/compliance-review`, donor, { decision: "approve" }), 403, "ROLE_NOT_ALLOWED");
  assert.equal(data(await post(`/v1/donations/${donation.id}/compliance-review`, "demo-compliance", { decision: "approve" })).status, "APPROVED");
  failure(await post(`/v1/donations/${donation.id}/mon-deposit`, "demo-finance", { amountMon: 151 }), 400, "INVALID_AMOUNT");
  const deposited = data(await post(`/v1/donations/${donation.id}/mon-deposit`, "demo-finance"), 202);
  assert.equal(deposited.status, "MON_DEPOSIT_PENDING");
  assert.equal(deposited.monAmount, 150);
  assert.equal(deposited.fund.availableMon, 0);
  assert.equal(deposited.depositTxHash, null);
  const queued = data(await get(`/v1/chain/transactions/${deposited.depositChainTransactionId}`, admin));
  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.txHash, null);
  assert.equal(queued.confirmations, 0);
  assert.deepEqual(data(await get("/v1/donations", donor)).map(d => d.id), [donation.id]);
  failure(await get("/v1/donations/DON-001", donor), 403, "SCOPE_DENIED");
  failure(await get("/v1/details/donation/DON-001", donor), 403, "SCOPE_DENIED");
  failure(await get("/v1/donations/DON-001/certificate", donor), 403, "SCOPE_DENIED");
  assert.ok(!JSON.stringify(data(await get("/v1/public/overview"))).includes(intent.donor));

  const zeroTask = data(await post("/v1/tasks", "demo-reporter", { title: "Zero test", monTarget: 0, monRaised: 0, participants: 0, participantTarget: 0, sections: [{ title: "Zero", value: 0 }] }), 201);
  assert.equal(zeroTask.monTarget, 0);
  assert.equal(zeroTask.sections[0].value, 0);
  const assertHiddenTask = async task => {
    const publicOverview = data(await get("/v1/public/overview"));
    assert.ok(!publicOverview.tasks.some(t => t.id === task.id));
    assert.ok(!publicOverview.contracts.some(c => c.taskId === task.id));
    assert.equal(publicOverview.dashboard.poolTargetMon, publicView.dashboard.poolTargetMon);
    assert.equal(publicOverview.dashboard.participantCount, publicView.dashboard.participantCount);
    for (const token of [undefined, donor]) assert.ok(!data(await get("/v1/tasks", token)).some(t => t.id === task.id));
    assert.ok(data(await get("/v1/overview", admin)).tasks.some(t => t.id === task.id));
    assert.ok(data(await get("/v1/tasks", "demo-reporter")).some(t => t.id === task.id));
    failure(await post("/v1/market-orders", donor, { ...payload, taskId: task.id }), 404, "NOT_FOUND");
  };
  await assertHiddenTask(zeroTask);
  data(await post(`/v1/tasks/${zeroTask.id}/verify`, "demo-verifier"));
  await assertHiddenTask(zeroTask);
  for (const privacy of [{ visibility: "PRIVATE" }, { isPrivate: true }]) {
    const privateTask = data(await post("/v1/tasks", "demo-reporter", { title: "Private task", monTarget: 500, participants: 12, ...privacy }), 201);
    data(await post(`/v1/tasks/${privateTask.id}/verify`, "demo-verifier"));
    data(await post(`/v1/tasks/${privateTask.id}/approve`, "demo-verifier"));
    await assertHiddenTask(privateTask);
  }
  data(await post(`/v1/tasks/${zeroTask.id}/approve`, "demo-verifier"));
  assert.ok(data(await get("/v1/public/overview")).tasks.some(t => t.id === zeroTask.id));
  assert.ok(data(await get("/v1/tasks")).some(t => t.id === zeroTask.id));
  for (const route of ["/", "/mobile", "/mobile/", "/mobile/index.html", "/admin", "/admin/", "/admin/index.html"]) {
    const page = await get(route);
    assert.equal(page.status, 200, route);
    assert.match(page.type, /text\/html/);
  }
  for (const route of ["/mobile/style.css", "/admin/style.css", "/shared/api.js"]) assert.equal((await get(route)).status, 200, route);
  for (const route of ["/v1/not-found", "/v1/public/not-found", "/api/not-found", "/mobile/missing.js"]) failure(await get(route), 404, "NOT_FOUND");
  failure(await request("POST", "/v1/not-found", admin, {}), 404, "NOT_FOUND");
  failure(await get("/shared/%2e%2e%5c%2e%2e%5cbackend/server.js"), 403, "FORBIDDEN");
  const missingAssets = [];
  for (const image of new Set(items.map(x => x.image))) {
    if (!fs.existsSync(path.join(__dirname, "../../web", image))) { missingAssets.push(image); continue; }
    const result = await get(image);
    assert.equal(result.status, 200);
    assert.equal(result.type, "image/png");
    assert.deepEqual([...new Uint8Array(result.body).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  if (missingAssets.length) console.log(`Assets supplied separately; not yet present: ${missingAssets.join(", ")}`);

  await stop();
  // Persisted fixtures exercise ownership isolation and zero-valued migrations.
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  saved.marketOrders.push({ ...order, id: "MOR-OTHER", donorUserId: "another-donor" });
  saved.donations.push(
    { id: "DON-SAME-ORG", donorUserId: "another-donor", organizationId: "org-donor", status: "MON_REVIEW_PENDING" },
    { id: "DON-NO-OWNER", status: "MON_REVIEW_PENDING" },
    { id: "DON-EMPTY-OWNER", donorUserId: null, organizationId: "", status: "MON_REVIEW_PENDING" },
    { id: "DON-OTHER-ORG", organizationId: "org-other", status: "MON_REVIEW_PENDING" }
  );
  const savedTask = saved.tasks.find(t => t.id === taskId);
  savedTask.participants = 0;
  savedTask.monTarget = 0;
  savedTask.monRaised = 0;
  savedTask.participantTarget = 0;
  saved.donations.forEach(d => { if (d.fund) d.fund.availableMon = 0; });
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  await start();
  const restarted = data(await get("/v1/overview", admin));
  assert.deepEqual(data(await get("/v1/donations", donor)).map(d => d.id).sort(), [donation.id, "DON-SAME-ORG"].sort());
  assert.equal(data(await get("/v1/donations/DON-SAME-ORG", donor)).id, "DON-SAME-ORG");
  for (const id of ["DON-001", "DON-002", "DON-NO-OWNER", "DON-EMPTY-OWNER", "DON-OTHER-ORG"]) failure(await get(`/v1/donations/${id}`, donor), 403, "SCOPE_DENIED");
  assert.equal(restarted.dashboard.availableMon, 0);
  const restartedTask = restarted.tasks.find(t => t.id === taskId);
  for (const field of ["participants", "monTarget", "monRaised", "participantTarget"]) assert.equal(restartedTask[field], 0);
  assert.equal(restarted.marketplace.find(x => x.id === limited.id).stock, 0);
  assert.ok(restarted.marketOrders.some(x => x.id === "MOR-OTHER"));
  assert.ok(data(await get("/v1/market-orders", donor)).every(x => x.donorUserId === donor));
  assert.deepEqual(data(await post(`/v1/market-orders/${order.id}/approve`, admin, {}, approvalKey)), approved);
  assert.deepEqual(data(await post("/v1/market-orders", donor, payload, creationKey), 201), order);
  assert.equal(data(await get("/v1/contracts", admin)).filter(c => c.marketOrderId === order.id).length, 1);
  assert.deepEqual(data(await get("/v1/public/overview")).marketplace, restarted.marketplace);
  assert.equal(data(await get(`/v1/donations/${donation.id}`, donor)).status, "MON_DEPOSIT_PENDING");

  const legacyTasks = [
    { id: "TASK-001", disasterType: "洪涝", location: "河北涞源东口安置点", taskType: "生命救援", severity: "critical", status: "DISPATCHING", verificationStatus: "VERIFIED", requirements: { material: "饮用水 42,000 件 / 水域救援队 24 人" } },
    { id: "TASK-002", disasterType: "地震", location: "甘肃积石山第三安置区", taskType: "医疗救助", severity: "high", status: "EXECUTING", verificationStatus: "VERIFIED", requirements: { material: "医疗物资 18,000 件 / 医疗急救 16 人" } }
  ];
  const variations = [
    legacyTasks,
    legacyTasks.map(t => ({ ...t, location: "User location", disasterType: "User disaster", taskType: "User task type" })),
    legacyTasks.map(t => ({ ...t, title: "User title", requirements: { material: "User supplies", staff: 0 }, sections: [{ title: "物资目标", value: 0 }] })),
    legacyTasks.map(t => ({ ...t, userNote: "Keep even when default location/type are unchanged" }))
  ];
  await stop();
  const fixture = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const existingContract = fixture.contracts.find(c => c.id === "CTR-001");
  existingContract.escrowDebited = false;
  const existingDonations = structuredClone(fixture.donations);
  const existingContracts = structuredClone(fixture.contracts);
  for (const [index, tasks] of variations.entries()) {
    fixture.tasks = tasks;
    fs.writeFileSync(stateFile, JSON.stringify(fixture));
    await start();
    const migrated = data(await get("/v1/overview", admin));
    assert.deepEqual(migrated.donations, existingDonations, "Loading must not rebalance existing funds");
    assert.deepEqual(migrated.contracts, existingContracts, "Loading must not mark existing contracts debited");
    for (const original of tasks) {
      const actual = migrated.tasks.find(t => t.id === original.id);
      if (index === 0) {
        assert.match(actual.location, /演练/);
        assert.notEqual(actual.disasterType, original.disasterType);
      } else {
        for (const field of Object.keys(original).filter(field => field !== "sections")) assert.deepEqual(actual[field], original[field], `${original.id}.${field}`);
        if (original.sections) assert.deepEqual(actual.sections.slice(0, original.sections.length), original.sections);
      }
    }
    await stop();
  }
  await start();
  data(await post("/v1/demo/reset", admin));
  assertInitialFunds(data(await get("/v1/overview", admin)));
  console.log("backend integration: PASS");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  await stop();
  const resolved = path.resolve(dataDir);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("relief-integration-")) fs.rmSync(resolved, { recursive: true, force: true });
});
