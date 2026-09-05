const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { isDeepStrictEqual } = require("util");
const { marketplace, demoTasks, enrichTask, disasterUpdates } = require("./catalog");
const { createWalletService } = require("./wallet-service");
const { createAdminSessions } = require("./admin-sessions");
const { createStateStore } = require("./state-store");
const { createPlatformService } = require("./platform-service");
const { createDonationIntentStore } = require("./donation-intent-store");
const { createFundingStore } = require("./funding-store");
const { createFundingReadService } = require("./funding-read-service");
const { createFundingIndexer } = require("./funding-indexer");
const { readFundingIndexerConfig, createFundingIndexerRuntime } = require("./funding-indexer-runtime");
const { JsonRpcProvider } = require("ethers");
const { readJsonBody: body } = require("./json-body");

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "state.json");
const NETWORK = { name: "monad-testnet", chainId: 10143 };
const DEPLOYMENT_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || DEPLOYMENT_URL;
const CORS_ORIGIN = process.env.CORS_ORIGIN || new URL(PUBLIC_BASE_URL).origin;
// Do not expose a fake contract address when the testnet pool has not been deployed.
// MONAD_POOL_ADDRESS is the verified wallet-service configuration; use it for the
// public projection when a separate display override is not supplied.
const configuredContractAddress = process.env.MONAD_CONTRACT_ADDRESS || process.env.MONAD_POOL_ADDRESS || "";
const CONTRACT_ADDRESS = /^0x[0-9a-fA-F]{40}$/.test(configuredContractAddress) ? configuredContractAddress : null;
const LEGACY_DEMO = process.env.RELIEF_ENABLE_LEGACY_DEMO === "true" && process.env.NODE_ENV !== "production";
const WALLET_STAGING = process.env.RELIEF_ENABLE_WALLET_PROTOTYPE === "true" && process.env.NODE_ENV !== "production";
const FUNDING_INDEXER_CONFIG = readFundingIndexerConfig(process.env);
const DEMO_TOKENS = {
  "demo-donor": { userId: "demo-donor", organizationId: "org-donor", roles: ["donor"] },
  "demo-reporter": { userId: "demo-reporter", organizationId: "org-relief", roles: ["reporter"] },
  "demo-platform-admin": { userId: "demo-platform-admin", organizationId: "org-platform", roles: ["platform_admin"] },
  "demo-compliance": { userId: "demo-compliance", organizationId: "org-platform", roles: ["compliance"] },
  "demo-finance": { userId: "demo-finance", organizationId: "org-platform", roles: ["finance"] },
  "demo-verifier": { userId: "demo-verifier", organizationId: "org-relief", roles: ["official_verifier"] },
  "demo-dispatcher": { userId: "demo-dispatcher", organizationId: "org-platform", roles: ["dispatcher"] },
  "demo-approver": { userId: "demo-approver", organizationId: "org-platform", roles: ["contract_approver"] },
  "demo-supplier": { userId: "demo-supplier", organizationId: "org-supplier", roles: ["supplier"] },
  "demo-acceptance": { userId: "demo-acceptance", organizationId: "org-relief", roles: ["acceptance"] }
};
// Keep the actor tied to the current async request. Do not store request
// identity in mutable process-wide state.
const requestContext = new AsyncLocalStorage();
const systemActor = { userId: null, organizationId: null, roles: [] };
function currentActor() { return requestContext.getStore() || systemActor; }

function id(prefix) { return `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`; }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function now() { return new Date().toISOString(); }
function emptyState() {
  return {
    donations: [
      { id: "DON-001", donor: "华北救援众筹池", fiatAmount: 6800000, monAmount: 6800000, status: "MON_DEPOSIT_CONFIRMED", watermarkId: "WM-001", createdAt: "2026-08-31T01:10:00.000Z", depositTxHash: "0xmon4a72c0ef91f0b6d9921e2c7a980c4a2a", fund: { id: "FUND-001", donationId: "DON-001", amountMon: 6800000, availableMon: 6754640, escrowedMon: 45360, watermarkId: "WM-001" } },
      { id: "DON-002", donor: "星火公益直播专场", fiatAmount: 2100000, monAmount: 2100000, status: "MON_DEPOSIT_CONFIRMED", watermarkId: "WM-002", createdAt: "2026-08-31T01:48:00.000Z", depositTxHash: "0xmonb960472e7dbda3c72d94f418972d45ad", fund: { id: "FUND-002", donationId: "DON-002", amountMon: 2100000, availableMon: 2100000, escrowedMon: 0, watermarkId: "WM-002" } }
    ],
    tasks: demoTasks.map(task => enrichTask(structuredClone(task))),
    marketplace: structuredClone(marketplace), marketOrders: [], updatedAt: now(),
    responses: [], awards: [],
    contracts: [{ id: "CTR-001", taskId: "TASK-001", party: "华北应急物资集团", subject: "饮用水 42,000 件", amountMon: 45360, status: "IN_PROGRESS", progress: 30, watermarkId: "WM-001", escrowDebited: true }],
    deliveries: [], redemptions: [],
    traces: [
      { id: "TRACE-001", type: "deposit", title: "MON 存入托管", detail: "华北救援众筹池完成合规后，平台存入 6,800,000 MON。", time: "2026-08-31 09:10", ref: "DON-001", txHash: "0xmon4a72c0ef91f0b6d9921e2c7a980c4a2a" },
      { id: "TRACE-002", type: "task", title: "灾情任务通过核验", detail: "河北涞源东口安置点生命救援任务进入资源调度。", time: "2026-08-31 10:05", ref: "TASK-001", txHash: "0xtask10a84f71f905c78144a61bcf2b928c80" },
      { id: "TRACE-003", type: "escrow", title: "合同 MON 托管", detail: "华北应急物资集团合同锁定 45,360 MON。", time: "2026-08-31 11:36", ref: "CTR-001", txHash: "0xctr1a36bd7ef362c59b45fd8f687a90d13a" }
    ],
    chainTransactions: [], auditEvents: [], idempotency: {}
  };
}
const stateStore = createStateStore({ file: DATA_FILE, initialState: () => {
  const initial = emptyState();
  if (!LEGACY_DEMO) {
    for (const key of ["donations", "contracts", "deliveries", "redemptions", "traces", "chainTransactions", "auditEvents", "marketOrders", "responses", "awards"]) initial[key] = [];
  }
  return initial;
} });
function normalizeState(value) {
  const s = value || emptyState();
  ["donations", "tasks", "responses", "awards", "contracts", "deliveries", "redemptions", "traces", "chainTransactions", "auditEvents", "marketOrders"].forEach(k => { if (!Array.isArray(s[k])) s[k] = []; });
  const stocks = new Map((s.marketplace ?? []).map(item => [item.id, item.stock]));
  s.marketplace = marketplace.map(item => ({ ...structuredClone(item), stock: stocks.get(item.id) ?? item.stock }));
  // Match the entire original record; any user edit makes it ineligible for migration.
  const legacyTasks = [
    { id: "TASK-001", disasterType: "洪涝", location: "河北涞源东口安置点", taskType: "生命救援", severity: "critical", status: "DISPATCHING", verificationStatus: "VERIFIED", requirements: { material: "饮用水 42,000 件 / 水域救援队 24 人" } },
    { id: "TASK-002", disasterType: "地震", location: "甘肃积石山第三安置区", taskType: "医疗救助", severity: "high", status: "EXECUTING", verificationStatus: "VERIFIED", requirements: { material: "医疗物资 18,000 件 / 医疗急救 16 人" } }
  ];
  s.tasks = s.tasks.map(task => {
    const seed = demoTasks.find(item => item.id === task.id);
    if (seed && legacyTasks.some(legacy => isDeepStrictEqual(task, legacy))) task = { ...task, title: seed.title, location: seed.location, disasterType: seed.disasterType, requirements: seed.requirements };
    return enrichTask(task);
  });
  s.updatedAt ??= now();
  if (!s.idempotency || typeof s.idempotency !== "object") s.idempotency = {};
  s.donations.forEach(d => { if (d.status === "MON_DEPOSIT_CONFIRMED" && d.monAmount && !d.fund) d.fund = { id: id("FUND"), donationId: d.id, amountMon: Number(d.monAmount), availableMon: Number(d.monAmount), watermarkId: d.watermarkId || null }; });
  return s;
}
let state = normalizeState(stateStore.load());
let stateVersion = 0;
let storageFailure = null;
function save() {
  try {
    state.updatedAt = now();
    stateStore.commit(state);
  } catch (error) {
    storageFailure = error;
    console.error(`Business state persistence failed: ${error.code || "STATE_WRITE_FAILED"}`);
    throw error;
  }
}
function send(res, status, body, headers) { const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)); res.writeHead(status, Object.assign({ "Content-Type": Buffer.isBuffer(body) ? "application/pdf" : "application/json; charset=utf-8", "Content-Length": data.length, "Access-Control-Allow-Origin": CORS_ORIGIN, "Vary": "Origin" }, headers || {})); res.end(data); }
function actor(req) {
  // Explicit surface selection prevents an ambient donor cookie granting or masking admin access.
  if (req.headers["x-relief-actor"] === "admin") return adminSessions.actor(req);
  const registered = walletService.accounts.actor(req);
  if (registered) return registered;
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  const session = LEGACY_DEMO && match && DEMO_TOKENS[match[1]];
  return session || { userId: null, organizationId: null, roles: [] };
}
function allowed(req, roles) { const a = actor(req); return a.roles.includes("platform_admin") || roles.some(role => a.roles.includes(role)); }
function hasRole(a, roles) { return a.roles.includes("platform_admin") || roles.some(role => a.roles.includes(role)); }
function sameOrganization(a, organizationId) { return typeof organizationId === "string" && organizationId.trim() !== "" && organizationId === a.organizationId; }
function canReadDetail(req, entityType, entityId) {
  const a = actor(req);
  if (!a.userId) return false;
  if (hasRole(a, ["platform_admin", "auditor", "finance", "compliance"])) return true;
  if (entityType === "donation") {
    const d = find("donations", entityId);
    return !!d && hasRole(a, ["donor"]) && (d.donorUserId === a.userId || (typeof d.organizationId === "string" && d.organizationId.trim() !== "" && d.organizationId === a.organizationId));
  }
  if (entityType === "task") {
    const t = find("tasks", entityId);
    return !!t && (hasRole(a, ["official_verifier", "dispatcher"]) || t.reporterUserId === a.userId || sameOrganization(a, t.organizationId));
  }
  if (entityType === "response") {
    const r = find("responses", entityId);
    return !!r && (hasRole(a, ["dispatcher", "contract_approver"]) || sameOrganization(a, r.organizationId));
  }
  if (entityType === "award") {
    const aw = find("awards", entityId);
    const r = aw && find("responses", aw.responseId);
    return !!aw && (hasRole(a, ["dispatcher", "contract_approver"]) || (r && sameOrganization(a, r.organizationId)));
  }
  if (entityType === "contract") {
    const c = find("contracts", entityId);
    return !!c && (hasRole(a, ["contract_approver"]) || sameOrganization(a, c.supplierOrganizationId) || sameOrganization(a, c.organizationId));
  }
  if (entityType === "delivery") {
    const d = find("deliveries", entityId);
    const c = d && find("contracts", d.contractId);
    return !!d && (hasRole(a, ["acceptance"]) || sameOrganization(a, d.organizationId) || (c && sameOrganization(a, c.supplierOrganizationId)));
  }
  if (entityType === "settlement") {
    const s = find("redemptions", entityId);
    const c = s && find("contracts", s.contractId);
    return !!s && s.id.startsWith("SET-") && (hasRole(a, ["contract_approver"]) || (c && sameOrganization(a, c.supplierOrganizationId)));
  }
  if (entityType === "redemption") {
    const r = find("redemptions", entityId);
    return !!r && r.id.startsWith("RED-") && sameOrganization(a, r.organizationId);
  }
  return false;
}
function audit(entityType, entityId, action, payload) { const requestActor = currentActor(); const previous = state.auditEvents[0]; const item = { id: id("AUD"), entityType, entityId, action, actorUserId: requestActor.userId || "system", organizationId: requestActor.organizationId || null, payloadHash: hash(JSON.stringify(payload)), previousEventHash: previous ? previous.payloadHash : null, createdAt: now() }; state.auditEvents.unshift(item); return item; }
function chain(action, businessId, payload) { const tx = { id: id("CHT"), businessId, action, network: NETWORK.name, chainId: NETWORK.chainId, contractAddress: CONTRACT_ADDRESS, txHash: null, status: "QUEUED", confirmations: 0, requiredConfirmations: 2, blockNumber: null, payloadHash: hash(JSON.stringify(payload)), createdAt: now() }; state.chainTransactions.unshift(tx); return tx; }
function advanceChain(tx, targetStatus) {
  if (!tx) throw Object.assign(new Error("链上交易不存在"), { status: 404, code: "NOT_FOUND" });
  const status = targetStatus || "CONFIRMED";
  if (!["BROADCAST", "CONFIRMED", "REVERTED", "TIMEOUT", "MANUAL_REVIEW"].includes(status)) throw Object.assign(new Error("无效的链上状态"), { status: 400, code: "INVALID_CHAIN_STATUS" });
  if (["CONFIRMED", "REVERTED", "TIMEOUT", "MANUAL_REVIEW"].includes(tx.status) && tx.status !== status) throw Object.assign(new Error("链上交易已终态"), { status: 409, code: "INVALID_STATE_TRANSITION" });
  tx.status = status;
  if (status === "BROADCAST") { tx.txHash = tx.txHash || `0x${crypto.randomBytes(20).toString("hex")}`; tx.broadcastAt = now(); }
  if (status === "CONFIRMED") { tx.txHash = tx.txHash || `0x${crypto.randomBytes(20).toString("hex")}`; tx.confirmations = tx.requiredConfirmations; tx.blockNumber = tx.blockNumber || Math.floor(Date.now() / 1000); tx.confirmedAt = now(); }
  if (["REVERTED", "TIMEOUT", "MANUAL_REVIEW"].includes(status)) tx.lastError = tx.lastError || (status === "REVERTED" ? "链上交易执行失败" : `交易进入${status}`);
  applyChainResult(tx);
  return tx;
}
function applyChainResult(tx) {
  if (tx.status !== "CONFIRMED") return;
  if (tx.action === "MON_DEPOSIT") { const d = find("donations", tx.businessId); if (d) { d.status = "MON_DEPOSIT_CONFIRMED"; d.depositTxHash = tx.txHash; if (d.fund) d.fund.availableMon = d.monAmount; } }
  if (tx.action === "ESCROW_CREATED") { const c = find("contracts", tx.businessId); if (c) { c.status = "FUNDS_RESERVED"; c.escrowTxHash = tx.txHash; c.progress = Math.max(c.progress || 0, 15); } }
  if (tx.action === "MON_LOCKED") { const r = find("redemptions", tx.businessId); if (r && r.status === "MON_LOCK_PENDING") { let remaining = Number(r.monAmount || 0); state.donations.forEach(d => { if (remaining <= 0 || !d.fund) return; const use = Math.min(remaining, Number(d.fund.availableMon || 0)); d.fund.availableMon -= use; d.fund.lockedMon = Number(d.fund.lockedMon || 0) + use; remaining -= use; }); if (remaining === 0) { r.status = "MON_LOCKED"; r.lockTxHash = tx.txHash; r.lockedAt = now(); } else { r.status = "MANUAL_REVIEW"; r.lockError = "确认时可用余额不足"; } } }
  if (tx.action === "MON_SETTLED") { const r = find("redemptions", tx.businessId); if (r && r.status === "SETTLEMENT_CHAIN_PENDING") { r.status = "SETTLED"; r.settlementTxHash = tx.txHash; r.watermarkStatus = "FINISHED"; r.settledAt = now(); const s = find("redemptions", r.settlementId); const c = s && find("contracts", s.contractId); if (c) c.status = "SETTLED"; } }
  if (tx.action === "TASK_APPROVED") { const t = find("tasks", tx.businessId); if (t) t.approvalTxHash = tx.txHash; }
  if (tx.action === "DELIVERY_ACCEPTED") { const d = find("deliveries", tx.businessId); if (d) d.acceptanceTxHash = tx.txHash; }
}
function trace(type, title, detail, ref, tx) { state.traces.unshift({ id: id("TRACE"), type, title, detail, ref, time: now(), txHash: tx ? tx.txHash : null }); }
async function write(req, key, payload, fn) {
  if (storageFailure) throw Object.assign(new Error("业务存储异常，已停止写入；请恢复数据后重启"), { status: 503, code: "STATE_WRITE_FAILED" });
  const idem = req.headers["idempotency-key"];
  if (!idem) throw Object.assign(new Error("必须提供 Idempotency-Key"), { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const requestHash = hash(`${req.method}:${req.url}:${JSON.stringify(payload || {})}`);
  const scopedKey = `${currentActor().userId || "anonymous"}:${idem}`;
  const old = Object.hasOwn(state.idempotency, scopedKey) ? state.idempotency[scopedKey] : null;
  if (old) {
    if (old.requestHash && old.requestHash !== requestHash) throw Object.assign(new Error("幂等键已用于不同请求"), { status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    return old.result || old;
  }
  if (req.businessVersion !== stateVersion) throw Object.assign(new Error("业务记录已变化，请刷新后重试"), { status: 409, code: "STATE_CHANGED" });
  // Roll back both business changes and the idempotency result if persistence fails.
  const before = structuredClone(state);
  try {
    const result = fn();
    state.idempotency[scopedKey] = { requestHash, result: structuredClone(result) };
    save();
    stateVersion++;
    return result;
  } catch (error) {
    state = before;
    stateVersion++;
    throw error;
  }
}
function error(res, status, code, message, retryable = false) { send(res, status, { data: null, error: { code, message, retryable } }); }
function find(collection, idValue) { return state[collection].find(x => x.id === idValue); }
function assertUniqueReference(field, value, collection, entityId) {
  if (!value) return;
  const duplicate = state[collection].find(item => item[field] === value && item.id !== entityId);
  if (duplicate) throw Object.assign(new Error("支付回执号已被使用"), { status: 409, code: "PAYMENT_REFERENCE_REUSED" });
}
function chainView(tx) {
  if (!tx) return null;
  return {
    id: tx.id,
    txId: tx.id,
    businessId: tx.businessId,
    action: tx.action,
    network: tx.network || NETWORK.name,
    chainId: tx.chainId || NETWORK.chainId,
    contractAddress: tx.contractAddress || CONTRACT_ADDRESS,
    txHash: tx.txHash || null,
    status: tx.status,
    confirmations: Number(tx.confirmations || 0),
    requiredConfirmations: Number(tx.requiredConfirmations || 2),
    blockNumber: tx.blockNumber || null,
    payloadHash: tx.payloadHash || null,
    lastError: tx.lastError || null,
    createdAt: tx.createdAt || null,
    broadcastAt: tx.broadcastAt || null,
    confirmedAt: tx.confirmedAt || null
  };
}
function txFor(businessId, action) {
  return state.chainTransactions.find(x => x.businessId === businessId && (!action || x.action === action));
}
function auditFor(entityType, entityId) {
  return state.auditEvents.filter(x => (!entityType || x.entityType === entityType) && (!entityId || x.entityId === entityId));
}
function tracesFor(refs) {
  const set = new Set((Array.isArray(refs) ? refs : [refs]).filter(Boolean));
  return state.traces.filter(x => set.has(x.ref));
}
function moneyFlow() {
  const depositedMon = state.donations.filter(x => x.status === "MON_DEPOSIT_CONFIRMED").reduce((s, x) => s + Number(x.monAmount || 0), 0);
  const availableMon = state.donations.reduce((s, x) => s + Number(x.fund && x.fund.availableMon || 0), 0);
  const escrowedMon = state.donations.reduce((s, x) => s + Number(x.fund && x.fund.escrowedMon || 0), 0);
  const lockedMon = state.donations.reduce((s, x) => s + Number(x.fund && x.fund.lockedMon || 0), 0);
  const settledMon = state.redemptions.filter(x => x.id && x.id.startsWith("RED-") && x.status === "SETTLED").reduce((s, x) => s + Number(x.monAmount || 0), 0);
  return { depositedMon, availableMon, escrowedMon, lockedMon, settledMon, pendingMon: Math.max(0, depositedMon - availableMon - escrowedMon - lockedMon - settledMon) };
}
function certificateData(donation) {
  if (!donation) return null;
  const tx = txFor(donation.id, "MON_DEPOSIT") || state.chainTransactions.find(x => x.txHash && x.txHash === donation.depositTxHash);
  const contract = state.contracts.find(x => x.watermarkId === donation.watermarkId || x.donationId === donation.id) || null;
  const task = contract && contract.taskId ? find("tasks", contract.taskId) : null;
  const traceUrl = `${PUBLIC_BASE_URL}/v1/public/trace/${encodeURIComponent(donation.watermarkId || donation.id)}`;
  const payload = {
    certificateId: `CERT-${donation.id}`,
    donationId: donation.id,
    projectId: task && task.id || contract && contract.taskId || null,
    projectTitle: task ? `${task.disasterType || "救灾任务"} / ${task.location || ""}` : null,
    contractId: contract && contract.id || null,
    contractSubject: contract && contract.subject || null,
    donorMaskedId: hash(donation.donor || donation.id).slice(0, 12),
    fiatAmount: donation.fiatAmount || null,
    currency: donation.currency || "CNY",
    monAmount: donation.monAmount || null,
    monPriceSnapshot: donation.priceSnapshot || donation.monPriceSnapshot || null,
    network: NETWORK.name,
    chainId: NETWORK.chainId,
    contractAddress: CONTRACT_ADDRESS,
    depositTxHash: donation.depositTxHash || (tx && tx.txHash) || null,
    rootWatermarkId: donation.watermarkId || null,
    policyHash: hash(JSON.stringify(donation.policy || {})),
    publicTraceUrl: traceUrl,
    qrCode: { type: "public_trace_url", value: traceUrl },
    attestation: {
      type: "EvidenceAnchored",
      businessId: donation.id,
      txHash: donation.depositTxHash || (tx && tx.txHash) || null,
      payloadHash: tx && tx.payloadHash || hash(`${donation.id}:${donation.watermarkId || ""}:${donation.monAmount || 0}`)
    }
  };
  payload.pdfSha256 = hash(JSON.stringify(payload));
  return payload;
}
function watermarkNodes(ref) {
  const donation = state.donations.find(x => x.id === ref || x.watermarkId === ref);
  const contracts = donation ? state.contracts.filter(x => x.watermarkId === donation.watermarkId || x.donationId === donation.id) : state.contracts.filter(x => x.id === ref || x.watermarkId === ref);
  const taskIds = new Set(contracts.map(x => x.taskId).filter(Boolean));
  state.traces.filter(x => x.ref === ref && x.type === "task").forEach(x => taskIds.add(x.ref));
  const deliveries = state.deliveries.filter(x => contracts.some(c => c.id === x.contractId) || x.id === ref);
  const settlements = state.redemptions.filter(x => x.id && x.id.startsWith("SET-") && contracts.some(c => c.id === x.contractId));
  const redemptions = state.redemptions.filter(x => x.id && x.id.startsWith("RED-") && settlements.some(s => s.id === x.settlementId));
  const root = donation && { id: donation.watermarkId || donation.id, eventType: "MonDeposit", businessId: donation.id, amountMon: donation.monAmount || 0, txHash: donation.depositTxHash || null, status: donation.status, previousHash: null, privateEventHash: hash(JSON.stringify({ donationId: donation.id, donor: donation.donor })) };
  const nodes = root ? [root] : [];
  taskIds.forEach(taskId => {
    const task = find("tasks", taskId);
    if (task) nodes.push({ id: `${root ? root.id : "WM"}:${task.id}`, parentWatermark: root && root.id, eventType: "BudgetAllocated", businessId: task.id, amountMon: null, txHash: task.approvalTxHash || null, status: task.status, privateEventHash: hash(JSON.stringify(task)), previousHash: root && root.privateEventHash });
  });
  contracts.forEach(c => nodes.push({ id: c.watermarkId || `${root ? root.id : "WM"}:${c.id}`, parentWatermark: root && root.id, eventType: "EscrowCreated", businessId: c.id, amountMon: c.amountMon || 0, txHash: c.escrowTxHash || null, status: c.status, privateEventHash: c.termsHash || hash(JSON.stringify(c)), previousHash: root && root.privateEventHash }));
  deliveries.forEach(d => nodes.push({ id: `${root ? root.id : "WM"}:${d.id}`, parentWatermark: root && root.id, eventType: "DeliveryAccepted", businessId: d.id, amountMon: null, txHash: d.acceptanceTxHash || null, status: d.status, privateEventHash: hash(JSON.stringify({ deliveryId: d.id, evidenceIds: d.evidenceIds || [] })) }));
  redemptions.forEach(r => nodes.push({ id: `${root ? root.id : "WM"}:${r.id}`, parentWatermark: root && root.id, eventType: r.status === "SETTLED" ? "WatermarkFinished" : "MonLockedForRedemption", businessId: r.id, amountMon: r.monAmount || 0, txHash: r.settlementTxHash || r.lockTxHash || null, status: r.watermarkStatus || r.status, privateEventHash: hash(JSON.stringify({ redemptionId: r.id, payoutReference: r.payoutReference || null })) }));
  return nodes;
}
function detail(entityType, entityId) {
  const singular = { donation: "donations", task: "tasks", response: "responses", award: "awards", contract: "contracts", delivery: "deliveries", settlement: "redemptions", redemption: "redemptions" };
  const collection = singular[entityType] || entityType;
  const item = find(collection, entityId);
  if (!item) return null;
  const refs = [entityId];
  if (entityType === "contract") refs.push(item.taskId, item.awardId);
  if (entityType === "delivery") refs.push(item.contractId);
  if (entityType === "redemption") refs.push(item.settlementId);
  const chain = state.chainTransactions.filter(x => refs.includes(x.businessId) || x.businessId === entityId).map(chainView);
  const entityAudit = auditFor(entityType === "response" ? "resource_response" : entityType, entityId);
  return {
    item,
    network: Object.assign({ contractAddress: CONTRACT_ADDRESS }, NETWORK),
    chain,
    traces: tracesFor(refs),
    auditEvents: entityAudit,
    certificate: entityType === "donation" ? certificateData(item) : null,
    watermark: watermarkNodes(item.watermarkId || entityId),
    related: {
      task: item.taskId ? find("tasks", item.taskId) || null : null,
      contract: item.contractId ? find("contracts", item.contractId) || null : null,
      settlement: item.settlementId ? find("redemptions", item.settlementId) || null : null,
      redemptions: entityType === "settlement" ? state.redemptions.filter(x => x.settlementId === item.id) : []
    }
  };
}
function demoProcess() {
  const steps = [
    { key: "donation", title: "人民币到账与合规", status: state.donations.some(x => x.status === "MON_DEPOSIT_CONFIRMED") ? "DONE" : "ACTIVE", metrics: { count: state.donations.length, confirmed: state.donations.filter(x => x.status === "MON_DEPOSIT_CONFIRMED").length } },
    { key: "mon_deposit", title: "Monad 入账确认", status: state.chainTransactions.some(x => x.action === "MON_DEPOSIT" && x.status !== "CONFIRMED") ? "ACTIVE" : "DONE", metrics: { queued: state.chainTransactions.filter(x => x.action === "MON_DEPOSIT" && x.status !== "CONFIRMED").length } },
    { key: "task", title: "灾情核验与调度", status: state.tasks.some(x => x.verificationStatus !== "VERIFIED") ? "ACTIVE" : "DONE", metrics: { tasks: state.tasks.length, verified: state.tasks.filter(x => x.verificationStatus === "VERIFIED").length } },
    { key: "contract", title: "中选合同与托管", status: state.contracts.some(x => ["FUNDS_RESERVATION_PENDING", "PENDING_APPROVAL"].includes(x.status)) ? "ACTIVE" : "DONE", metrics: { contracts: state.contracts.length, reserved: state.contracts.filter(x => ["FUNDS_RESERVED", "IN_PROGRESS", "PENDING_SETTLEMENT", "SETTLED"].includes(x.status)).length } },
    { key: "delivery", title: "交付验收与凭证哈希", status: state.deliveries.some(x => x.status === "IN_PROGRESS") ? "ACTIVE" : state.deliveries.length ? "DONE" : "WAITING", metrics: { deliveries: state.deliveries.length, accepted: state.deliveries.filter(x => x.status === "ACCEPTED").length } },
    { key: "redemption", title: "兑换锁定、兑付与结算", status: state.redemptions.some(x => x.id && x.id.startsWith("RED-") && !["SETTLED", "CANCELLED"].includes(x.status)) ? "ACTIVE" : state.redemptions.some(x => x.id && x.id.startsWith("RED-")) ? "DONE" : "WAITING", metrics: { redemptions: state.redemptions.filter(x => x.id && x.id.startsWith("RED-")).length, settled: state.redemptions.filter(x => x.id && x.id.startsWith("RED-") && x.status === "SETTLED").length } }
  ];
  return {
    network: Object.assign({ contractAddress: CONTRACT_ADDRESS }, NETWORK),
    steps,
    moneyFlow: moneyFlow(),
    visualization: {
      nodes: [
        ...state.donations.map(x => ({ id: x.id, label: x.watermarkId || x.id, type: "donation", status: x.status, amountMon: x.monAmount || 0 })),
        ...state.tasks.map(x => ({ id: x.id, label: x.location, type: "task", status: x.status })),
        ...state.contracts.map(x => ({ id: x.id, label: x.party, type: "contract", status: x.status, amountMon: x.amountMon || 0 })),
        ...state.deliveries.map(x => ({ id: x.id, label: x.id, type: "delivery", status: x.status })),
        ...state.redemptions.map(x => ({ id: x.id, label: x.id, type: x.id && x.id.startsWith("SET-") ? "settlement" : "redemption", status: x.status, amountMon: x.monAmount || x.acceptedAmountMon || 0 }))
      ],
      edges: [
        ...state.contracts.map(x => ({ from: x.taskId, to: x.id, type: "contract" })),
        ...state.deliveries.map(x => ({ from: x.contractId, to: x.id, type: "delivery" })),
        ...state.redemptions.filter(x => x.contractId).map(x => ({ from: x.contractId, to: x.id, type: "settlement" })),
        ...state.redemptions.filter(x => x.settlementId).map(x => ({ from: x.settlementId, to: x.id, type: "redemption" }))
      ],
      timeline: state.traces.map(x => ({ id: x.id, time: x.time, type: x.type, title: x.title, ref: x.ref, txHash: x.txHash || null }))
    }
  };
}
function gfTables() {
  if (gfTables.cache) return gfTables.cache;
  const exp = new Array(512);
  const log = new Array(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  gfTables.cache = { exp, log };
  return gfTables.cache;
}
function gfMul(a, b) {
  if (!a || !b) return 0;
  const table = gfTables();
  return table.exp[table.log[a] + table.log[b]];
}
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], gfTables().exp[i]);
    }
    poly = next;
  }
  return poly;
}
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const work = data.concat(new Array(degree).fill(0));
  data.forEach((_, i) => {
    const factor = work[i];
    if (!factor) return;
    for (let j = 0; j < gen.length; j += 1) work[i + j] ^= gfMul(gen[j], factor);
  });
  return work.slice(work.length - degree);
}
function qrBytes(value) {
  const bytes = Array.from(Buffer.from(String(value), "utf8"));
  if (bytes.length > 78) throw new Error("QR payload too long for demo certificate");
  const bits = [];
  const append = (number, width) => { for (let i = width - 1; i >= 0; i -= 1) bits.push((number >>> i) & 1); };
  append(0x4, 4);
  append(bytes.length, 8);
  bytes.forEach(byte => append(byte, 8));
  const capacity = 80 * 8;
  append(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0; data.length < 80; pad += 1) data.push(pad % 2 ? 0x11 : 0xEC);
  return data.concat(rsRemainder(data, 20));
}
function qrMatrix(value) {
  const size = 33;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark, fixed = true) => { if (x < 0 || y < 0 || x >= size || y >= size) return; modules[y][x] = !!dark; if (fixed) reserved[y][x] = true; };
  const finder = (x, y) => {
    for (let dy = -1; dy <= 7; dy += 1) for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      const inCore = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inCore && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(xx, yy, dark);
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const align = (cx, cy) => { for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); };
  align(26, 26);
  set(8, 25, true);
  const formatBits = parseInt("111011111000100", 2);
  const bit = i => ((formatBits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  const dataBits = qrBytes(value).flatMap(byte => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  let cursor = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let x = right; x >= right - 1; x -= 1) {
        if (reserved[y][x]) continue;
        const raw = cursor < dataBits.length ? !!dataBits[cursor] : false;
        modules[y][x] = raw !== ((x + y) % 2 === 0);
        cursor += 1;
      }
    }
    upward = !upward;
  }
  return modules;
}
function certificatePdf(cert) {
  const qValue = String(cert.publicTraceUrl || cert.qrCode && cert.qrCode.value || "");
  const qrValue = qValue.length <= 78 ? qValue : `/v1/public/trace/${cert.rootWatermarkId || cert.donationId}`;
  const qr = qrMatrix(qrValue);
  const clean = text => String(text == null ? "" : text).replace(/[()\\]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?");
  const lines = [
    "Relief MON Project Certificate",
    `Certificate: ${cert.certificateId}`,
    `Donation: ${cert.donationId}`,
    `Project: ${cert.projectId || "pending"}`,
    `Contract: ${cert.contractId || "pending"}`,
    `MON: ${cert.monAmount}`,
    `Watermark: ${cert.rootWatermarkId}`,
    `Network: ${cert.network} / Chain ID ${cert.chainId}`,
    `Escrow: ${cert.contractAddress}`,
    `Deposit tx: ${cert.depositTxHash || "pending"}`,
    `Attestation: ${cert.attestation.payloadHash}`,
    `PDF SHA-256: ${cert.pdfSha256}`,
    `Scan QR or open: ${qrValue}`
  ];
  const textOps = lines.map((line, i) => `BT /F1 10 Tf 1 0 0 1 50 ${742 - i * 24} Tm (${clean(line)}) Tj ET`).join("\n");
  const scale = 4;
  const quiet = 4;
  const qx = 390;
  const qy = 478;
  const qrOps = qr.flatMap((row, y) => row.map((dark, x) => dark ? `${qx + (x + quiet) * scale} ${qy + (qr.length - 1 - y + quiet) * scale} ${scale} ${scale} re f` : null).filter(Boolean)).join("\n");
  const stream = `0 0 0 rg\n${textOps}\n${qrOps}`;
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
function pdf(text) { const clean = String(text).replace(/[()\\]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?"); const stream = `BT /F1 12 Tf 50 760 Td (${clean}) Tj ET`; const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]; let out = "%PDF-1.4\n"; const offsets = [0]; objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; }); const xref = Buffer.byteLength(out); out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`; for (let i = 1; i < offsets.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`; out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; return Buffer.from(out); }

function isPublicTask(task) {
  return task.verificationStatus === "VERIFIED" && task.isPrivate !== true && task.private !== true
    && (task.visibility == null || String(task.visibility).toUpperCase() === "PUBLIC")
    && ["DISPATCHING", "EXECUTING", "IN_PROGRESS", "COMPLETED"].includes(task.status);
}
function publicTask(task) {
  const fields = ["id", "title", "disasterType", "location", "taskType", "severity", "status", "verificationStatus", "monTarget", "monRaised", "participants", "participantTarget", "articleId", "sections", "urgencyLabel", "need", "image", "dataMode"];
  return Object.fromEntries(fields.map(field => [field, task[field]]));
}
function overview(admin) {
  const visibleTasks = admin ? state.tasks : state.tasks.filter(isPublicTask);
  const flow = moneyFlow();
  const dashboard = {
    depositedMon: flow.depositedMon, availableMon: flow.availableMon,
    escrowMon: flow.escrowedMon, settledMon: flow.settledMon,
    activeTasks: visibleTasks.filter(task => task.status !== "COMPLETED").length,
    pendingReview: visibleTasks.filter(task => task.verificationStatus !== "VERIFIED").length,
    participantCount: visibleTasks.reduce((sum, task) => sum + Number(task.participants ?? 0), 0),
    poolTargetMon: visibleTasks.reduce((sum, task) => sum + Number(task.monTarget ?? 0), 0),
    chainEvents: state.chainTransactions.length + state.traces.length
  };
  // Public projections intentionally omit donor identities, policies and audit payloads.
  const tasks = admin ? visibleTasks : visibleTasks.map(publicTask);
  const publicTaskIds = new Set(visibleTasks.map(task => task.id));
  const contracts = admin ? state.contracts : state.contracts.filter(c => publicTaskIds.has(c.taskId)).map(c => ({
    id: c.id, taskId: c.taskId, party: c.party, subject: c.subject, amountMon: c.amountMon,
    status: c.status, progress: c.progress ?? 0, createdAt: c.createdAt ?? null
  }));
  return {
    dashboard, tasks, contracts, disasterUpdates, marketplace: state.marketplace,
    network: { ...NETWORK, contractAddress: CONTRACT_ADDRESS }, updatedAt: state.updatedAt, dataMode: "demo",
    capabilities: { legacyDemoEnabled: LEGACY_DEMO, businessWritesEnabled: LEGACY_DEMO && !storageFailure, storage: storageFailure ? "write-failed" : "ready" },
    ...(admin ? { donations: state.donations, marketOrders: state.marketOrders, traces: state.traces, process: demoProcess() } : {})
  };
}
function businessError(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function checkStock(item, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) businessError(400, "INVALID_QUANTITY", "数量必须为正整数");
  if (!Number.isSafeInteger(item.stock) || quantity > item.stock) businessError(409, "INSUFFICIENT_STOCK", "演示库存不足");
}
async function marketRoute(req, res, p, parts) {
  if (p === "/v1/marketplace" && req.method === "GET") return send(res, 200, { data: state.marketplace });
  const a = actor(req);
  if (!a.userId) return error(res, 401, "AUTH_REQUIRED", "请先登录");
  const admin = a.roles.includes("platform_admin");
  if (p === "/v1/market-orders" && req.method === "GET") {
    if (!admin && !a.roles.includes("donor")) return error(res, 403, "ROLE_NOT_ALLOWED", "无权查询订单");
    return send(res, 200, { data: state.marketOrders.filter(order => admin || order.donorUserId === a.userId) });
  }
  if (p === "/v1/market-orders" && req.method === "POST") {
    if (!a.roles.includes("donor")) return error(res, 403, "ROLE_NOT_ALLOWED", "仅捐赠者可提交订单");
    const b = await body(req);
    const result = await write(req, "market-order:create", b, () => {
      const item = find("marketplace", b.itemId);
      const task = find("tasks", b.taskId);
      if (!item || !task || !isPublicTask(task)) businessError(404, "NOT_FOUND", "商品或公开任务不存在");
      checkStock(item, b.quantity);
      const totalMon = item.priceMon * b.quantity;
      if (!Number.isFinite(item.priceMon) || item.priceMon < 0 || !Number.isSafeInteger(totalMon)) businessError(400, "INVALID_AMOUNT", "商品价格或总额无效");
      const order = {
        id: id("MOR"), itemId: item.id, itemName: item.name, taskId: task.id, taskTitle: task.title,
        quantity: b.quantity, unitPriceMon: item.priceMon, totalMon, status: "PENDING_REVIEW",
        contractId: null, createdAt: now(), donorUserId: a.userId, dataMode: "demo"
      };
      state.marketOrders.unshift(order);
      audit("market_order", order.id, "CREATED", order);
      return { data: order };
    });
    return send(res, 201, result);
  }
  if (parts.length === 4 && ["approve", "reject"].includes(parts[3]) && req.method === "POST") {
    if (!admin) return error(res, 403, "ROLE_NOT_ALLOWED", "仅平台管理员可审核订单");
    const b = await body(req);
    const result = await write(req, `market-order:${parts[2]}:${parts[3]}`, b, () => {
      const order = find("marketOrders", parts[2]);
      if (!order) businessError(404, "NOT_FOUND", "订单不存在");
      const target = parts[3] === "approve" ? "APPROVED" : "REJECTED";
      if (order.status === target) return { data: order };
      if (order.status !== "PENDING_REVIEW") businessError(409, "INVALID_STATE_TRANSITION", "订单已处理");
      if (target === "APPROVED") {
        const item = find("marketplace", order.itemId);
        if (!item || !find("tasks", order.taskId)) businessError(404, "NOT_FOUND", "商品或任务不存在");
        checkStock(item, order.quantity);
        const contract = {
          id: id("CTR"), taskId: order.taskId, marketOrderId: order.id, itemId: order.itemId,
          party: item.supplier, subject: `${order.itemName} × ${order.quantity} ${item.unit}`,
          amountMon: order.totalMon, plannedQuantity: order.quantity, unitPriceMon: order.unitPriceMon,
          status: "PENDING_APPROVAL", progress: 0, watermarkId: null, createdAt: now(), dataMode: "demo"
        };
        state.contracts.unshift(contract);
        item.stock -= order.quantity;
        order.contractId = contract.id;
        audit("contract", contract.id, "CREATED", contract);
      }
      order.status = target;
      audit("market_order", order.id, target, { ...b, contractId: order.contractId });
      return { data: order };
    });
    return send(res, 200, result);
  }
  return error(res, 404, "NOT_FOUND", "接口不存在");
}

async function route(req, res) {
  req.businessVersion = stateVersion;
  if (req.method === "OPTIONS") return send(res, 204, "", { "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Admin-Token, X-Relief-Actor", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`); const p = url.pathname.replace(/\/$/, "") || "/"; const parts = p.split("/").filter(Boolean);
  if (await adminSessions.handle(req, res, p)) return;
  if (await fundingReadService.handle(req, res, p)) return;
  if (storageFailure && req.method === "POST" && p.startsWith("/v1/platform/")) return error(res, 503, "STATE_WRITE_FAILED", "业务存储异常，已停止采购操作");
  if (await platformService.handle(req, res, p)) return;
  if (storageFailure && req.method === "POST" && (p.startsWith("/v1/wallet/donations/") || p.startsWith("/v1/wallet/admin/"))) return error(res, 503, "STATE_WRITE_FAILED", "业务存储异常，已停止资金操作；请恢复数据后重启");
  if (await walletService.route(req, res, p)) return;
  if (req.headers["x-relief-actor"] === "admin" && p.startsWith("/v1/") && !adminSessions.authorized(req)) return error(res, 401, "ADMIN_AUTH_REQUIRED", "请先验证管理权限");
  if (req.method === "POST" && p.startsWith("/v1/") && !LEGACY_DEMO) return error(res, 503, "BUSINESS_WORKFLOW_NOT_READY", "旧业务记录只读；正式采购与资金账本尚未启用");
  if (p === "/v1/marketplace" || p === "/v1/market-orders" || p.startsWith("/v1/market-orders/")) {
    try { return await marketRoute(req, res, p, parts); }
    catch (e) { return error(res, e.status || 400, e.code || "INVALID_INPUT", e.message); }
  }
  if (p === "/v1/health") {
    const indexer = fundingIndexerRuntime?.status() || null;
    return send(res, storageFailure ? 503 : 200, { ok: !storageFailure, network: NETWORK,
      mode: LEGACY_DEMO ? "demo-adapter" : WALLET_STAGING ? "staging-wallet" : "read-only-preparation", storage: storageFailure ? "write-failed" : "ready",
      funding: { configured: Boolean(fundingPoolAddress), indexerState: indexer?.state || (fundingPoolAddress ? "SAVED_ONLY" : "DISABLED"),
        live: Boolean(indexer && indexer.state === "IDLE" && indexer.lastSuccessAt !== null && indexer.throughBlock === indexer.confirmedBlock) } });
  }
  if (p === "/v1/demo/process" && req.method === "GET") { if (!allowed(req, ["auditor", "finance", "compliance", "dispatcher", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权查询演示过程数据"); return send(res, 200, { data: demoProcess() }); }
  if (parts[0] === "v1" && parts[1] === "details" && parts.length === 4 && req.method === "GET") {
    const type = parts[2];
    const roles = type === "donation" ? ["donor", "finance", "compliance", "auditor", "platform_admin"] : type === "task" ? ["reporter", "official_verifier", "dispatcher", "auditor", "platform_admin"] : ["finance", "compliance", "dispatcher", "contract_approver", "supplier", "acceptance", "auditor", "platform_admin"];
    if (!allowed(req, roles)) return error(res, 403, "ROLE_NOT_ALLOWED", "无权查询详情");
    if (!canReadDetail(req, type, parts[3])) return error(res, 403, "SCOPE_DENIED", "无权查询该对象范围内的详情");
    const d = detail(type, parts[3]);
    return d ? send(res, 200, { data: d }) : error(res, 404, "NOT_FOUND", "详情对象不存在");
  }
  if (p === "/v1/chain/transactions" && req.method === "GET") { if (!allowed(req, ["auditor", "finance", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); return send(res, 200, { data: state.chainTransactions }); }
  if (parts[0] === "v1" && parts[1] === "chain" && parts[2] === "transactions" && parts.length === 4 && req.method === "GET") { if (!allowed(req, ["auditor", "finance", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); const tx = find("chainTransactions", parts[3]); return tx ? send(res, 200, { data: tx }) : error(res, 404, "NOT_FOUND", "链上交易不存在"); }
  if (parts[0] === "v1" && parts[1] === "chain" && parts[2] === "transactions" && parts.length === 5 && parts[4] === "advance" && req.method === "POST") { if (!allowed(req, ["finance", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权推进链上演示交易"); const tx = find("chainTransactions", parts[3]); if (!tx) return error(res, 404, "NOT_FOUND", "链上交易不存在"); const b = await body(req); try { const result = await write(req, `chain:${tx.id}`, b, () => { advanceChain(tx, b.status || "CONFIRMED"); audit("chain_transaction", tx.id, "STATUS_UPDATED", tx); return { data: tx }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (p === "/v1/demo/reset" && req.method === "POST") { if (!allowed(req, ["platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "仅演示管理员可重置数据"); try { const result = await write(req, "demo:reset", {}, () => { state = normalizeState(emptyState()); return { data: { reset: true } }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (p === "/v1/public/overview" && req.method === "GET") return send(res, 200, { data: overview(false) });
  if ((p === "/v1/dashboard" || p === "/v1/overview") && req.method === "GET") {
    if (!actor(req).userId) return error(res, 401, "AUTH_REQUIRED", "请先登录");
    if (!allowed(req, ["finance", "compliance", "dispatcher", "contract_approver", "auditor"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权查询管理总览");
    return send(res, 200, { data: overview(true) });
  }
  if (parts[0] === "v1" && parts[1] === "public" && parts[2] === "trace" && req.method === "GET") { const ref = parts[3]; const donation = state.donations.find(x => x.id === ref || x.watermarkId === ref); const cert = donation && certificateData(donation); const watermark = donation ? { id: donation.id, watermarkId: donation.watermarkId || null, monAmount: donation.monAmount || null, status: donation.status, attestationHash: cert && cert.attestation && cert.attestation.payloadHash || null } : null; const events = state.traces.filter(x => x.ref === ref).map(x => ({ id: x.id, type: x.type, title: x.title, time: x.time, ref: x.ref, txHash: x.txHash || null })); return send(res, 200, { data: { ref, network: Object.assign({ contractAddress: CONTRACT_ADDRESS }, NETWORK), watermark, events, attestation: cert && cert.attestation || null, qrCode: cert && cert.qrCode || null, chainTransactions: state.chainTransactions.filter(x => x.businessId === ref).map(x => ({ id: x.id, action: x.action, txHash: x.txHash, status: x.status, createdAt: x.createdAt, payloadHash: x.payloadHash || null })) } }); }
  if (parts[0] === "v1" && parts[1] === "redemptions" && parts.length === 3 && req.method === "GET") { if (!allowed(req, ["finance", "compliance", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); const r = find("redemptions", parts[2]); if (r && r.id.startsWith("RED-") && !canReadDetail(req, "redemption", r.id)) return error(res, 403, "SCOPE_DENIED", "无权查询该兑换申请"); return r && r.id.startsWith("RED-") ? send(res, 200, { data: r }) : error(res, 404, "NOT_FOUND", "兑换申请不存在"); }
  if (p === "/v1/audit-events" && req.method === "GET") { if (!allowed(req, ["auditor", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权查询审计事件"); const type = url.searchParams.get("entityType"); const entityId = url.searchParams.get("entityId"); const events = state.auditEvents.filter(x => (!type || x.entityType === type) && (!entityId || x.entityId === entityId)); return send(res, 200, { data: events }); }
  if (parts[0] === "v1" && parts[1] === "donations" && req.method === "GET" && parts.length === 2) {
    if (!allowed(req, ["donor", "finance", "compliance", "auditor"])) return error(res, 401, "AUTH_REQUIRED", "请先登录");
    return send(res, 200, { data: state.donations.filter(d => canReadDetail(req, "donation", d.id)) });
  }
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 3 && parts[2] !== "receipt" && req.method === "GET") { if (!allowed(req, ["donor", "finance", "compliance", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); const item = find("donations", parts[2]); if (item && !canReadDetail(req, "donation", item.id)) return error(res, 403, "SCOPE_DENIED", "无权查询该捐赠"); return item ? send(res, 200, { data: item }) : error(res, 404, "NOT_FOUND", "捐赠不存在"); }
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 4 && ["certificate", "receipt"].includes(parts[3]) && req.method === "GET" && !canReadDetail(req, "donation", parts[2])) return error(res, actor(req).userId ? 403 : 401, actor(req).userId ? "SCOPE_DENIED" : "AUTH_REQUIRED", "无权查询该捐赠");
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 3 && parts[2] === "receipt" && req.method === "GET") return error(res, 400, "DONATION_ID_REQUIRED", "请使用 /v1/donations/{id}/receipt");
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 4 && parts[3] === "certificate" && req.method === "GET") { const item = find("donations", parts[2]); if (!item || item.status !== "MON_DEPOSIT_CONFIRMED") return error(res, 409, "CERTIFICATE_NOT_READY", "MON 存入并进入真实救灾合同后才能生成项目证书"); const cert = certificateData(item); return send(res, 200, certificatePdf(cert), { "Content-Disposition": `attachment; filename=${cert.certificateId}.pdf`, "X-PDF-SHA256": cert.pdfSha256, "X-Attestation-Hash": cert.attestation.payloadHash, "X-Public-Trace": cert.publicTraceUrl }); }
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 4 && parts[3] === "receipt" && req.method === "GET") { const item = find("donations", parts[2]); if (!item || item.status !== "MON_DEPOSIT_CONFIRMED") return error(res, 409, "RECEIPT_NOT_READY", "MON 存入确认后才能生成凭证"); const cert = certificateData(item); return send(res, 200, pdf(`Relief MON Donation ${item.id} / ${item.monAmount} MON / watermark ${item.watermarkId} / tx ${cert.depositTxHash || "pending"} / attestation ${cert.attestation.payloadHash} / qr ${cert.publicTraceUrl} / pdf ${cert.pdfSha256}`), { "Content-Disposition": `attachment; filename=${item.id}.pdf`, "X-PDF-SHA256": cert.pdfSha256, "X-Attestation-Hash": cert.attestation.payloadHash }); }
  if (p === "/v1/donations" && req.method === "POST") {
    if (!allowed(req, ["donor"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权创建捐赠");
    const b = await body(req);
    try {
      const result = await write(req, "donation:create", b, () => {
        const monIntent = b.monIntentAmount !== undefined;
        const amount = monIntent ? b.monIntentAmount : Number(b.fiatAmount);
        if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("捐赠金额必须为正数"), { status: 400, code: "INVALID_AMOUNT" });
        const a = actor(req);
        const d = { id: id("DON"), donor: b.donor || "匿名捐赠项目", donorUserId: a.userId, organizationId: a.organizationId,
          ...(monIntent ? { monIntentAmount: amount, fiatAmount: 0 } : { fiatAmount: amount, currency: "CNY", paymentProvider: b.paymentProvider || "demo" }),
          policy: b.policy ?? {}, status: monIntent ? "MON_REVIEW_PENDING" : "PAYMENT_PENDING", createdAt: now() };
        state.donations.unshift(d);
        audit("donation", d.id, "CREATED", d);
        trace("donation", monIntent ? "MON 捐赠意向待审核" : "人民币到账订单已创建", "演示捐赠等待审核与后续确认。", d.id);
        return { data: d };
      });
      return send(res, 201, result);
    } catch (e) { return error(res, e.status || 400, e.code || "INVALID_INPUT", e.message); }
  }
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 4 && parts[3] === "payment-confirm" && req.method === "POST") { const d = find("donations", parts[2]); if (!d) return error(res, 404, "NOT_FOUND", "捐赠不存在"); if (!allowed(req, ["finance", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "仅支付/财务角色可确认到账"); const b = await body(req); try { const result = await write(req, `payment-confirm:${d.id}`, b, () => { if (d.status !== "PAYMENT_PENDING") throw Object.assign(new Error("捐赠不在待支付状态"), { status: 409, code: "INVALID_STATE_TRANSITION" }); if (!b.paymentReference) throw Object.assign(new Error("缺少支付回执号"), { status: 400, code: "PAYMENT_REFERENCE_REQUIRED" }); assertUniqueReference("paymentReference", b.paymentReference, "donations", d.id); d.status = "PAYMENT_CONFIRMED"; d.paymentReference = b.paymentReference; d.confirmedAt = now(); audit("donation", d.id, "PAYMENT_CONFIRMED", b); return { data: d }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 3 && req.method === "POST") { const d = find("donations", parts[2]); if (!d) return error(res, 404, "NOT_FOUND", "捐赠不存在"); const b = await body(req); if (parts[2] === "payment-confirm") return error(res, 404, "NOT_FOUND", "路径错误"); return error(res, 409, "UNSUPPORTED_ACTION", "请使用 payment-confirm、compliance-review 或 mon-deposit 子路径"); }
  if (parts[0] === "v1" && parts[1] === "donations" && parts.length === 4 && req.method === "POST") { const d = find("donations", parts[2]); if (!d) return error(res, 404, "NOT_FOUND", "捐赠不存在"); const action = parts[3]; const b = await body(req); try { const result = await write(req, `${action}:${d.id}`, b, () => { if (action === "payment-confirm") { if (!allowed(req, ["finance", "platform_admin"])) throw Object.assign(new Error("仅支付/财务角色可确认到账"), { status: 403, code: "ROLE_NOT_ALLOWED" }); if (d.status !== "PAYMENT_PENDING") throw Object.assign(new Error("捐赠不在待支付状态"), { status: 409, code: "INVALID_STATE_TRANSITION" }); if (!b.paymentReference) throw Object.assign(new Error("缺少支付回执号"), { status: 400, code: "PAYMENT_REFERENCE_REQUIRED" }); d.status = "PAYMENT_CONFIRMED"; d.paymentReference = b.paymentReference; d.confirmedAt = now(); audit("donation", d.id, "PAYMENT_CONFIRMED", b); } else if (action === "compliance-review") { if (!allowed(req, ["compliance", "platform_admin"])) throw Object.assign(new Error("无权审核"), { status: 403, code: "ROLE_NOT_ALLOWED" }); if (!["PAYMENT_CONFIRMED", "MON_REVIEW_PENDING", "COMPLIANCE_REVIEW", "FROZEN"].includes(d.status)) throw Object.assign(new Error("捐赠不在待审核状态"), { status: 409, code: "INVALID_STATE_TRANSITION" }); if (!["approve", "reject", "freeze", "manual_review"].includes(b.decision)) throw Object.assign(new Error("审核决定无效"), { status: 400, code: "INVALID_INPUT" }); d.status = b.decision === "approve" ? "APPROVED" : b.decision === "freeze" ? "FROZEN" : b.decision === "manual_review" ? "COMPLIANCE_REVIEW" : "COMPLIANCE_REJECTED"; d.complianceReason = b.reason || ""; audit("donation", d.id, "COMPLIANCE_REVIEWED", b); } else if (action === "mon-deposit") { if (!allowed(req, ["finance", "platform_admin"])) throw Object.assign(new Error("无权存入 MON"), { status: 403, code: "ROLE_NOT_ALLOWED" }); if (d.status !== "APPROVED") throw Object.assign(new Error("捐赠尚未通过合规审核"), { status: 409, code: "INVALID_STATE_TRANSITION" }); if (d.monAmount) throw Object.assign(new Error("该捐赠已完成 MON 存入"), { status: 409, code: "DUPLICATE_DEPOSIT" }); const amount = Number(b.amountMon ?? d.monIntentAmount); if (d.monIntentAmount != null && amount !== d.monIntentAmount) throw Object.assign(new Error("存入金额必须与审核后的 MON 意向一致"), { status: 400, code: "INVALID_AMOUNT" }); if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("amountMon 必须大于 0"), { status: 400, code: "INVALID_AMOUNT" }); const tx = chain("MON_DEPOSIT", d.id, { amountMon: amount, priceSnapshot: b.priceSnapshot || null }); d.monAmount = amount; d.monPriceSnapshot = b.priceSnapshot || { source: "demo", cnyAmount: d.fiatAmount }; d.watermarkId = id("WM"); d.status = "MON_DEPOSIT_PENDING"; d.depositTxHash = null; const f = { id: id("FUND"), donationId: d.id, amountMon: amount, availableMon: 0, watermarkId: d.watermarkId }; d.fund = f; d.depositChainTransactionId = tx.id; trace("deposit", "MON 存入交易待确认", `${d.donor} 等待确认 ${amount} MON。`, d.id, tx); audit("donation", d.id, "MON_DEPOSIT_QUEUED", tx); return { data: d, chain: tx }; } else throw Object.assign(new Error("不支持的捐赠动作"), { status: 404, code: "NOT_FOUND" }); return { data: d }; }); return send(res, action === "mon-deposit" ? 202 : 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
if (p === "/v1/tasks" && req.method === "POST") { if (!allowed(req, ["reporter", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权上报任务"); const b = await body(req); try { const result = await write(req, "task:create", b, () => { const a = actor(req); const t = enrichTask({ visibility: b.visibility ?? "PUBLIC", isPrivate: b.isPrivate === true || b.private === true, title: b.title, monTarget: b.monTarget, monRaised: b.monRaised, participants: b.participants, participantTarget: b.participantTarget, articleId: b.articleId, sections: b.sections, urgencyLabel: b.urgencyLabel, need: b.need, image: b.image, id: id("TASK"), disasterType: b.disasterType || "未分类", location: b.location || {}, taskType: b.taskType || "救援", severity: b.severity || "normal", requirements: b.requirements || {}, reporterUserId: a.userId, organizationId: a.organizationId, status: "REPORTED", verificationStatus: "PENDING", createdAt: now() }); for (const field of ["monTarget", "monRaised", "participants", "participantTarget"]) { if (!Number.isFinite(t[field]) || t[field] < 0) throw Object.assign(new Error("任务指标必须为非负数"), { status: 400, code: "INVALID_INPUT" }); } state.tasks.unshift(t); audit("task", t.id, "CREATED", t); return { data: t }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "INVALID_INPUT", e.message); } }
  if (parts[0] === "v1" && parts[1] === "tasks" && parts.length === 4 && parts[3] !== "responses" && req.method === "POST") { const t = find("tasks", parts[2]); if (!t) return error(res, 404, "NOT_FOUND", "任务不存在"); if (!allowed(req, ["official_verifier", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权操作任务"); const action = parts[3]; if (["verify", "approve"].includes(action) && t.reporterUserId === actor(req).userId) return error(res, 403, "SELF_REVIEW_NOT_ALLOWED", "上报人不能核验或批准自己的任务"); const b = await body(req); try { const result = await write(req, `task:${t.id}:${action}`, b, () => { if (action === "verify") { if (t.status !== "REPORTED" || t.verificationStatus !== "PENDING") throw Object.assign(new Error("只有待核验的上报任务可以核验"), { status: 409, code: "INVALID_STATE_TRANSITION" }); t.verificationStatus = "VERIFIED"; t.verifiedBy = actor(req).userId; t.status = "VERIFIED"; } else if (action === "approve") { if (t.status !== "VERIFIED" || t.verificationStatus !== "VERIFIED") throw Object.assign(new Error("只有已核验且未发布的任务可以批准"), { status: 409, code: "INVALID_STATE_TRANSITION" }); t.status = "DISPATCHING"; const tx = chain("TASK_APPROVED", t.id, b); t.approvalTxHash = tx.txHash; trace("task", "灾情任务通过核验", "任务进入资源调度。", t.id, tx); } else throw Object.assign(new Error("任务动作不存在"), { status: 404, code: "NOT_FOUND" }); audit("task", t.id, action.toUpperCase(), b); return { data: t }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (p === "/v1/tasks" && req.method === "GET") return send(res, 200, { data: state.tasks.filter(task => isPublicTask(task) || canReadDetail(req, "task", task.id)).map(task => canReadDetail(req, "task", task.id) ? task : publicTask(task)) });
  if (parts[0] === "v1" && parts[1] === "tasks" && parts.length === 3 && req.method === "GET") { const t = find("tasks", parts[2]); if (!t) return error(res, 404, "NOT_FOUND", "任务不存在"); if (canReadDetail(req, "task", t.id)) return send(res, 200, { data: t }); if (!isPublicTask(t)) return error(res, actor(req).userId ? 403 : 401, actor(req).userId ? "SCOPE_DENIED" : "AUTH_REQUIRED", "无权查询该任务"); return send(res, 200, { data: publicTask(t) }); }
  if (parts[0] === "v1" && parts[1] === "tasks" && parts[3] === "responses" && req.method === "POST") { const t = find("tasks", parts[2]); if (!t) return error(res, 404, "NOT_FOUND", "任务不存在"); if (!allowed(req, ["supplier", "rescue_team", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权提交资源响应"); if (t.verificationStatus !== "VERIFIED" || !["DISPATCHING", "EXECUTING"].includes(t.status)) return error(res, 409, "INVALID_STATE_TRANSITION", "任务尚未发布、已暂停或已结束"); const b = await body(req); try { const result = await write(req, `task:${t.id}:response`, b, () => { if (!b.resourceProfileId || !b.quantity || !b.unitPrice) throw Object.assign(new Error("资源响应字段不完整"), { status: 400, code: "INVALID_INPUT" }); const a = actor(req); const r = { id: id("RESP"), taskId: t.id, resourceProfileId: b.resourceProfileId, organizationId: a.organizationId, submittedBy: a.userId, quantity: Number(b.quantity), unitPrice: Number(b.unitPrice), etaHours: Number(b.etaHours || 0), payload: b.payload || {}, status: "RESPONSE_SUBMITTED", createdAt: now() }; state.responses.unshift(r); audit("resource_response", r.id, "SUBMITTED", r); return { data: r }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (p === "/v1/awards" && req.method === "POST") { if (!allowed(req, ["dispatcher", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权提出中选方案"); const b = await body(req); try { const result = await write(req, "award:create", b, () => { const r = find("responses", b.responseId); if (!r) throw Object.assign(new Error("资源响应不存在"), { status: 404, code: "NOT_FOUND" }); const a = { id: id("AWD"), taskId: r.taskId, responseId: r.id, reason: b.reason || "", status: "AWARD_PENDING_APPROVAL", createdAt: now() }; state.awards.unshift(a); audit("award", a.id, "PROPOSED", a); return { data: a }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "awards" && parts.length === 4 && parts[3] === "approve" && req.method === "POST") { const a = find("awards", parts[2]); if (!a) return error(res, 404, "NOT_FOUND", "中选方案不存在"); if (!allowed(req, ["contract_approver", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权审批中选方案"); const b = await body(req); try { const result = await write(req, `award:${a.id}:approve`, b, () => { if (a.status !== "AWARD_PENDING_APPROVAL") throw Object.assign(new Error("中选方案已处理"), { status: 409, code: "INVALID_STATE_TRANSITION" }); a.status = "AWARDED"; a.approvedBy = actor(req).userId; a.approvedAt = now(); audit("award", a.id, "APPROVED", b); return { data: a }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (p === "/v1/responses" && req.method === "GET") return allowed(req, ["dispatcher", "auditor", "platform_admin"]) ? send(res, 200, { data: state.responses }) : error(res, 401, "AUTH_REQUIRED", "请先登录");
  if (parts[0] === "v1" && parts[1] === "responses" && parts.length === 3 && req.method === "GET") { if (!allowed(req, ["dispatcher", "supplier", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); if (!canReadDetail(req, "response", parts[2])) return error(res, 403, "SCOPE_DENIED", "无权查询该资源响应"); const d = detail("response", parts[2]); return d ? send(res, 200, { data: d }) : error(res, 404, "NOT_FOUND", "资源响应不存在"); }
  if (p === "/v1/awards" && req.method === "GET") return allowed(req, ["dispatcher", "contract_approver", "auditor", "platform_admin"]) ? send(res, 200, { data: state.awards }) : error(res, 401, "AUTH_REQUIRED", "请先登录");
  if (parts[0] === "v1" && parts[1] === "awards" && parts.length === 3 && req.method === "GET") { if (!allowed(req, ["dispatcher", "contract_approver", "supplier", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); if (!canReadDetail(req, "award", parts[2])) return error(res, 403, "SCOPE_DENIED", "无权查询该中选方案"); const d = detail("award", parts[2]); return d ? send(res, 200, { data: d }) : error(res, 404, "NOT_FOUND", "中选方案不存在"); }
  if (p === "/v1/contracts" && req.method === "GET") return allowed(req, ["finance", "contract_approver", "auditor", "platform_admin"]) ? send(res, 200, { data: state.contracts.filter(c => canReadDetail(req, "contract", c.id)) }) : error(res, 401, "AUTH_REQUIRED", "请先登录");
  if (parts[0] === "v1" && parts[1] === "contracts" && parts.length === 3 && req.method === "GET") { if (!allowed(req, ["finance", "contract_approver", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); const c = find("contracts", parts[2]); if (c && !canReadDetail(req, "contract", c.id)) return error(res, 403, "SCOPE_DENIED", "无权查询该合同"); return c ? send(res, 200, { data: c }) : error(res, 404, "NOT_FOUND", "合同不存在"); }
  if (p === "/v1/deliveries" && req.method === "GET") return allowed(req, ["supplier", "acceptance", "finance", "auditor", "platform_admin"]) ? send(res, 200, { data: state.deliveries.filter(d => canReadDetail(req, "delivery", d.id)) }) : error(res, 401, "AUTH_REQUIRED", "请先登录");
  if (parts[0] === "v1" && parts[1] === "deliveries" && parts.length === 3 && req.method === "GET") { if (!allowed(req, ["supplier", "acceptance", "finance", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); if (!canReadDetail(req, "delivery", parts[2])) return error(res, 403, "SCOPE_DENIED", "无权查询该交付批次"); const d = detail("delivery", parts[2]); return d ? send(res, 200, { data: d }) : error(res, 404, "NOT_FOUND", "交付批次不存在"); }
  if (p === "/v1/settlements" && req.method === "GET") return allowed(req, ["finance", "auditor", "platform_admin"]) ? send(res, 200, { data: state.redemptions.filter(x => String(x.id).startsWith("SET-") && canReadDetail(req, "settlement", x.id)) }) : error(res, 401, "AUTH_REQUIRED", "请先登录");
  if (parts[0] === "v1" && parts[1] === "settlements" && parts.length === 3 && req.method === "GET") { if (!allowed(req, ["finance", "contract_approver", "supplier", "auditor", "platform_admin"])) return error(res, 401, "AUTH_REQUIRED", "请先登录"); if (!canReadDetail(req, "settlement", parts[2])) return error(res, 403, "SCOPE_DENIED", "无权查询该结算"); const d = detail("settlement", parts[2]); return d && d.item.id.startsWith("SET-") ? send(res, 200, { data: d }) : error(res, 404, "NOT_FOUND", "结算不存在"); }
  if (p === "/v1/redemptions" && req.method === "GET") return allowed(req, ["finance", "compliance", "auditor", "platform_admin"]) ? send(res, 200, { data: state.redemptions.filter(x => String(x.id).startsWith("RED-") && canReadDetail(req, "redemption", x.id)) }) : error(res, 401, "AUTH_REQUIRED", "请先登录");
  if (p === "/v1/contracts" && req.method === "POST") { if (!allowed(req, ["contract_approver", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权创建合同"); const b = await body(req); try { const result = await write(req, "contract:create", b, () => { const a = find("awards", b.awardId); if (!a || a.status !== "AWARDED") throw Object.assign(new Error("中选方案尚未批准"), { status: 409, code: "INVALID_STATE_TRANSITION" }); const r = find("responses", a.responseId); const c = { id: id("CTR"), taskId: a.taskId, awardId: a.id, party: b.party || "待确认组织", subject: b.subject || "救援服务", amountMon: Number(b.amountMon || 0), supplierOrganizationId: r && r.organizationId || null, status: "PENDING_APPROVAL", progress: 0, watermarkId: b.watermarkId || null, termsHash: hash(JSON.stringify(b)), createdAt: now() }; if (c.amountMon <= 0) throw Object.assign(new Error("合同 MON 金额必须大于 0"), { status: 400, code: "INVALID_INPUT" }); state.contracts.unshift(c); audit("contract", c.id, "CREATED", c); return { data: c }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "contracts" && parts.length === 4 && parts[3] === "approve" && req.method === "POST") { const c = find("contracts", parts[2]); if (!c) return error(res, 404, "NOT_FOUND", "合同不存在"); if (!allowed(req, ["contract_approver", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权审批合同"); const b = await body(req); try { const result = await write(req, `contract:${c.id}:approve`, b, () => { if (c.status !== "PENDING_APPROVAL") throw Object.assign(new Error("合同已审批或不可审批"), { status: 409, code: "INVALID_STATE_TRANSITION" }); const reserved = state.contracts.filter(x => !["PENDING_APPROVAL", "SETTLED", "CANCELLED"].includes(x.status)).reduce((sum, x) => sum + Number(x.amountMon || 0), 0); const deposited = state.donations.reduce((sum, x) => sum + Number(x.monAmount || 0), 0); if (reserved + c.amountMon > deposited) throw Object.assign(new Error("可用 MON 不足"), { status: 409, code: "INSUFFICIENT_AVAILABLE_MON" }); const tx = chain("ESCROW_CREATED", c.id, c); c.status = "FUNDS_RESERVATION_PENDING"; c.progress = 5; c.chainTransactionId = tx.id; trace("escrow", "合同托管交易待提交", `${c.party} 合同等待锁定 ${c.amountMon} MON。`, c.id, tx); audit("contract", c.id, "APPROVED", tx); return { data: c, chain: tx }; }); return send(res, 202, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "contracts" && parts.length === 4 && parts[3] === "escrow-confirm" && req.method === "POST") { const c = find("contracts", parts[2]); if (!c) return error(res, 404, "NOT_FOUND", "合同不存在"); if (!allowed(req, ["finance", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权确认托管"); const b = await body(req); try { const result = await write(req, `contract:${c.id}:escrow-confirm`, b, () => { if (!c.chainTransactionId) throw Object.assign(new Error("合同尚未提交链上交易"), { status: 409, code: "CHAIN_TRANSACTION_REQUIRED" }); const tx = find("chainTransactions", c.chainTransactionId); if (!tx || tx.status !== "CONFIRMED") throw Object.assign(new Error("链上托管尚未确认"), { status: 409, code: "CHAIN_NOT_CONFIRMED" }); if (!["FUNDS_RESERVATION_PENDING", "FUNDS_RESERVED"].includes(c.status)) throw Object.assign(new Error("合同不在待托管状态"), { status: 409, code: "INVALID_STATE_TRANSITION" }); if (c.escrowDebited) return { data: c, chain: tx }; const available = state.donations.reduce((sum, d) => sum + Number(d.fund && d.fund.availableMon || 0), 0); if (available < Number(c.amountMon)) throw Object.assign(new Error("可用 MON 不足"), { status: 409, code: "INSUFFICIENT_AVAILABLE_MON" }); let remaining = Number(c.amountMon); state.donations.forEach(d => { if (remaining <= 0 || !d.fund) return; const use = Math.min(remaining, Number(d.fund.availableMon || 0)); d.fund.availableMon -= use; d.fund.escrowedMon = Number(d.fund.escrowedMon || 0) + use; remaining -= use; }); c.status = "FUNDS_RESERVED"; c.escrowDebited = true; c.escrowConfirmedAt = now(); c.escrowReference = b.escrowReference || tx.txHash; c.progress = Math.max(c.progress || 0, 15); audit("contract", c.id, "FUNDS_RESERVED", b); return { data: c, chain: tx }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "contracts" && parts.length === 4 && parts[3] === "deliveries" && req.method === "POST") { const c = find("contracts", parts[2]); if (!c) return error(res, 404, "NOT_FOUND", "合同不存在"); if (!allowed(req, ["supplier", "rescue_team", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权创建交付批次"); if (!hasRole(actor(req), ["platform_admin"]) && (!actor(req).organizationId || c.supplierOrganizationId !== actor(req).organizationId)) return error(res, 403, "SCOPE_DENIED", "无权为其他组织的合同创建交付批次"); if (!["FUNDS_RESERVED", "IN_PROGRESS"].includes(c.status)) return error(res, 409, "INVALID_STATE_TRANSITION", "合同尚未进入履约"); const b = await body(req); try { const result = await write(req, `contract:${c.id}:delivery`, b, () => { const planned = Number(b.plannedQuantity || 0); const previous = state.deliveries.filter(x => x.contractId === c.id).reduce((sum, x) => sum + x.plannedQuantity, 0); const a = actor(req); const d = { id: id("DEL"), contractId: c.id, organizationId: a.organizationId, createdBy: a.userId, plannedQuantity: planned, deliveredQuantity: 0, acceptedQuantity: 0, status: "IN_PROGRESS", evidenceIds: b.evidenceIds || [], createdAt: now() }; if (!planned || previous + planned > Number(c.plannedQuantity || planned)) throw Object.assign(new Error("plannedQuantity 超出合同计划"), { status: 400, code: "INVALID_INPUT" }); state.deliveries.unshift(d); c.status = "IN_PROGRESS"; c.progress = 45; audit("delivery", d.id, "CREATED", d); return { data: d }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "deliveries" && parts.length === 4 && parts[3] === "accept" && req.method === "POST") { const d = find("deliveries", parts[2]); if (!d) return error(res, 404, "NOT_FOUND", "交付批次不存在"); if (!allowed(req, ["acceptance", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权验收交付"); const b = await body(req); try { const result = await write(req, `delivery:${d.id}:accept`, b, () => { const accepted = Number(b.acceptedQuantity || 0); const delivered = Number(b.deliveredQuantity || accepted); if (delivered < 0 || accepted < 0 || accepted > delivered || delivered > d.plannedQuantity) throw Object.assign(new Error("交付或验收数量超出计划"), { status: 409, code: "INVALID_QUANTITY" }); d.deliveredQuantity = delivered; d.acceptedQuantity = accepted; d.status = b.result === "rejected" ? "REJECTED" : b.result === "disputed" ? "DISPUTED" : "ACCEPTED"; const c = find("contracts", d.contractId); if (c) { c.status = d.status === "ACCEPTED" ? "PENDING_SETTLEMENT" : d.status; c.progress = d.status === "ACCEPTED" ? 80 : c.progress; } const tx = chain("DELIVERY_ACCEPTED", d.id, b); d.acceptanceTxHash = tx.txHash; trace("acceptance", "交付批次已验收", `交付批次 ${d.id} 验收 ${accepted}。`, d.id, tx); audit("delivery", d.id, "ACCEPTED", b); return { data: d }; }); return send(res, 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "contracts" && parts.length === 4 && parts[3] === "settlements" && req.method === "POST") { const c = find("contracts", parts[2]); if (!c) return error(res, 404, "NOT_FOUND", "合同不存在"); if (!allowed(req, ["finance", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权创建结算"); if (c.status !== "PENDING_SETTLEMENT") return error(res, 409, "INVALID_STATE_TRANSITION", "合同尚未达到结算条件"); const b = await body(req); try { const result = await write(req, `contract:${c.id}:settlement`, b, () => { const amount = Number(b.acceptedAmountMon || c.amountMon); if (amount <= 0 || amount > c.amountMon) throw Object.assign(new Error("结算金额超出合同上限"), { status: 400, code: "INVALID_AMOUNT" }); if (state.redemptions.some(x => x.contractId === c.id && x.status !== "CANCELLED" && x.id.startsWith("SET-"))) throw Object.assign(new Error("合同已存在结算申请"), { status: 409, code: "DUPLICATE_SETTLEMENT" }); const s = { id: id("SET"), contractId: c.id, acceptedAmountMon: amount, status: "SETTLEMENT_PENDING", createdAt: now() }; state.redemptions.push(s); c.status = "SETTLEMENT_PENDING"; audit("settlement", s.id, "CREATED", s); return { data: s }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "settlements" && parts.length === 4 && parts[3] === "redemptions" && req.method === "POST") { const s = find("redemptions", parts[2]); if (!s || !s.id.startsWith("SET-")) return error(res, 404, "NOT_FOUND", "结算不存在"); if (!allowed(req, ["finance", "platform_admin"])) return error(res, 403, "ROLE_NOT_ALLOWED", "无权创建兑换申请"); if (s.status !== "SETTLEMENT_PENDING") return error(res, 409, "INVALID_STATE_TRANSITION", "结算不在待兑换状态"); const b = await body(req); try { const result = await write(req, `settlement:${s.id}:redemption`, b, () => { const monAmount = Number(b.monAmount || s.acceptedAmountMon); if (!Number.isFinite(monAmount) || monAmount <= 0 || monAmount > s.acceptedAmountMon) throw Object.assign(new Error("兑换 MON 数量超出结算金额"), { status: 400, code: "INVALID_AMOUNT" }); const r = { id: id("RED"), settlementId: s.id, organizationId: b.organizationId || currentActor().organizationId, payoutAccountId: b.payoutAccountId || null, monAmount, fiatAmount: Number(b.fiatAmount || 0), priceSnapshot: b.priceSnapshot || {}, exchangeRuleVersion: Number(b.exchangeRuleVersion || 1), status: "REQUESTED", createdAt: now() }; state.redemptions.push(r); s.redemptionId = r.id; audit("redemption", r.id, "REQUESTED", r); return { data: r }; }); return send(res, 201, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (parts[0] === "v1" && parts[1] === "redemptions" && parts.length === 4 && req.method === "POST") { const r = find("redemptions", parts[2]); if (!r || !r.id.startsWith("RED-")) return error(res, 404, "NOT_FOUND", "兑换申请不存在"); const action = parts[3]; const b = await body(req); try { const result = await write(req, `redemption:${r.id}:${action}`, b, () => { if (action === "approve") { if (!allowed(req, ["finance", "compliance", "platform_admin"])) throw Object.assign(new Error("无权审批兑换"), { status: 403, code: "ROLE_NOT_ALLOWED" }); if (r.status !== "REQUESTED") throw Object.assign(new Error("兑换申请已处理"), { status: 409, code: "INVALID_STATE_TRANSITION" }); if (!r.payoutAccountId) throw Object.assign(new Error("缺少收款账户"), { status: 400, code: "PAYOUT_ACCOUNT_REQUIRED" }); const s = find("redemptions", r.settlementId); if (!s) throw Object.assign(new Error("关联结算不存在"), { status: 409, code: "SETTLEMENT_NOT_FOUND" }); const c = find("contracts", s.contractId); if (!c) throw Object.assign(new Error("关联合同不存在"), { status: 409, code: "CONTRACT_NOT_FOUND" }); const available = state.donations.reduce((sum, d) => sum + Number(d.fund && d.fund.availableMon || 0), 0); if (available < r.monAmount) throw Object.assign(new Error("可用 MON 不足"), { status: 409, code: "INSUFFICIENT_AVAILABLE_MON" }); const tx = chain("MON_LOCKED", r.id, r); r.status = "MON_LOCK_PENDING"; r.lockChainTransactionId = tx.id; r.lockTxHash = null; } else if (action === "payout") { if (!allowed(req, ["finance", "platform_admin"])) throw Object.assign(new Error("无权发起兑付"), { status: 403, code: "ROLE_NOT_ALLOWED" }); if (!["MON_LOCKED", "PAID"].includes(r.status) || !b.payoutReference) throw Object.assign(new Error("MON 尚未锁定或缺少支付回执"), { status: 409, code: "INVALID_STATE_TRANSITION" }); assertUniqueReference("payoutReference", b.payoutReference, "redemptions", r.id); if (Number(r.fiatAmount || 0) <= 0 && Number(b.fiatAmount || 0) <= 0) throw Object.assign(new Error("缺少人民币兑付金额"), { status: 400, code: "INVALID_AMOUNT" }); r.fiatAmount = Number(b.fiatAmount || r.fiatAmount); r.status = "PAID"; r.payoutReference = b.payoutReference; r.paidAt = now(); } else if (action === "settle") { if (!allowed(req, ["finance", "platform_admin"])) throw Object.assign(new Error("无权结算"), { status: 403, code: "ROLE_NOT_ALLOWED" }); if (r.status !== "PAID" || !r.payoutReference) throw Object.assign(new Error("人民币尚未完成可核验兑付"), { status: 409, code: "INVALID_STATE_TRANSITION" }); const tx = chain("MON_SETTLED", r.id, b); r.status = "SETTLEMENT_CHAIN_PENDING"; r.settlementChainTransactionId = tx.id; r.settlementTxHash = null; } else throw Object.assign(new Error("兑换动作不存在"), { status: 404, code: "NOT_FOUND" }); audit("redemption", r.id, action.toUpperCase(), b); return { data: r, chain: r.lockChainTransactionId ? find("chainTransactions", r.lockChainTransactionId) : r.settlementChainTransactionId ? find("chainTransactions", r.settlementChainTransactionId) : null }; }); return send(res, action === "approve" || action === "settle" ? 202 : 200, result); } catch (e) { return error(res, e.status || 400, e.code || "BUSINESS_ERROR", e.message); } }
  if (p === "/v1" || p.startsWith("/v1/") || p === "/api" || p.startsWith("/api/")) return error(res, 404, "NOT_FOUND", "接口不存在");
  return serveStatic(req, res, p);
}
function serveStatic(req, res, p) {
  if (req.method !== "GET") return error(res, 404, "NOT_FOUND", "资源不存在");
  let decoded;
  try { decoded = decodeURIComponent(p); } catch (_) { return error(res, 400, "INVALID_PATH", "非法路径"); }
  let relative;
  if (["/", "/mobile", "/mobile/"].includes(decoded)) relative = "mobile/index.html";
  else if (["/admin", "/admin/"].includes(decoded)) relative = "admin/index.html";
  else if (["/operations", "/operations/"].includes(decoded)) relative = "operations/index.html";
  else if (/^\/(mobile|admin|operations|shared)\//.test(decoded)) relative = decoded.slice(1);
  else return error(res, 404, "NOT_FOUND", "资源不存在");
  const webRoot = path.join(ROOT, "web");
  const safe = path.resolve(webRoot, relative);
  if (!safe.startsWith(webRoot + path.sep)) return error(res, 403, "FORBIDDEN", "非法路径");
  try {
    const real = fs.realpathSync(safe);
    if (!real.startsWith(fs.realpathSync(webRoot) + path.sep)) return error(res, 403, "FORBIDDEN", "非法路径");
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
    send(res, 200, fs.readFileSync(real), { "Content-Type": types[path.extname(real)] || "application/octet-stream" });
  } catch (_) { error(res, 404, "NOT_FOUND", "资源不存在"); }
}
let adminSessions;
const walletService = createWalletService({ dataDir: path.join(DATA_DIR, "wallet"), origin: new URL(PUBLIC_BASE_URL).origin, send, readBody: body, getBusinessTasks: () => state.tasks, options: { isAdminSession: req => !!adminSessions && adminSessions.authorized(req), newOperationsEnabled: process.env.RELIEF_ENABLE_WALLET_PROTOTYPE === "true" && process.env.NODE_ENV !== "production" } });
adminSessions = createAdminSessions({ origin: new URL(PUBLIC_BASE_URL).origin, send, readBody: body, verifyToken: req => walletService.accounts.isAdminToken(req) });
const platformService = createPlatformService({ file: path.join(DATA_DIR, "platform.sqlite"), accounts: walletService.accounts,
  isAdmin: req => adminSessions.authorized(req), send, readBody: body, getTasks: () => state.tasks,
  getResources: () => state.marketplace, escrowContract: process.env.MONAD_PROCUREMENT_POOL_ADDRESS || null });
const fundingPoolAddress = FUNDING_INDEXER_CONFIG?.poolAddress || null;
const donationIntents = fundingPoolAddress ? createDonationIntentStore({ file: path.join(DATA_DIR, "funding", "donation-intents.sqlite"), chainId: "10143", poolAddress: fundingPoolAddress }) : null;
const fundingLedger = fundingPoolAddress ? createFundingStore({ file: path.join(DATA_DIR, "funding", "funding.sqlite"), chainId: "10143", poolAddress: fundingPoolAddress }) : null;
let fundingIndexerRuntime = null;
if (FUNDING_INDEXER_CONFIG?.enabled) {
  const provider = new JsonRpcProvider(FUNDING_INDEXER_CONFIG.rpcUrl);
  const indexer = createFundingIndexer({ provider, chainId: "10143", poolAddress: fundingPoolAddress,
    runtimeCodeHash: FUNDING_INDEXER_CONFIG.runtimeCodeHash, confirmations: FUNDING_INDEXER_CONFIG.confirmations,
    startBlock: FUNDING_INDEXER_CONFIG.startBlock, file: path.join(DATA_DIR, "funding", "indexer.sqlite"), fundingStore: fundingLedger,
    resolveRegistration: async donationId => donationIntents.get(donationId) });
  fundingIndexerRuntime = createFundingIndexerRuntime({ indexer, pollIntervalMs: FUNDING_INDEXER_CONFIG.pollIntervalMs,
    reportError: code => console.error(`[funding-indexer] ${code}`), closeProvider: async () => provider.destroy() });
}
const fundingReadService = createFundingReadService({ accounts: walletService.accounts, isAdmin: req => adminSessions.authorized(req),
  send, intents: donationIntents, funding: fundingLedger, chainId: "10143", poolAddress: fundingPoolAddress,
  getIndexerStatus: fundingIndexerRuntime ? () => fundingIndexerRuntime.status() : null });
const server = http.createServer((req, res) => {
  const requestActor = actor(req);
  requestContext.run(requestActor, () => route(req, res).catch(e => error(res, e.status || 500, e.status ? e.code : "INTERNAL_ERROR", e.message, true)));
});
server.listen(PORT, () => { walletService.start(); fundingIndexerRuntime?.start(); console.log(`Relief MON backend listening on http://localhost:${server.address().port}`); console.log(`Wallet admin token file: ${walletService.adminTokenPath}`); });
let closingServices = null;
function closeServices() {
  if (!closingServices) closingServices = (async () => {
    await fundingIndexerRuntime?.close(); platformService.close(); donationIntents?.close(); fundingLedger?.close(); await walletService.close();
  })();
  return closingServices;
}
server.on("close", () => { void closeServices().catch(error => console.error("Service shutdown failed:", error.code || error.message)); });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  const forced = setTimeout(() => process.exit(1), 10000);
  server.closeAllConnections();
  server.close(() => { void closeServices().then(() => { clearTimeout(forced); process.exit(0); }, error => {
    console.error("Service shutdown failed:", error.code || error.message); clearTimeout(forced); process.exit(1);
  }); });
});
