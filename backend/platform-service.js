"use strict";

const { createOperatorRegistry } = require("./operator-registry");
const { createProcurementStore } = require("./procurement-store");
const { keccak256, toUtf8Bytes } = require("ethers");

function fail(status, code, message) { throw Object.assign(new Error(message || code), { status, code }); }
function shape(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) fail(400, "INVALID_INPUT", "请求字段不符合当前业务操作");
}
function sameWallet(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function currentTerms(contract) { return contract.versions[contract.currentVersion - 1]; }
function publicTask(task) {
  return task.isPrivate !== true && task.private !== true &&
    (task.visibility == null || String(task.visibility).toUpperCase() === "PUBLIC");
}
function visibleTask(task, binding) {
  return publicTask(task) || !!binding.organizationId && task.organizationId === binding.organizationId;
}
function textHash(text) {
  if (typeof text !== "string" || text.length < 2 || text.length > 16000) fail(400, "INVALID_DOCUMENT", "合同正文和验收标准长度须为 2..16000");
  try { return keccak256(toUtf8Bytes(text)); }
  catch { fail(400, "INVALID_DOCUMENT", "合同正文必须为有效 Unicode 文本"); }
}
function statementRecord(statement, evidenceIds) {
  if (typeof statement !== "string" || statement.trim().length < 2 || statement.length > 16000) fail(400, "INVALID_ATTESTATION", "交付或验收说明须为 2..16000 字且不得为空");
  try { toUtf8Bytes(statement); } catch { fail(400, "INVALID_ATTESTATION", "说明必须为有效 Unicode 文本"); }
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > 6 || new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id))) fail(400, "EVIDENCE_REQUIRED", "须关联 1..6 件本批次原始附件");
  return { statement, evidenceIds };
}

function createPlatformService({ file, accounts, isAdmin, send, readBody, getTasks, getResources, escrowContract = null, clock = Date.now }) {
  const registry = createOperatorRegistry({ file, clock });
  let store;
  try { store = createProcurementStore({ file, escrowContract, clock }); }
  catch (error) { registry.close(); throw error; }

  function operator(req, roles) {
    if (req.headers["x-relief-actor"] === "admin") fail(403, "BUSINESS_ACCOUNT_REQUIRED", "请使用独立岗位账户执行业务操作");
    const user = accounts.requireUser(req), binding = registry.lookup(user.id);
    if (!binding || !sameWallet(binding.wallet, user.wallet)) fail(403, "OPERATOR_REQUIRED", "当前账户尚未领取有效岗位，或绑定钱包已变更");
    if (roles && !roles.includes(binding.role)) fail(403, "ROLE_NOT_ALLOWED", "当前岗位无权执行此操作");
    return { ...binding, user };
  }
  function assertContractScope(contract, binding, side) {
    const terms = currentTerms(contract);
    if (binding.role === "reviewer") {
      if (side || !store.read().batches.some(batch => batch.contractId === contract.id && assignedTo(batch, binding))) fail(403, "SCOPE_DENIED", "仅可查看当前获分派的复核批次");
      return terms;
    }
    const sides = side ? [side] : ["buyer", "supplier"];
    if (!sides.some(key => terms[key + "OrganizationId"] === binding.organizationId)) fail(403, "SCOPE_DENIED", "无权访问其他机构合同");
    return terms;
  }
  function assignedTo(batch, binding) {
    const assignment = batch.reviewAssignments?.at(-1);
    return binding.role === "reviewer" && assignment?.assignmentId === binding.id &&
      assignment.reviewer.id === binding.user.id && sameWallet(assignment.reviewer.wallet, binding.wallet) &&
      assignment.reviewer.organizationId === binding.organizationId;
  }
  function assertBatchScope(batch, binding) {
    if (binding.role === "reviewer" && !assignedTo(batch, binding)) fail(403, "SCOPE_DENIED", "该批次未分派给当前复核岗位，或已改派");
  }
  function reviewSeparation(snapshot, batch, candidate) {
    const terms = currentTerms(snapshot.contracts.find(item => item.id === batch.contractId));
    const samePerson = person => person && (person.id === candidate.userId || sameWallet(person.wallet, candidate.wallet));
    const participants = snapshot.batches.filter(item => item.contractId === batch.contractId);
    const reservation = snapshot.reservations.find(item => item.id === terms.reservationId);
    if ([terms.buyerOrganizationId, terms.supplierOrganizationId, reservation?.buyerOrganizationId].includes(candidate.organizationId) ||
        sameWallet(candidate.wallet, terms.buyerWallet) || sameWallet(candidate.wallet, terms.supplierWallet) ||
        participants.some(item => [item.deliveryActor, item.acceptance?.actor].some(samePerson)) ||
        snapshot.payments.some(item => item.contractId === batch.contractId && samePerson(item.financeActor)) ||
        store.getParticipantActorIds(batch.contractId).data.includes(candidate.userId)) {
      fail(403, "SEPARATION_OF_DUTIES", "复核人须独立于采购、供方、交付、原验收及财务人员");
    }
  }
  function signerParty(contract, binding) {
    const terms = assertContractScope(contract, binding);
    const party = binding.role === "contract_approver" ? "buyer" : binding.role === "supplier" ? "supplier" : null;
    if (!party || terms[party + "OrganizationId"] !== binding.organizationId || !sameWallet(terms[party + "Wallet"], binding.wallet)) fail(403, "SIGNER_REQUIRED", "当前钱包或岗位不是合同签署方");
    return party;
  }
  function activeSupplier(quote) {
    const user = accounts.getByWallet(quote.supplierWallet);
    const binding = user && registry.lookup(user.id);
    return !!binding && binding.userId === user.id && binding.role === "supplier" &&
      binding.organizationId === quote.supplierOrganizationId &&
      sameWallet(user.wallet, quote.supplierWallet) && sameWallet(binding.wallet, quote.supplierWallet);
  }
  function purchasableQuote(quote, now) {
    return quote.validUntil > now && quote.availableQuantity > 0 && activeSupplier(quote);
  }
  function view(req) {
    const snapshot = store.read();
    const admin = isAdmin(req), binding = admin ? null : operator(req);
    const reviewer = binding?.role === "reviewer";
    const assignedBatches = new Set(reviewer ? snapshot.batches.filter(batch => assignedTo(batch, binding)).map(batch => batch.id) : []);
    const assignedContracts = new Set(snapshot.batches.filter(batch => assignedBatches.has(batch.id)).map(batch => batch.contractId));
    const contracts = admin ? snapshot.contracts : snapshot.contracts.filter(contract => reviewer ? assignedContracts.has(contract.id) : [currentTerms(contract).buyerOrganizationId, currentTerms(contract).supplierOrganizationId].includes(binding.organizationId));
    const reservations = admin ? snapshot.reservations : reviewer ? [] : snapshot.reservations.filter(item => item.buyerOrganizationId === binding.organizationId);
    // Keep resource quotes for visible reservations and every visible contract version.
    const referencedQuotes = new Set([...reservations.map(item => item.quoteId),
      ...contracts.flatMap(contract => contract.versions.map(terms => terms.quoteId))]);
    const now = Math.floor(clock() / 1000);
    const quotes = snapshot.quotes.map(quote => ({ ...quote, purchasable: purchasableQuote(quote, now) }))
      .filter(quote => admin || quote.purchasable || referencedQuotes.has(quote.id) ||
      binding?.role === "supplier" && quote.supplierOrganizationId === binding.organizationId && sameWallet(quote.supplierWallet, binding.wallet));
    if (admin) return { ...snapshot, quotes };
    const ids = new Set(contracts.map(contract => contract.id));
    return { ...snapshot, quotes, contracts, reservations,
      escrows: snapshot.escrows.filter(item => ids.has(item.contractId)),
      batches: snapshot.batches.filter(item => reviewer ? assignedBatches.has(item.id) : ids.has(item.contractId)),
      payables: snapshot.payables.filter(item => reviewer ? assignedBatches.has(item.batchId) : ids.has(item.contractId)),
      payments: snapshot.payments.filter(item => reviewer ? assignedBatches.has(item.batchId) : ids.has(item.contractId)) };
  }
  function businessActor(binding, role = binding.role) {
    return { id: binding.user.id, organizationId: binding.organizationId, wallet: binding.wallet, role };
  }
  function financeSeparation(snapshot, contract, binding) {
    const terms = currentTerms(contract);
    const samePerson = actor => actor && (actor.id === binding.user.id || sameWallet(actor.wallet, binding.wallet));
    if (sameWallet(binding.wallet, terms.buyerWallet) || sameWallet(binding.wallet, terms.supplierWallet) ||
        binding.organizationId === terms.supplierOrganizationId || snapshot.batches.some(batch => batch.contractId === contract.id &&
          [batch.deliveryActor, batch.acceptance?.actor, batch.review?.actor].some(samePerson))) {
      fail(403, "SEPARATION_OF_DUTIES", "财务须独立于该合同签署、交付、验收及复核人员");
    }
  }
  function commit(req, method, input, binding, expectedVersion, document, attestation) {
    return store.execute({ method, input, document, attestation, actorId: binding.user.id, expectedVersion, idempotencyKey: req.headers["idempotency-key"] });
  }
  async function handle(req, res, p) {
    if (!p.startsWith("/v1/platform/")) return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!["GET", "POST"].includes(req.method)) fail(405, "METHOD_NOT_ALLOWED", "请求方式不支持");
      if (req.method === "POST") {
        accounts.assertOrigin(req);
        if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] || "")) fail(415, "JSON_REQUIRED", "请求必须为 JSON");
      }
      if (p === "/v1/platform/catalog" && req.method === "GET") {
        const state = store.read(), resources = getResources();
        const now = Math.floor(clock() / 1000);
        const quotes = state.quotes.filter(quote => purchasableQuote(quote, now)).map(quote => {
          const resource = resources.find(item => item.id === quote.resourceId);
          return { id: quote.id, resourceId: quote.resourceId, name: resource?.name || quote.resourceId,
            image: resource?.image || null, unit: resource?.unit || null, category: resource?.category || null,
            supplierOrganizationId: quote.supplierOrganizationId, unitPriceWei: quote.unitPriceWei,
            availableQuantity: quote.availableQuantity, validUntil: quote.validUntil, etaHours: quote.etaHours };
        });
        send(res, 200, { data: quotes, version: state.version }); return true;
      }
      if (p === "/v1/platform/operators/me" && req.method === "GET") {
        const user = accounts.requireUser(req), binding = registry.lookup(user.id);
        send(res, 200, { data: binding && sameWallet(binding.wallet, user.wallet) ? binding : null }); return true;
      }
      if (p === "/v1/platform/operators" && req.method === "GET") {
        if (!isAdmin(req)) fail(403, "ADMIN_REQUIRED", "仅管理员可查看岗位配置");
        send(res, 200, { data: registry.list() }); return true;
      }
      if (p === "/v1/platform/operators/invitations" && req.method === "POST") {
        if (!isAdmin(req)) fail(403, "ADMIN_REQUIRED", "仅管理员可签发岗位邀请");
        const body = await readBody(req); shape(body, ["email", "organizationId", "role"]);
        if (!isAdmin(req)) fail(401, "ADMIN_REQUIRED", "管理会话已失效");
        send(res, 201, { data: registry.issue({ ...body, issuedBy: "platform-bootstrap-admin" }) }); return true;
      }
      if (p === "/v1/platform/operators/claim" && req.method === "POST") {
        if (req.headers["x-relief-actor"] === "admin") fail(403, "BUSINESS_ACCOUNT_REQUIRED", "请用岗位所属账户领取邀请");
        const body = await readBody(req); shape(body, ["code"]);
        const user = accounts.requireUser(req);
        send(res, 200, { data: registry.claim({ code: body.code, user: { id: user.id, email: user.email, wallet: user.wallet } }) }); return true;
      }
      const revoke = p.match(/^\/v1\/platform\/operators\/([^/]+)\/revoke$/);
      if (revoke && req.method === "POST") {
        if (!isAdmin(req)) fail(403, "ADMIN_REQUIRED", "仅管理员可撤销岗位");
        const body = await readBody(req); shape(body, []);
        if (!isAdmin(req)) fail(401, "ADMIN_REQUIRED", "管理会话已失效");
        send(res, 200, { data: registry.revoke({ userId: decodeURIComponent(revoke[1]), revokedBy: "platform-bootstrap-admin" }) }); return true;
      }
      if (p === "/v1/platform/procurement" && req.method === "GET") { send(res, 200, { data: view(req) }); return true; }
      if (p === "/v1/platform/context" && req.method === "GET") {
        const admin = isAdmin(req), binding = admin ? null : operator(req);
        const resources = getResources().map(item => ({ id: item.id, name: item.name ?? null,
          unit: item.unit ?? null, category: item.category ?? null, image: item.image ?? null }));
        const tasks = getTasks().filter(task => task.verificationStatus === "VERIFIED" &&
          ["DISPATCHING", "EXECUTING"].includes(task.status) && (admin || visibleTask(task, binding)))
          .map(task => ({ id: task.id, title: task.title, status: task.status, verificationStatus: task.verificationStatus,
            organizationId: task.organizationId ?? null, visibility: publicTask(task) ? "PUBLIC" : "PRIVATE" }));
        const approvers = binding ? registry.list().filter(item => item.status === "active" &&
          item.role === "contract_approver" && item.organizationId === binding.organizationId).flatMap(item => {
          const user = accounts.getByWallet(item.wallet);
          return user && user.id === item.userId && sameWallet(user.wallet, item.wallet)
            ? [{ userId: user.id, name: user.name, wallet: item.wallet }] : [];
        }) : [];
        const reviewers = admin ? registry.list().filter(item => item.status === "active" && item.role === "reviewer").flatMap(item => {
          const user = accounts.getByWallet(item.wallet);
          return user && user.id === item.userId && sameWallet(user.wallet, item.wallet)
            ? [{ assignmentId: item.id, userId: user.id, name: user.name, wallet: item.wallet, organizationId: item.organizationId }] : [];
        }) : [];
        send(res, 200, { data: { resources, tasks, approvers, ...(admin ? { reviewers } : {}) } }); return true;
      }
      const documentRoute = p.match(/^\/v1\/platform\/contracts\/([^/]+)\/document$/);
      if (documentRoute && req.method === "GET") {
        const binding = isAdmin(req) ? null : operator(req);
        const contract = store.read().contracts.find(item => item.id === decodeURIComponent(documentRoute[1]));
        if (!contract) fail(404, "NOT_FOUND", "合同不存在");
        if (binding) assertContractScope(contract, binding);
        send(res, 200, store.getDocument(contract.id)); return true;
      }
      const attestationsRoute = p.match(/^\/v1\/platform\/contracts\/([^/]+)\/attestations$/);
      if (attestationsRoute && req.method === "GET") {
        const binding = isAdmin(req) ? null : operator(req);
        const contract = store.read().contracts.find(item => item.id === decodeURIComponent(attestationsRoute[1]));
        if (!contract) fail(404, "NOT_FOUND", "合同不存在");
        if (binding) assertContractScope(contract, binding);
        const records = store.getAttestations(contract.id);
        if (binding?.role === "reviewer") {
          const allowed = new Set(store.read().batches.filter(batch => assignedTo(batch, binding)).map(batch => batch.id));
          records.data = records.data.filter(record => allowed.has(record.batchId));
        }
        send(res, 200, records); return true;
      }
      const typed = p.match(/^\/v1\/platform\/contracts\/([^/]+)\/typed-data$/);
      if (typed && req.method === "GET") {
        const binding = operator(req, ["contract_approver", "supplier"]), state = store.read();
        const contract = state.contracts.find(item => item.id === decodeURIComponent(typed[1]));
        if (!contract) fail(404, "NOT_FOUND", "合同不存在");
        signerParty(contract, binding);
        send(res, 200, store.getTypedData(contract.id)); return true;
      }
      const evidenceDownload = p.match(/^\/v1\/platform\/evidence\/([^/]+)\/content$/);
      if (evidenceDownload && req.method === "GET") {
        const binding = isAdmin(req) ? null : operator(req);
        const id = decodeURIComponent(evidenceDownload[1]), metadata = store.getEvidenceMetadata(id).data;
        const contract = store.read().contracts.find(item => item.id === metadata.contractId);
        if (!contract) fail(404, "NOT_FOUND", "关联合同不存在");
        if (binding) assertContractScope(contract, binding);
        if (binding?.role === "reviewer") {
          const batch = store.read().batches.find(item => item.id === metadata.batchId);
          if (!batch) fail(403, "SCOPE_DENIED", "无权访问该批次附件");
          assertBatchScope(batch, binding);
          const bound = store.getAttestations(contract.id).data.some(record => record.batchId === batch.id && record.evidence.some(item => item.id === id));
          const ownDraft = metadata.method === "resolveDispute" && metadata.actor.id === binding.user.id && metadata.reviewAssignmentId === batch.reviewAssignments.at(-1).id;
          if (!bound && !ownDraft) fail(403, "SCOPE_DENIED", "无权访问其他岗位尚未提交的附件");
        }
        const evidence = store.getEvidence(id);
        const filename = encodeURIComponent(evidence.data.filename).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
        send(res, 200, evidence.content, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="evidence-${evidence.data.id.replace(/[^A-Za-z0-9_-]/g, "_")}"; filename*=UTF-8''${filename}`,
          "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "no-store", "X-Content-SHA256": evidence.data.sha256 });
        return true;
      }
      const evidenceUpload = p.match(/^\/v1\/platform\/contracts\/([^/]+)\/evidence$/);
      if (evidenceUpload && req.method === "POST") {
        // Authorize before buffering a large payload, then recheck after the read.
        const before = operator(req, ["supplier", "acceptance", "reviewer"]), contractId = decodeURIComponent(evidenceUpload[1]);
        const initial = store.read().contracts.find(item => item.id === contractId);
        if (!initial) fail(404, "NOT_FOUND", "合同不存在");
        assertContractScope(initial, before, before.role === "reviewer" ? undefined : before.role === "supplier" ? "supplier" : "buyer");
        const input = await readBody(req, 8 * 1024 * 1024);
        shape(input, ["id", "contractVersion", "batchId", "method", "filename", "mimeType", "contentBase64", "reviewAssignmentId"]);
        const binding = operator(req, ["supplier", "acceptance", "reviewer"]);
        if (binding.user.id !== before.user.id || binding.id !== before.id || binding.wallet !== before.wallet || binding.organizationId !== before.organizationId || binding.role !== before.role) fail(403, "OPERATOR_CHANGED", "上传期间岗位或账户发生变化，请重新核验");
        const expectedMethod = binding.role === "supplier" ? "deliverBatch" : binding.role === "reviewer" ? "resolveDispute" : "acceptBatch";
        if (input.method !== expectedMethod) fail(403, "ROLE_NOT_ALLOWED", "当前岗位不能上传该阶段的附件");
        if (binding.role === "reviewer") {
          const snapshot = store.read(), batch = snapshot.batches.find(item => item.id === input.batchId && item.contractId === contractId);
          if (!batch) fail(403, "SCOPE_DENIED", "无权访问该批次");
          assertBatchScope(batch, binding);
          if (input.reviewAssignmentId !== batch.reviewAssignments.at(-1).id) fail(409, "REVIEW_ASSIGNMENT_CHANGED", "复核分派已变化，请刷新");
          reviewSeparation(snapshot, batch, binding);
        }
        send(res, 201, store.putEvidence({ input: { ...input, contractId }, actor: businessActor(binding, binding.role === "supplier" ? "delivery" : binding.role), idempotencyKey: req.headers["idempotency-key"] }));
        return true;
      }
      if (req.method !== "POST") fail(404, "NOT_FOUND", "业务接口不存在");
      const body = await readBody(req);
      const { expectedVersion, ...input } = body || {};
      let binding, method, command, document, attestation;
      if (p === "/v1/platform/quotes") {
        shape(body, ["id", "resourceId", "unitPriceWei", "availableQuantity", "validUntil", "etaHours", "expectedVersion"]);
        binding = operator(req, ["supplier"]);
        if (!getResources().some(resource => resource.id === input.resourceId)) fail(404, "RESOURCE_NOT_FOUND", "资源目录不存在该物资或服务");
        method = "addQuote"; command = { ...input, supplierWallet: binding.wallet, supplierOrganizationId: binding.organizationId };
      } else if (p === "/v1/platform/reservations") {
        shape(body, ["id", "quoteId", "taskId", "quantity", "buyerWallet", "expectedVersion"]);
        binding = operator(req, ["dispatcher"]);
        const task = getTasks().find(item => item.id === input.taskId);
        if (!task || task.verificationStatus !== "VERIFIED" || !["DISPATCHING", "EXECUTING"].includes(task.status)) fail(409, "TASK_NOT_APPROVED", "任务尚未核验发布或已暂停/结束");
        if (!visibleTask(task, binding)) fail(403, "SCOPE_DENIED", "无权引用其他机构私有任务");
        const buyer = accounts.getByWallet(input.buyerWallet), buyerRole = buyer && registry.lookup(buyer.id);
        if (!buyerRole || buyerRole.role !== "contract_approver" || buyerRole.organizationId !== binding.organizationId || !sameWallet(buyerRole.wallet, input.buyerWallet)) fail(403, "BUYER_NOT_AUTHORIZED", "请指定本机构独立合同审批岗位的钱包");
        const quote = store.read().quotes.find(item => item.id === input.quoteId);
        if (quote && !activeSupplier(quote)) fail(403, "SUPPLIER_NOT_AUTHORIZED", "报价供方岗位或钱包绑定已失效");
        method = "reserve"; command = { ...input, buyerOrganizationId: binding.organizationId, now: Math.floor(clock() / 1000) };
      } else if (p === "/v1/platform/contracts") {
        shape(body, ["id", "reservationId", "termsText", "acceptanceText", "nonce", "expiresAt", "expectedVersion"]);
        binding = operator(req, ["contract_approver"]);
        const reservation = store.read().reservations.find(item => item.id === input.reservationId);
        if (!reservation || reservation.buyerOrganizationId !== binding.organizationId || !sameWallet(reservation.buyerWallet, binding.wallet)) fail(403, "SCOPE_DENIED", "无权为该采购预留创建合同");
        const { termsText, acceptanceText, ...contractInput } = input;
        document = { termsText, acceptanceText };
        method = "createContract"; command = { ...contractInput, termsHash: textHash(termsText),
          acceptanceCriteriaHash: textHash(acceptanceText), now: Math.floor(clock() / 1000) };
      } else if (/^\/v1\/platform\/batches\/[^/]+\/reviewer-assignment$/.test(p)) {
        if (!isAdmin(req)) fail(403, "ADMIN_REQUIRED", "仅管理员可分派独立复核人");
        shape(body, ["id", "assignmentId", "reason", "expectedVersion"]);
        if (typeof input.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.id)) fail(400, "INVALID_REVIEW_ASSIGNMENT_ID", "分派记录 ID 无效");
        const batchId = decodeURIComponent(p.split("/")[4]), snapshot = store.read();
        const batch = snapshot.batches.find(item => item.id === batchId);
        if (!batch) fail(404, "NOT_FOUND", "交付批次不存在");
        const candidate = registry.list().find(item => item.id === input.assignmentId && item.status === "active" && item.role === "reviewer");
        const user = candidate && accounts.getByWallet(candidate.wallet);
        if (!candidate || !user || user.id !== candidate.userId || !sameWallet(user.wallet, candidate.wallet)) fail(403, "REVIEWER_NOT_AUTHORIZED", "请指定有效的独立复核岗位");
        reviewSeparation(snapshot, batch, candidate);
        const previous = batch.reviewAssignments?.find(item => item.id === input.id);
        binding = { user: { id: "platform-bootstrap-admin" } };
        method = "assignReviewer";
        command = { id: input.id, batchId, assignmentId: candidate.id,
          reviewer: { id: candidate.userId, organizationId: candidate.organizationId, wallet: candidate.wallet, role: "reviewer" },
          assignedBy: binding.user.id, reason: input.reason, assignedAt: previous?.assignedAt ?? clock() };
      } else if (/^\/v1\/platform\/batches\/[^/]+\/review$/.test(p)) {
        shape(body, ["acceptedQuantity", "statement", "evidenceIds", "reviewAssignmentId", "expectedVersion"]);
        binding = operator(req, ["reviewer"]);
        const batchId = decodeURIComponent(p.split("/")[4]), snapshot = store.read();
        const batch = snapshot.batches.find(item => item.id === batchId);
        if (!batch) fail(404, "NOT_FOUND", "交付批次不存在");
        assertBatchScope(batch, binding);
        if (input.reviewAssignmentId !== batch.reviewAssignments.at(-1).id) fail(409, "REVIEW_ASSIGNMENT_CHANGED", "复核分派已变化，请刷新");
        reviewSeparation(snapshot, batch, binding);
        const records = store.getAttestations(batch.contractId).data;
        for (const stage of ["deliverBatch", "acceptBatch"]) {
          if (!records.some(item => item.batchId === batch.id && item.contractVersion === batch.contractVersion && item.method === stage && item.evidence.length)) fail(409, "REVIEW_MATERIALS_REQUIRED", "复核前须具备原交付和验收说明及附件");
        }
        attestation = statementRecord(input.statement, input.evidenceIds);
        method = "resolveDispute"; command = { batchId, acceptedQuantity: input.acceptedQuantity, reviewAssignmentId: input.reviewAssignmentId, actor: businessActor(binding) };
      } else if (p === "/v1/platform/deliveries") {
        shape(body, ["id", "contractId", "quantity", "statement", "evidenceIds", "expectedVersion"]);
        binding = operator(req, ["supplier"]);
        const contract = store.read().contracts.find(item => item.id === input.contractId);
        if (!contract) fail(404, "NOT_FOUND", "合同不存在");
        assertContractScope(contract, binding, "supplier");
        attestation = statementRecord(input.statement, input.evidenceIds);
        method = "deliverBatch"; command = { id: input.id, contractId: contract.id, quantity: input.quantity, actor: businessActor(binding, "delivery") };
      } else if (/^\/v1\/platform\/batches\/[^/]+\/(acceptance|payable)$/.test(p)) {
        const route = p.match(/^\/v1\/platform\/batches\/([^/]+)\/(acceptance|payable)$/);
        const accepting = route[2] === "acceptance";
        shape(body, accepting ? ["outcome", "acceptedQuantity", "statement", "evidenceIds", "expectedVersion"] : ["expectedVersion"]);
        binding = operator(req, [accepting ? "acceptance" : "finance"]);
        const snapshot = store.read(), batch = snapshot.batches.find(item => item.id === decodeURIComponent(route[1]));
        if (!batch) fail(404, "NOT_FOUND", "交付批次不存在");
        const contract = snapshot.contracts.find(item => item.id === batch.contractId);
        assertContractScope(contract, binding, "buyer");
        const records = store.getAttestations(contract.id).data;
        if (!records.some(item => item.batchId === batch.id && item.contractVersion === batch.contractVersion && item.method === "deliverBatch" && item.evidence?.length)) fail(409, "DELIVERY_ATTESTATION_REQUIRED", "该批次缺少完整交付说明或原始附件，不可继续办理");
        if (accepting) {
          attestation = statementRecord(input.statement, input.evidenceIds);
          method = "acceptBatch"; command = { batchId: batch.id, outcome: input.outcome, acceptedQuantity: input.acceptedQuantity, actor: businessActor(binding) };
        } else {
          financeSeparation(snapshot, contract, binding);
          if (!records.some(item => item.batchId === batch.id && item.contractVersion === batch.contractVersion && item.method === "acceptBatch" && item.evidence?.length)) fail(409, "ACCEPTANCE_ATTESTATION_REQUIRED", "该批次缺少完整验收说明或原始附件");
          if ((batch.review || batch.acceptance?.outcome === "DISPUTED" && batch.status !== "DISPUTED") && !records.some(item => item.batchId === batch.id && item.contractVersion === batch.contractVersion && item.method === "resolveDispute" && item.evidence?.length)) fail(409, "REVIEW_ATTESTATION_REQUIRED", "争议批次须有独立复核说明及原始附件");
          method = "derivePayable"; command = { batchId: batch.id };
        }
      } else {
        const sign = p.match(/^\/v1\/platform\/contracts\/([^/]+)\/signatures$/);
        if (!sign) fail(404, "NOT_FOUND", "该业务步骤尚未接入正式链上核验");
        shape(body, ["version", "signature", "expectedVersion"]);
        binding = operator(req, ["contract_approver", "supplier"]);
        const contract = store.read().contracts.find(item => item.id === decodeURIComponent(sign[1]));
        if (!contract) fail(404, "NOT_FOUND", "合同不存在");
        const party = signerParty(contract, binding);
        method = "signContract"; command = { ...input, contractId: contract.id, party, now: Math.floor(clock() / 1000) };
      }
      send(res, 201, commit(req, method, command, binding, expectedVersion, document, attestation));
    } catch (error) {
      const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : "PLATFORM_SERVICE_ERROR";
      const known = !code.startsWith("ERR_") && code !== "PLATFORM_SERVICE_ERROR";
      const status = error.status || (code === "CONTRACT_DOCUMENT_MISSING" ? 404 : code === "CHAIN_CONFIGURATION_REQUIRED" ? 503 : known ? 409 : 503);
      if (!res.headersSent) send(res, status, { data: null, error: { code, message: error.status ? error.message : known ? code : "业务服务暂不可用，请稍后重试" } });
    }
    return true;
  }
  return { handle, close() { store.close(); registry.close(); } };
}

module.exports = { createPlatformService };
