(function () {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const roles = { supplier: "供方", dispatcher: "调度", contract_approver: "合同审批", acceptance: "验收", finance: "财务", reviewer: "独立复核", reporter: "灾情上报", official_verifier: "灾情核验", auditor: "审计" };
  const statuses = { DRAFT: "待双方签署", PARTIALLY_SIGNED: "待另一方签署", FUNDS_RESERVABLE: "双签完成，待链上锁款", FUNDS_RESERVED: "已锁款", RESERVED: "库存已预留", BOUND: "已建合同", RELEASED: "已释放" };
  Object.assign(statuses, { IN_FULFILLMENT: "履约中", DELIVERED: "待验收", ACCEPTED: "通过", PARTIAL: "部分通过", REJECTED: "拒收", DISPUTED: "争议", PAYABLE: "已创建应付", PAYMENT_PENDING: "付款待链上确认", PAID: "链上付款已确认", CONFIRMED: "已确认" });
  const providers = new Map(), pending = new Map();
  const adminMode = new URLSearchParams(location.search).get("mode") === "admin";
  let state = null, context = null, binding = null, user = null, selected = null, documentData = null;
  let epoch = 0, detailEpoch = 0, busy = false, loading = false, documentKey = "";
  let batchId = null, batchEpoch = 0, attestationKey = "", attestationRecords = null, attestationVersion = null;
  const batchDrafts = new Map();
  const reviewDrafts = new Map();
  let currentReviewKey = "";
  const fileSelections = new Map(), uploadDrafts = new Map(), privateTransfers = new Set();
  const maxFileBytes = 5 * 1024 * 1024;
  function icons() { if (window.lucide) window.lucide.createIcons(); }
  function amount(wei) { try { return window.ethers.formatEther(String(wei)); } catch (_) { return "--"; } }
  function date(seconds) { const value = new Date(Number(seconds) * 1000); return Number.isNaN(value.getTime()) ? "--" : value.toLocaleString("zh-CN", { hour12: false }); }
  function text(selector, value) { $(selector).textContent = value; }
  function terms(contract) { return contract.versions[contract.currentVersion - 1]; }
  function resource(id) { return context?.resources.find(item => item.id === id) || { name: id, unit: "" }; }
  function notice(message, error = false) { text("#notice", message); $("#notice").dataset.error = String(error); }
  function friendly(error) {
    const messages = { VERSION_CONFLICT: "数据已变化，请刷新并重新确认后提交", EXPIRED: "报价或签名期限已过期", EXPIRY_EXCEEDS_QUOTE: "签署截止时间不能晚于报价有效期", INSUFFICIENT_AVAILABILITY: "剩余库存不足", BUYER_IS_SUPPLIER: "采购与供方必须为独立机构和钱包", CHAIN_CONFIGURATION_REQUIRED: "尚未配置正式签名域", OPERATOR_REQUIRED: "岗位已失效，请重新验证账户", CONTRACT_DOCUMENT_REQUIRED: "缺少可核验合同正文", CONTRACT_DOCUMENT_MISSING: "合同正文尚未登记" };
    return messages[error.code] || (error.code === 4001 || error.code === "ACTION_REJECTED" ? "已取消钱包签名" : error.message || "请求失败，请重试");
  }
  async function api(path, body, key, administrative = adminMode, signal) {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      headers: { ...(administrative ? { "X-Relief-Actor": "admin" } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || "业务请求失败"), { code: result.error?.code, status: response.status });
    return result;
  }
  function clearPrivate(message) {
    epoch++; detailEpoch++; state = context = binding = user = selected = documentData = null; documentKey = ""; pending.clear();
    batchEpoch++; batchId = null; attestationKey = ""; attestationRecords = null; attestationVersion = null; batchDrafts.clear();
    reviewDrafts.clear(); currentReviewKey = "";
    for (const controller of privateTransfers) controller.abort();
    privateTransfers.clear(); fileSelections.clear(); uploadDrafts.clear();
    $("#workspace").hidden = true; $("#gate").hidden = false; text("#gateText", message); text("#identity", adminMode ? "管理员审阅" : "未验证岗位");
    for (const id of ["quoteList", "reservationRows", "contractRows", "contractDetail", "batchRows", "batchDetail", "batchAttestations", "batchCount", "deliveryAvailability", "payableAmount", "batchActionStatus", "deliveryFileList", "acceptanceFileList", "evidenceDownloadStatus"]) text("#" + id, "");
    for (const id of ["reviewAssignmentHistory", "reviewAssignmentAvailability", "reviewAssignmentCurrent", "reviewFileList"]) text("#" + id, "");
    for (const form of document.forms) { form.reset(); const result = form.querySelector(".form-result"); if (result) result.textContent = ""; }
    for (const select of document.querySelectorAll('.command-form select:not(#walletProvider):not([name="outcome"])')) { select.replaceChildren(); delete select.dataset.options; }
    for (const id of ["deliveryForm", "acceptanceForm", "payableForm", "reviewAssignmentForm", "reviewForm"]) { $("#" + id).hidden = true; delete $("#" + id).dataset.batchId; delete $("#" + id).dataset.reviewAssignmentId; }
    $('#acceptanceForm [name="acceptedQuantity"]').removeAttribute("max");
    $('#reviewForm [name="acceptedQuantity"]').removeAttribute("max");
    text("#signingStatus", "");
  }
  function options(select, items, label, value = item => item.id) {
    const saved = select.value, signature = JSON.stringify(items.map(item => [value(item), label(item)]));
    if (select.dataset.options === signature) return;
    select.dataset.options = signature;
    select.innerHTML = '<option value="">请选择</option>' + items.map(item => `<option value="${escape(value(item))}">${escape(label(item))}</option>`).join("");
    if (items.some(item => value(item) === saved)) select.value = saved;
  }
  function liveQuotes() { return state.quotes.filter(q => q.purchasable === true && q.validUntil > Date.now() / 1000 && q.availableQuantity > 0); }
  function render() {
    if (!state) return;
    $("#gate").hidden = true; $("#workspace").hidden = false;
    text("#identity", adminMode ? "管理员 · 分派与审阅" : `${user.name} · ${roles[binding.role] || binding.role} · ${binding.organizationId}`);
    text("#fulfillmentTitle", binding?.role === "reviewer" ? "分派给我的复核批次" : "履约批次");
    text("#fulfillmentTab", binding?.role === "reviewer" ? "复核案件" : "履约批次");
    const quotes = liveQuotes();
    text("#quoteCount", quotes.length); text("#reservationCount", state.reservations.length); text("#contractCount", state.contracts.length); text("#version", state.version);
    $("#quoteForm").hidden = binding?.role !== "supplier" || adminMode;
    $("#reservationForm").hidden = binding?.role !== "dispatcher" || adminMode;
    $("#contractForm").hidden = binding?.role !== "contract_approver" || adminMode;
    if (!busy) $('#contractForm button[type="submit"]').disabled = !state.configuration.signingReady;
    options($("#quoteForm select"), context.resources, item => item.name + " / " + item.unit);
    options($('#reservationForm [name="quoteId"]'), quotes, item => `${resource(item.resourceId).name} · ${amount(item.unitPriceWei)} MON · ${item.supplierOrganizationId}`);
    options($('#reservationForm [name="taskId"]'), context.tasks, item => item.title + " · " + item.id);
    options($('#reservationForm [name="buyerWallet"]'), context.approvers, item => `${item.name || item.userId} · ${item.wallet}`, item => item.wallet);
    const reservations = state.reservations.filter(r => same(r.buyerWallet, binding?.wallet) && !state.contracts.some(c => c.versions.some(v => v.reservationId === r.id)));
    options($('#contractForm [name="reservationId"]'), reservations, item => `${item.id} · ${item.quantity} ${resource(state.quotes.find(q => q.id === item.quoteId)?.resourceId).unit}`);
    $("#quoteList").innerHTML = quotes.length ? quotes.map(q => {
      const item = resource(q.resourceId), image = /^\/shared\/assets\/[\w.-]+$/.test(item.image || "") ? item.image : null;
      return `<article class="quote-item">${image ? `<img src="${escape(image)}" alt="${escape(item.name)}" loading="lazy">` : '<div class="empty">暂无图片</div>'}<div><h2>${escape(item.name)}</h2><div class="price">${escape(amount(q.unitPriceWei))} MON <small>/ ${escape(item.unit)}</small></div><div class="quote-meta">可供 ${escape(q.availableQuantity)} ${escape(item.unit)} · ${escape(q.etaHours)} 小时<br>供方：${escape(q.supplierOrganizationId)}<br>有效至 ${escape(date(q.validUntil))}<br>${escape(q.id)}</div>${binding?.role === "dispatcher" ? `<a href="#reservations" data-reserve="${escape(q.id)}">采购预留</a>` : ""}</div></article>`;
    }).join("") : '<p class="empty">暂无有效供方报价</p>';
    $("#reservationRows").innerHTML = state.reservations.length ? state.reservations.map(r => `<tr><td>${escape(r.id)}<small>${escape(r.taskId)}</small></td><td>${escape(resource(state.quotes.find(q => q.id === r.quoteId)?.resourceId).name)}</td><td>${escape(r.quantity)}</td><td>${escape(r.buyerWallet)}</td><td>${escape(statuses[r.status] || r.status)}</td></tr>`).join("") : '<tr><td colspan="5" class="empty">暂无采购预留</td></tr>';
    $("#contractRows").innerHTML = state.contracts.length ? state.contracts.map(c => { const v = terms(c); return `<tr><td>${escape(c.id)}<small>${escape(v.taskId)} · v${escape(c.currentVersion)}</small></td><td>${escape(resource(v.resourceId).name)} × ${escape(v.quantity)}</td><td>${escape(amount(BigInt(v.unitPriceWei) * BigInt(v.quantity)))}</td><td>${c.signatures?.buyer ? "采购已签" : "采购待签"}<br>${c.signatures?.supplier ? "供方已签" : "供方待签"}</td><td>${escape(statuses[c.status] || c.status)}</td><td><a href="#contract/${encodeURIComponent(c.id)}">详情</a></td></tr>`; }).join("") : '<tr><td colspan="6" class="empty">暂无合同</td></tr>';
    renderFulfillment(); route(); icons();
  }
  async function refresh() {
    if (loading) return;
    loading = true; const ticket = epoch;
    try {
      let nextUser = null, nextBinding = null;
      if (!adminMode) {
        nextUser = (await api("/v1/wallet/me")).data.user;
        if (!nextUser) throw Object.assign(new Error("请先登录注册账户"), { status: 401 });
        nextBinding = (await api("/v1/platform/operators/me")).data;
        if (!nextBinding) throw Object.assign(new Error("请在账户页领取有效岗位并绑定钱包"), { status: 403 });
      }
      const nextContext = (await api("/v1/platform/context")).data;
      let nextState = (await api("/v1/platform/procurement")).data;
      if (ticket !== epoch) return;
      if (user && nextUser?.id !== user.id) { clearPrivate("账户已变更，请刷新验证"); return; }
      if (binding && (binding.id !== nextBinding?.id || !same(binding.wallet, nextBinding?.wallet) || binding.role !== nextBinding?.role || binding.organizationId !== nextBinding?.organizationId)) { clearPrivate("岗位或机构已变更，请刷新验证"); return; }
      if (nextBinding?.role === "reviewer") {
        nextState = reviewerSnapshot(nextState, nextBinding, nextUser);
        if (state && batches().some(old => !nextState.batches.some(item => reviewKey(item) === reviewKey(old)))) { clearPrivate("复核分派已变更，请刷新重新验证案件权限"); return; }
      }
      if (state) for (const old of batches()) {
        if (!nextState.batches.some(item => reviewKey(item) === reviewKey(old))) discardReview(reviewKey(old));
      }
      user = nextUser; binding = nextBinding; context = nextContext; state = nextState;
      notice(`已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · ${state.configuration.signingReady ? "合同签名域已配置" : "未配置签名域，暂不可签约"}`);
      render();
    } catch (error) {
      if (ticket !== epoch) return;
      if (error.status === 401 || error.status === 403) clearPrivate(friendly(error));
      notice(friendly(error), true);
    } finally { loading = false; }
  }
  function route() {
    if (!state) return;
    let path; try { path = decodeURIComponent(location.hash.slice(1)); } catch (_) { path = "missing"; }
    const detail = path.startsWith("contract/"), batchDetail = path.startsWith("batch/");
    const view = batchDetail ? "batch" : detail ? "contract" : ["quotes", "reservations", "contracts", "fulfillment"].includes(path) ? path : binding?.role === "reviewer" ? "fulfillment" : "quotes";
    for (const node of document.querySelectorAll(".view")) node.hidden = node.id !== "view-" + view;
    for (const link of document.querySelectorAll(".tabs a")) { if (link.hash === "#" + (batchDetail ? "fulfillment" : detail ? "contracts" : view)) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); }
    showBatch(batchDetail ? path.slice("batch/".length) : null);
    if (detail) {
      const contract = state.contracts.find(c => c.id === path.slice("contract/".length));
      if (!contract) { detailEpoch++; selected = documentData = null; documentKey = ""; text("#contractDetail", "合同不存在或当前账户无权查看"); $("#signatureForm").hidden = true; return; }
      const key = `${contract.id}:${contract.currentVersion}:${contract.status}`;
      selected = contract;
      if (documentKey !== key) { documentKey = key; void loadDocument(contract); }
    } else { detailEpoch++; selected = documentData = null; documentKey = ""; $("#signatureForm").hidden = true; }
  }
  function batches() { return state?.batches || []; }
  function batchContract(batch) { return state?.contracts.find(item => item.id === batch?.contractId); }
  function batchTerms(batch) { return batchContract(batch)?.versions.find(item => item.version === batch.contractVersion); }
  function samePerson(actor) { return !!actor && (actor.id === user?.id || same(actor.wallet, binding?.wallet)); }
  function actorText(actor) { return actor ? `${actor.id || "--"} · ${actor.organizationId || "--"} · ${roles[actor.role] || (actor.role === "delivery" ? "交付" : actor.role) || "--"} · ${actor.wallet || "--"}` : "未登记"; }
  function status(value) { return statuses[value] || value || "未登记"; }
  function payableFor(batch) { return state.payables?.find(item => item.batchId === batch.id); }
  function paymentFor(batch) { return state.payments?.find(item => item.batchId === batch.id); }
  function remaining(contract) { return BigInt(terms(contract).quantity) - batches().filter(item => item.contractId === contract.id).reduce((sum, item) => sum + BigInt(item.deliveredQuantity), 0n); }
  function canDeliver(contract) {
    return !!contract && !adminMode && binding?.role === "supplier" && terms(contract).supplierOrganizationId === binding.organizationId && ["FUNDS_RESERVED", "IN_FULFILLMENT"].includes(contract.status) && remaining(contract) > 0n;
  }
  function buyerIndependent(batch, role) {
    const v = batchTerms(batch), current = batchContract(batch) && terms(batchContract(batch));
    return !!v && !!current && !adminMode && binding?.role === role && binding.organizationId === v.buyerOrganizationId && binding.organizationId === current.buyerOrganizationId &&
      binding.organizationId !== current.supplierOrganizationId && !same(binding.wallet, current.buyerWallet) && !same(binding.wallet, current.supplierWallet) &&
      binding.organizationId !== v.supplierOrganizationId && !same(binding.wallet, v.buyerWallet) && !same(binding.wallet, v.supplierWallet);
  }
  function canAccept(batch) {
    return batch?.status === "DELIVERED" && hasStatement(batch, "deliverBatch") && buyerIndependent(batch, "acceptance") && !samePerson(batch.deliveryActor) &&
      !(state.payments || []).some(item => item.contractId === batch.contractId && samePerson(item.financeActor));
  }
  function lastAssignment(batch) { return batch?.reviewAssignments?.at(-1); }
  function assignmentRetryState(batch, operation) {
    if (!operation) return "none";
    const current = lastAssignment(batch);
    if (current?.id === operation.body.id) return current.assignmentId === operation.body.assignmentId && current.reason === operation.body.reason ? "committed" : "conflict";
    return (current?.id || "") === operation.baseAssignmentId ? "pending" : "conflict";
  }
  function sameAssignmentValues(operation, values) {
    return !!operation && operation.body.assignmentId === values.assignmentId && operation.body.reason === values.reason;
  }
  function reviewKey(batch) { return batch ? "review:" + JSON.stringify([batch.id, lastAssignment(batch)?.id || ""]) : ""; }
  function assignedTo(batch, account = binding, person = user) {
    const assignment = lastAssignment(batch);
    return account?.role === "reviewer" && !!assignment && assignment.assignmentId === account.id && assignment.reviewer?.id === person?.id &&
      same(assignment.reviewer.wallet, account.wallet) && assignment.reviewer.organizationId === account.organizationId;
  }
  function reviewerSnapshot(snapshot, account, person) {
    const visible = snapshot.batches.filter(item => assignedTo(item, account, person)), ids = new Set(visible.map(item => item.id)), contracts = new Set(visible.map(item => item.contractId));
    return { ...snapshot, batches: visible, contracts: snapshot.contracts.filter(item => contracts.has(item.id)), reservations: [],
      payables: (snapshot.payables || []).filter(item => ids.has(item.batchId)), payments: (snapshot.payments || []).filter(item => ids.has(item.batchId)),
      escrows: (snapshot.escrows || []).filter(item => contracts.has(item.contractId)) };
  }
  function independentReviewer(batch, candidate) {
    const contract = batchContract(batch), original = batchTerms(batch);
    if (!candidate || !contract || !original) return false;
    const participants = batches().filter(item => item.contractId === batch.contractId).flatMap(item => [item.deliveryActor, item.acceptance?.actor]);
    participants.push(...(state.payments || []).filter(item => item.contractId === batch.contractId).map(item => item.financeActor));
    return [original, terms(contract)].every(v => ![v.buyerOrganizationId, v.supplierOrganizationId].includes(candidate.organizationId) && ![v.buyerWallet, v.supplierWallet].some(wallet => same(wallet, candidate.wallet))) &&
      !participants.some(actor => actor && (actor.id === candidate.userId || same(actor.wallet, candidate.wallet) || actor.organizationId === candidate.organizationId));
  }
  function canReview(batch) {
    return !adminMode && batch?.status === "DISPUTED" && assignedTo(batch) && independentReviewer(batch, { userId: user.id, wallet: binding.wallet, organizationId: binding.organizationId }) &&
      hasStatement(batch, "deliverBatch") && hasStatement(batch, "acceptBatch");
  }
  function discardReview(key) {
    reviewDrafts.delete(key); fileSelections.delete(key); uploadDrafts.delete(key); pending.delete(key);
    for (const controller of privateTransfers) controller.abort();
  }
  function saveReviewDraft() {
    if (!currentReviewKey) return;
    reviewDrafts.set(currentReviewKey, Object.fromEntries([...$('#reviewForm').querySelectorAll('input:not([type="file"]),textarea')].map(node => [node.name, node.value])));
  }
  function renderAssignment(batch) {
    const assignments = batch.reviewAssignments || [], current = lastAssignment(batch);
    $("#reviewAssignmentHistory").innerHTML = assignments.length ? '<h2>复核分派历史</h2><ol class="assignment-history">' + assignments.map((item, index) => `<li data-testid="review-assignment" data-review-assignment-id="${escape(item.id)}"><strong>${index === assignments.length - 1 ? "当前分派" : "历史分派"}</strong><p>${escape(actorText(item.reviewer))}</p><p class="document-text">${escape(item.reason)}</p><small>分派人 ${escape(item.assignedBy)} · ${escape(new Date(item.assignedAt).toLocaleString("zh-CN", { hour12: false }))}</small><p class="hash-value">${escape(item.id)} · 岗位 ${escape(item.assignmentId)}</p></li>`).join("") + '</ol>' : batch.status === "DISPUTED" ? '<p class="notice">尚未分派独立复核人</p>' : "";
    const candidates = adminMode ? (context.reviewers || []).filter(item => independentReviewer(batch, item)) : [];
    $("#reviewAssignmentForm").hidden = !adminMode || batch.status !== "DISPUTED";
    options($('#reviewAssignmentForm [name="assignmentId"]'), candidates, item => `${item.name || item.userId} · ${item.organizationId} · ${item.wallet}`, item => item.assignmentId);
    $('#reviewAssignmentForm button[type="submit"]').disabled = busy || !candidates.length;
    text("#reviewAssignmentAvailability", adminMode && batch.status === "DISPUTED" && !candidates.length ? "暂无符合独立性要求的有效复核岗位" : "");
    $("#reviewForm").hidden = !canReview(batch);
    $("#reviewForm").dataset.reviewAssignmentId = current?.id || "";
    $('#reviewForm [name="acceptedQuantity"]').max = String(batch.deliveredQuantity);
    $('#reviewForm button[type="submit"]').disabled = busy;
    text("#reviewAssignmentCurrent", current ? `分派记录 ${current.id} · 可复核数量 0 至 ${batch.deliveredQuantity}` : "");
  }
  function canCreatePayable(batch) {
    const contract = batchContract(batch);
    return !!batch && hasStatement(batch, "deliverBatch") && hasStatement(batch, "acceptBatch") && (!batch.review || hasStatement(batch, "resolveDispute")) && buyerIndependent(batch, "finance") && ["ACCEPTED", "PARTIAL"].includes(batch.status) && batch.acceptedQuantity > 0 && !payableFor(batch) &&
      contract.currentVersion === batch.contractVersion && ["FUNDS_RESERVED", "IN_FULFILLMENT"].includes(contract.status) &&
      !batches().some(item => item.contractId === batch.contractId && [item.deliveryActor, item.acceptance?.actor, item.review?.actor].some(samePerson));
  }
  function hasStatement(batch, method) {
    return batchId === batch.id && attestationVersion === state?.version && !!attestationRecords?.some(item => item.batchId === batch.id && item.contractId === batch.contractId && item.contractVersion === batch.contractVersion && item.method === method && Array.isArray(item.evidence) && item.evidence.length > 0 &&
      (method !== "resolveDispute" || !!batch.review && item.evidence.every(metadata => metadata.reviewAssignmentId === batch.review.reviewAssignmentId && metadata.reviewAssignmentId === lastAssignment(batch)?.id)));
  }
  function renderFulfillment() {
    const contracts = state.contracts.filter(canDeliver);
    $("#deliveryForm").hidden = adminMode || binding?.role !== "supplier";
    options($('#deliveryForm [name="contractId"]'), contracts, c => `${c.id} · v${c.currentVersion} · 剩余 ${remaining(c)} · ${resource(terms(c).resourceId).name}`);
    $('#deliveryForm button[type="submit"]').disabled = busy || !contracts.length;
    text("#deliveryAvailability", !adminMode && binding?.role === "supplier" && !contracts.length ? "暂无本机构已锁款且有剩余交付数量的合同" : "");
    text("#batchCount", `${batches().length} 个批次`);
    $("#batchRows").innerHTML = batches().length ? batches().map(batch => {
      const payable = payableFor(batch), payment = paymentFor(batch);
      return `<tr data-batch-id="${escape(batch.id)}"><td data-label="批次 / 合同版本">${escape(batch.id)}<small>${escape(batch.contractId)} · v${escape(batch.contractVersion)}</small></td><td data-label="交付数量">${escape(batch.deliveredQuantity)}</td><td data-label="验收">${escape(status(batch.status))}<small>验收数量 ${escape(batch.acceptedQuantity)}</small></td><td data-label="应付">${payable ? `${escape(status(payable.status))}<small>${escape(amount(payable.amountWei))} MON</small>` : "未创建"}</td><td data-label="链上付款">${payment ? escape(status(payment.status)) : "无付款记录"}</td><td><a data-testid="batch-link" href="#batch/${encodeURIComponent(batch.id)}">批次详情</a></td></tr>`;
    }).join("") : '<tr><td colspan="6" class="empty">暂无履约批次</td></tr>';
  }
  function saveBatchDraft() {
    if (!batchId) return;
    const form = $("#acceptanceForm");
    batchDrafts.set(batchId, Object.fromEntries([...form.querySelectorAll('input:not([type="file"]),select,textarea')].map(node => [node.name, node.value])));
  }
  function acceptanceQuantity() {
    const batch = batches().find(item => item.id === batchId);
    if (!batch) return;
    const outcome = $('#acceptanceForm [name="outcome"]').value, input = $('#acceptanceForm [name="acceptedQuantity"]');
    input.readOnly = outcome !== "PARTIAL";
    input.min = outcome === "PARTIAL" ? "1" : "0";
    input.max = String(outcome === "PARTIAL" ? batch.deliveredQuantity - 1 : batch.deliveredQuantity);
    if (outcome !== "PARTIAL") input.value = outcome === "ACCEPTED" ? batch.deliveredQuantity : 0;
  }
  function showBatch(id) {
    const targetBatch = batches().find(item => item.id === id), nextReviewKey = reviewKey(targetBatch), changedBatch = batchId !== id;
    const assignmentOperation = pending.get("assignment:" + id), assignmentRetry = assignmentRetryState(targetBatch, assignmentOperation);
    if (assignmentRetry === "conflict") pending.delete("assignment:" + id);
    if (batchId !== id || currentReviewKey !== nextReviewKey) {
      if (batchId !== id) saveReviewDraft();
      else discardReview(currentReviewKey);
      saveBatchDraft(); batchId = id; batchEpoch++; attestationKey = ""; attestationRecords = null; attestationVersion = null;
      currentReviewKey = nextReviewKey;
      for (const form of [$("#acceptanceForm"), $("#payableForm"), $("#reviewForm"), $("#reviewAssignmentForm")]) {
        if (form.id === "reviewAssignmentForm" && !changedBatch && assignmentRetry === "committed" && sameAssignmentValues(assignmentOperation,
          { assignmentId: form.elements.assignmentId.value, reason: form.elements.reason.value })) continue;
        form.reset(); form.dataset.batchId = id || "";
        const result = form.querySelector(".form-result");
        if (changedBatch || form.id !== "reviewAssignmentForm" || result.dataset.success !== "true") { result.textContent = ""; result.dataset.success = "false"; }
      }
      const draft = batchDrafts.get(id);
      if (draft) for (const node of $('#acceptanceForm').querySelectorAll('input:not([type="file"]),select,textarea')) node.value = draft[node.name] ?? "";
      restoreFiles("acceptance:" + id, $("#acceptanceFiles"));
      renderFiles("acceptance:" + id, "#acceptanceFileList");
      const reviewDraft = reviewDrafts.get(currentReviewKey);
      if (reviewDraft) for (const node of $('#reviewForm').querySelectorAll('input:not([type="file"]),textarea')) node.value = reviewDraft[node.name] ?? "";
      restoreFiles(currentReviewKey, $("#reviewFiles")); renderFiles(currentReviewKey, "#reviewFileList");
      text("#reviewAssignmentHistory", ""); text("#reviewAssignmentCurrent", ""); text("#reviewAssignmentAvailability", "");
      text("#batchAttestations", "");
      text("#evidenceDownloadStatus", "");
    }
    if (assignmentRetry === "conflict") {
      const form = $("#reviewAssignmentForm"); form.reset();
      const result = form.querySelector(".form-result"); result.dataset.success = "false";
      result.textContent = "当前分派已由其他操作变更，旧重试已取消；请核对历史后重新选择复核人并填写原因";
    }
    $("#acceptanceForm").hidden = true; $("#payableForm").hidden = true;
    $("#reviewForm").hidden = true; $("#reviewAssignmentForm").hidden = true;
    if (id === null) return;
    const batch = batches().find(item => item.id === id), v = batch && batchTerms(batch);
    if (!batch || !v) {
      batchEpoch++; attestationKey = ""; attestationRecords = null; attestationVersion = null;
      for (const key of ["batchAttestations", "batchActionStatus", "payableAmount"]) text("#" + key, "");
      text("#batchDetail", "批次或原合同版本不存在，或当前账户无权查看"); return;
    }
    const payable = payableFor(batch), payment = paymentFor(batch);
    const escrow = state.escrows?.find(item => item.contractId === batch.contractId && item.contractVersion === batch.contractVersion);
    const fields = [
      ["原合同版本", `${batch.contractId} · v${batch.contractVersion}`, "batch-contract-version"],
      ["采购内容 / 单价", `${resource(v.resourceId).name} · ${amount(v.unitPriceWei)} MON (${v.unitPriceWei} wei)`, "batch-price"],
      ["采购 / 供方机构", `${v.buyerOrganizationId} / ${v.supplierOrganizationId}`, "batch-organizations"],
      ["链上锁款", escrow ? `${status(escrow.status)} · ${amount(escrow.value)} MON · ${escrow.txHash || "无交易哈希"}` : "无锁款确认记录", "batch-escrow"],
      ["交付", `已登记 ${batch.deliveredQuantity} · ${actorText(batch.deliveryActor)}`, "batch-delivery"],
      ["验收", batch.acceptance ? `${status(batch.acceptance.outcome)} · 数量 ${batch.acceptance.acceptedQuantity} · ${actorText(batch.acceptance.actor)}` : "未验收", "batch-acceptance"],
      ["应付", payable ? `${status(payable.status)} · ${amount(payable.amountWei)} MON (${payable.amountWei} wei) · ${payable.id}` : "未创建应付", "batch-payable"],
      ["链上付款", payment ? `${status(payment.status)} · ${amount(payment.value)} MON (${payment.value} wei) · ${payment.txHash || "无交易哈希"}` : "无付款记录，未确认付款", "batch-payment"]
    ];
    if (batch.review) fields.push(["独立复核记录", `${status(batch.review.outcome)} · 数量 ${batch.review.acceptedQuantity} · ${actorText(batch.review.actor)}`, "batch-review"]);
    $("#batchDetail").innerHTML = `<div class="contract-title"><h1>${escape(batch.id)}</h1><span class="tag pending">${escape(status(batch.status))}</span></div><a href="#contract/${encodeURIComponent(batch.contractId)}">合同台账（当前版本）</a><dl class="terms-grid">${fields.map(([label, value, testId]) => `<div><dt>${escape(label)}</dt><dd data-testid="${testId}">${escape(value)}</dd></div>`).join("")}</dl>`;
    $("#acceptanceForm").hidden = !canAccept(batch);
    $("#payableForm").hidden = !canCreatePayable(batch);
    acceptanceQuantity();
    text("#payableAmount", canCreatePayable(batch) ? `${batch.acceptedQuantity} × ${amount(v.unitPriceWei)} MON = ${amount(BigInt(v.unitPriceWei) * BigInt(batch.acceptedQuantity))} MON (${BigInt(v.unitPriceWei) * BigInt(batch.acceptedQuantity)} wei)` : "");
    renderAssignment(batch);
    text("#batchActionStatus", batch.status === "DISPUTED" ? "等待独立复核" : adminMode ? "管理员可审阅记录；仅争议批次可分派，不代为复核或付款" : canAccept(batch) || canCreatePayable(batch) ? "" : "当前岗位或批次状态无可办理操作");
    for (const form of [$("#acceptanceForm"), $("#payableForm")]) form.querySelector('button[type="submit"]').disabled = busy;
    const key = JSON.stringify([batch.id, batch.contractVersion, state.version, lastAssignment(batch)?.id]);
    if (attestationKey !== key) { attestationKey = key; void loadAttestations(batch, key); }
    icons();
  }
  async function loadAttestations(batch, key) {
    const ticket = batchEpoch, accountTicket = epoch;
    attestationRecords = null; attestationVersion = null;
    $("#acceptanceForm").hidden = true; $("#payableForm").hidden = true;
    $("#reviewForm").hidden = true;
    text("#batchAttestations", "正在读取批次说明");
    try {
      const result = await api(`/v1/platform/contracts/${encodeURIComponent(batch.contractId)}/attestations`);
      if (accountTicket !== epoch || ticket !== batchEpoch || batchId !== batch.id || key !== attestationKey) return;
      if (!Array.isArray(result.data)) throw new Error("批次说明响应格式无效");
      if (result.version !== state.version) throw new Error("说明与业务快照版本不一致，请刷新后重试");
      const records = result.data.filter(item => item.contractId === batch.contractId && item.batchId === batch.id && item.contractVersion === batch.contractVersion);
      for (const item of records) {
        if (typeof item.statement !== "string" || !same(window.ethers.keccak256(window.ethers.toUtf8Bytes(item.statement)), item.statementHash)) throw new Error("批次说明摘要不一致，暂不可办理");
        if (item.evidence != null && !Array.isArray(item.evidence)) throw new Error("附件记录格式无效");
        for (const metadata of item.evidence || []) validateEvidence(metadata, item.method === "resolveDispute" ? { ...item, reviewAssignmentId: batch.review?.reviewAssignmentId } : item);
      }
      attestationRecords = records; attestationVersion = result.version;
      $("#batchAttestations").innerHTML = '<h2>批次说明记录</h2><p class="notice">以下为岗位提交的文字说明及摘要，不代表实物证据已核验。</p>' + (records.length ? records.map(item => {
        const stamp = new Date(item.createdAt);
        return `<article class="attestation" data-testid="batch-attestation"><h3>${escape(({ deliverBatch: "交付说明", acceptBatch: "验收说明", resolveDispute: "独立复核说明" })[item.method] || item.method)}</h3><div class="document-text">${escape(item.statement)}</div><p data-testid="attestation-actor">${escape(actorText(item.actor))}</p><p class="hash-value" data-testid="attestation-hash">${escape(item.statementHash)}</p><small>v${escape(item.contractVersion)} · 命令序号 ${escape(item.commandSequence)} · ${escape(Number.isNaN(stamp.getTime()) ? item.createdAt : stamp.toLocaleString("zh-CN", { hour12: false }))}</small>${evidenceList(item.evidence || [])}</article>`;
      }).join("") : '<p class="empty">暂无该批次原合同版本的说明记录</p>');
      showBatch(batch.id);
    } catch (error) {
      if (accountTicket !== epoch) return;
      if (error.status === 401 || error.status === 403) { clearPrivate(friendly(error)); return; }
      if (ticket !== batchEpoch || key !== attestationKey) return;
      attestationKey = ""; attestationRecords = null; attestationVersion = null;
      $("#acceptanceForm").hidden = true; $("#payableForm").hidden = true;
      $("#reviewForm").hidden = true;
      text("#batchAttestations", "说明暂不可用：" + friendly(error));
    }
  }
  function hash256(value) { return typeof value === "string" && /^(?:0x)?[a-f0-9]{64}$/i.test(value) ? value.replace(/^0x/i, "").toLowerCase() : null; }
  async function sha256(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function validateEvidence(metadata, record) {
    if (!metadata || typeof metadata.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(metadata.id) ||
        metadata.contractId !== record.contractId || metadata.contractVersion !== record.contractVersion || metadata.batchId !== record.batchId || metadata.method !== record.method ||
        record.method === "resolveDispute" && (!record.reviewAssignmentId || metadata.reviewAssignmentId !== record.reviewAssignmentId) ||
        typeof metadata.filename !== "string" || !metadata.filename || !["image/png", "image/jpeg", "application/pdf"].includes(metadata.mimeType) ||
        !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1 || metadata.sizeBytes > maxFileBytes || !hash256(metadata.sha256)) throw new Error("附件元数据与批次或合同版本不一致");
  }
  function evidenceList(items) {
    if (!items.length) return '<p class="notice">此历史说明无原始附件，不可据此继续验收或创建应付。</p>';
    return '<ul class="evidence-list">' + items.map(item => `<li data-testid="evidence-item" data-evidence-id="${escape(item.id)}"><div><strong data-testid="evidence-filename">${escape(item.filename)}</strong><small>${escape(item.sizeBytes)} bytes · ${escape(item.mimeType)}</small><p class="hash-value" data-testid="evidence-sha256">SHA256 ${escape(item.sha256)}</p><small>${escape(actorText(item.actor))}</small></div><button type="button" data-testid="evidence-download" data-evidence-id="${escape(item.id)}" data-download-evidence="${escape(item.id)}" title="下载私有原始附件"><i data-lucide="download"></i>私有下载</button></li>`).join("") + '</ul>';
  }
  function restoreFiles(kind, input) {
    const transfer = new DataTransfer();
    for (const file of fileSelections.get(kind)?.files || []) transfer.items.add(file);
    input.files = transfer.files;
  }
  function renderFiles(kind, selector) {
    const selection = fileSelections.get(kind), draft = uploadDrafts.get(kind);
    $(selector).innerHTML = (selection?.files || []).map((file, index) => {
      const done = draft?.selection === selection && !!draft.files[index]?.metadata;
      return `<li data-testid="selected-evidence" data-upload-state="${done ? "uploaded" : "selected"}"><div><strong>${escape(file.name)}</strong><small>${file.size} bytes · ${done ? "上传已确认" : "待上传"}</small></div></li>`;
    }).join("");
  }
  function chooseFiles(kind, input, selector) {
    fileSelections.set(kind, { token: crypto.randomUUID(), files: [...input.files] });
    uploadDrafts.delete(kind); pending.delete(kind);
    renderFiles(kind, selector);
  }
  function evidenceScope(kind, input, contractId, contractVersion, current) {
    let selection = fileSelections.get(kind);
    if (!selection) { selection = { token: crypto.randomUUID(), files: [...input.files] }; fileSelections.set(kind, selection); }
    return { contractId, contractVersion, selection, fingerprint: JSON.stringify([contractId, contractVersion, selection.token]),
      current: () => current() && fileSelections.get(kind) === selection };
  }
  function resetEvidence(kind, scope) {
    if (!scope?.selection || fileSelections.get(kind) !== scope.selection) return;
    fileSelections.delete(kind); uploadDrafts.delete(kind);
    if (kind === "delivery" || batchId === scope.batchId) {
      const prefix = kind === "delivery" ? "delivery" : kind.startsWith("review:") ? "review" : "acceptance";
      $("#" + prefix + "Files").value = "";
      text("#" + prefix + "FileList", "");
    }
  }
  function fileMime(bytes, filename) {
    const starts = signature => signature.every((byte, index) => bytes[index] === byte);
    const mime = starts([137, 80, 78, 71, 13, 10, 26, 10]) ? "image/png" : starts([255, 216, 255]) ? "image/jpeg" : starts([37, 80, 68, 70, 45]) ? "application/pdf" : null;
    const extension = filename.split(".").pop().toLowerCase();
    if (!mime || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf" })[extension] !== mime) throw new Error("附件须为扩展名与文件头一致的 PNG、JPEG 或 PDF");
    return mime;
  }
  async function uploadEvidence(kind, scope, method, existingBatchId) {
    const accountTicket = epoch, files = scope.selection.files;
    const active = () => accountTicket === epoch && scope.current();
    const check = () => { if (!active()) throw new Error("当前账户或批次已切换，上传暂停；返回原批次后可重试"); };
    if (files.length < 1 || files.length > 6) throw new Error("每次交付或验收须选择 1 至 6 件原始附件");
    if (files.some(file => file.size < 1 || file.size > maxFileBytes)) throw new Error("每件附件须大于 0 且不超过 5 MiB");
    let draft = uploadDrafts.get(kind);
    if (!draft || draft.selection !== scope.selection || draft.contractId !== scope.contractId || draft.contractVersion !== scope.contractVersion || draft.reviewAssignmentId !== scope.reviewAssignmentId) {
      draft = { selection: scope.selection, contractId: scope.contractId, contractVersion: scope.contractVersion,
        batchId: existingBatchId || "B-" + crypto.randomUUID(), method, reviewAssignmentId: scope.reviewAssignmentId, files: files.map(file => ({ file, id: "E-" + crypto.randomUUID(), key: crypto.randomUUID(), metadata: null })) };
      uploadDrafts.set(kind, draft);
    }
    // Check every header before uploading any file; keep one stable receipt slot per file.
    for (const entry of draft.files) {
      if (!entry.mimeType) entry.mimeType = fileMime(new Uint8Array(await entry.file.slice(0, 8).arrayBuffer()), entry.file.name);
      check();
    }
    for (const entry of draft.files) {
      check();
      if (entry.metadata) continue;
      const bytes = new Uint8Array(await entry.file.arrayBuffer()); check();
      const digest = await sha256(bytes); check();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const controller = new AbortController(); privateTransfers.add(controller);
      try {
        const response = await api(`/v1/platform/contracts/${encodeURIComponent(draft.contractId)}/evidence`, {
          id: entry.id, contractVersion: draft.contractVersion, batchId: draft.batchId, method,
          ...(method === "resolveDispute" ? { reviewAssignmentId: draft.reviewAssignmentId } : {}),
          filename: entry.file.name, mimeType: entry.mimeType, contentBase64: btoa(binary)
        }, entry.key, false, controller.signal);
        check(); validateEvidence(response.data, draft);
        if (response.data.id !== entry.id || response.data.filename !== entry.file.name || response.data.mimeType !== entry.mimeType || response.data.sizeBytes !== entry.file.size || hash256(response.data.sha256) !== digest) throw new Error("上传附件摘要或元数据不匹配，请重试确认");
        entry.metadata = response.data;
        renderFiles(kind, kind === "delivery" ? "#deliveryFileList" : kind.startsWith("review:") ? "#reviewFileList" : "#acceptanceFileList");
      } finally { privateTransfers.delete(controller); }
    }
    check();
    return { batchId: draft.batchId, evidenceIds: draft.files.map(entry => entry.id) };
  }
  async function downloadEvidence(button) {
    const metadata = attestationRecords?.flatMap(item => item.evidence || []).find(item => item.id === button.dataset.downloadEvidence);
    if (!metadata || attestationVersion !== state?.version) return;
    const accountTicket = epoch, ticket = batchEpoch, key = attestationKey;
    const current = () => accountTicket === epoch && ticket === batchEpoch && key === attestationKey && button.isConnected;
    const controller = new AbortController(); privateTransfers.add(controller);
    let url;
    button.disabled = true; text("#evidenceDownloadStatus", "正在读取私有附件并核对 SHA256");
    try {
      const response = await fetch(`/v1/platform/evidence/${encodeURIComponent(metadata.id)}/content`, { credentials: "same-origin", cache: "no-store",
        headers: adminMode ? { "X-Relief-Actor": "admin" } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) throw Object.assign(new Error("附件下载失败，请重试"), { status: response.status });
      if (!current()) return;
      const bytes = await response.arrayBuffer();
      if (!current()) return;
      const digest = await sha256(bytes);
      if (!current()) return;
      if (bytes.byteLength !== metadata.sizeBytes || digest !== hash256(metadata.sha256)) throw new Error("附件 SHA256 或大小不匹配，已阻止下载");
      url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = metadata.filename; link.hidden = true;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      text("#evidenceDownloadStatus", "已发起下载，文件字节摘要一致；不代表病毒扫描或真实性核验");
    } catch (error) {
      if (accountTicket !== epoch) return;
      if (error.status === 401 || error.status === 403) { clearPrivate(friendly(error)); return; }
      if (current()) text("#evidenceDownloadStatus", friendly(error));
    } finally {
      if (url) URL.revokeObjectURL(url);
      privateTransfers.delete(controller);
      if (current()) button.disabled = false;
    }
  }
  async function loadDocument(contract) {
    const ticket = ++detailEpoch, v = terms(contract); documentData = null;
    $('#signatureForm [name="reviewed"]').checked = false; $("#signatureForm").hidden = true;
    text("#contractDetail", "正在读取合同正文");
    try {
      const doc = (await api(`/v1/platform/contracts/${encodeURIComponent(contract.id)}/document`)).data;
      if (ticket !== detailEpoch || selected?.id !== contract.id) return;
      if (!doc || doc.version !== contract.currentVersion || !same(doc.termsHash, v.termsHash) || !same(doc.acceptanceCriteriaHash, v.acceptanceCriteriaHash) || !same(window.ethers.keccak256(window.ethers.toUtf8Bytes(doc.termsText)), v.termsHash) || !same(window.ethers.keccak256(window.ethers.toUtf8Bytes(doc.acceptanceText)), v.acceptanceCriteriaHash)) throw new Error("合同正文摘要与签署版本不一致");
      documentData = doc;
      $("#contractDetail").innerHTML = `<div class="contract-title"><h1>${escape(contract.id)}</h1><span class="tag pending">${escape(statuses[contract.status] || contract.status)}</span></div><dl class="terms-grid">${[
        ["版本 / 救援任务", `v${contract.currentVersion} / ${v.taskId}`], ["物资或服务", `${resource(v.resourceId).name} × ${v.quantity}`], ["单价 MON", amount(v.unitPriceWei)], ["合同金额 MON", amount(BigInt(v.unitPriceWei) * BigInt(v.quantity))], ["采购机构 / 签署钱包", `${v.buyerOrganizationId}\n${v.buyerWallet}`], ["供方机构 / 收款钱包", `${v.supplierOrganizationId}\n${v.supplierWallet}`], ["签署截止", date(v.expiresAt)], ["签名域", `${v.chainId} / ${v.escrowContract}`]
      ].map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl><h2>合同条款</h2><div class="document-text">${escape(doc.termsText)}</div><h2>验收标准</h2><div class="document-text">${escape(doc.acceptanceText)}</div><details><summary>正文摘要</summary><p class="hash-value">${escape(v.termsHash)}</p><p class="hash-value">${escape(v.acceptanceCriteriaHash)}</p></details>`;
      const party = same(binding?.wallet, v.buyerWallet) && binding?.role === "contract_approver" ? "buyer" : same(binding?.wallet, v.supplierWallet) && binding?.role === "supplier" ? "supplier" : null;
      const signed = contract.signatures?.[party];
      $("#signatureForm").hidden = adminMode || !party || !!signed || !["DRAFT", "PARTIALLY_SIGNED"].includes(contract.status);
      text("#signingStatus", state.configuration.signingReady ? `待${party === "buyer" ? "采购方" : "供方"}签名 · 不转移 MON` : "未配置签名域，暂不可签署");
      $('#signatureForm button').disabled = !state.configuration.signingReady || v.expiresAt <= Date.now() / 1000;
    } catch (error) {
      if (ticket !== detailEpoch) return;
      documentKey = ""; text("#contractDetail", friendly(error));
      if (error.status === 401 || error.status === 403) clearPrivate(friendly(error));
    }
  }
  function integer(value, minimum = 1) { const n = Number(value); if (!value || !Number.isSafeInteger(n) || n < minimum) throw new Error("数量和时长必须为有效整数"); return n; }
  function seconds(value) { const n = new Date(value).getTime() / 1000; if (!value || !Number.isSafeInteger(n) || n <= Date.now() / 1000) throw new Error("截止时间必须晚于当前时间"); return n; }
  async function submit(form, kind, build, scope) {
    const assignmentCommand = form === $("#reviewAssignmentForm") && kind === "assignment:" + batchId;
    if (busy || !state || adminMode && !assignmentCommand || !adminMode && assignmentCommand) return;
    busy = true; const ticket = epoch, button = form.querySelector('button[type="submit"]'), result = form.querySelector(".form-result");
    const values = Object.fromEntries([...new FormData(form)].filter(([, value]) => typeof value === "string"));
    const expectedVersion = state.version;
    const controls = [...form.querySelectorAll("input,select,textarea")].map(node => [node, node.disabled]);
    controls.forEach(([node]) => { node.disabled = true; });
    button.disabled = true; result.dataset.success = "false"; result.textContent = "正在提交";
    try {
      const fingerprint = JSON.stringify([values, scope?.fingerprint || ""]);
      let operation = pending.get(kind);
      const confirmedAssignmentRetry = assignmentCommand && sameAssignmentValues(operation, values) && assignmentRetryState(batches().find(item => item.id === scope.batchId), operation) === "committed";
      if (!confirmedAssignmentRetry && (!operation || operation.fingerprint !== fingerprint)) {
        const built = await build(values);
        if (ticket !== epoch || !state || scope && !scope.current()) return;
        operation = { fingerprint, key: crypto.randomUUID(), ...built, expectedVersion }; pending.set(kind, operation);
      }
      if (ticket !== epoch || !state || scope && !scope.current()) return;
      const response = await api(operation.path, { ...operation.body, expectedVersion: operation.expectedVersion }, operation.key, assignmentCommand);
      if (ticket !== epoch) return;
      pending.delete(kind);
      if (kind.startsWith("review:")) reviewDrafts.delete(kind);
      if (scope?.batchId) batchDrafts.delete(scope.batchId);
      if (!scope || scope.current() || assignmentCommand && batchId === scope.batchId && assignmentRetryState(batches().find(item => item.id === batchId), operation) === "committed") {
        form.reset(); result.textContent = response.replayed ? "已确认先前提交成功" : assignmentCommand ? "已保存分派记录" : kind.startsWith("payable:") ? "已创建应付，未发起付款" : "已保存"; result.dataset.success = "true";
        if (scope?.batchId) saveBatchDraft();
        if (kind === "delivery") location.hash = "batch/" + encodeURIComponent(response.data.id);
      }
      resetEvidence(kind, scope);
      if (kind === "contract") location.hash = "contract/" + encodeURIComponent(response.data.id);
      documentKey = ""; await refresh();
    } catch (error) {
      if (ticket !== epoch) return;
      if (!scope || scope.current()) result.textContent = friendly(error);
      if (error.status && error.status < 500) pending.delete(kind);
      if (error.status === 401 || error.status === 403) clearPrivate(friendly(error));
      else if (error.code === "VERSION_CONFLICT") await refresh();
      else if (["REVIEW_ASSIGNMENT_CHANGED", "REVIEW_ASSIGNMENT_MISMATCH", "REVIEWER_ASSIGNMENT_MISMATCH"].includes(error.code)) { discardReview(kind); clearPrivate("复核分派已变化，请刷新重新验证"); }
    } finally {
      busy = false; controls.forEach(([node, disabled]) => { node.disabled = disabled; });
      button.disabled = kind === "contract" && !state?.configuration.signingReady;
      if (scope && state) { renderFulfillment(); route(); }
    }
  }
  function statement(value) {
    if (typeof value !== "string" || value.trim().length < 2 || value.length > 16000) throw new Error("说明须为 2 至 16000 字且不得为空");
    return value;
  }
  $('#reviewAssignmentForm').addEventListener("submit", event => {
    event.preventDefault();
    const batch = batches().find(item => item.id === batchId), ticket = batchEpoch;
    if (!adminMode || busy || batch?.status !== "DISPUTED") return;
    const id = batch.id, assignmentId = lastAssignment(batch)?.id;
    void submit(event.currentTarget, "assignment:" + id, value => {
      const current = batches().find(item => item.id === id), candidate = context.reviewers?.find(item => item.assignmentId === value.assignmentId);
      if (current?.status !== "DISPUTED" || !independentReviewer(current, candidate)) throw new Error("请选择有效且独立于合同参与方的复核岗位");
      if (value.reason.trim().length < 2 || value.reason.length > 2000) throw new Error("分派原因须为 2 至 2000 字");
      return { path: `/v1/platform/batches/${encodeURIComponent(id)}/reviewer-assignment`, baseAssignmentId: assignmentId || "", body: { id: crypto.randomUUID(), assignmentId: candidate.assignmentId, reason: value.reason } };
    }, { batchId: id, fingerprint: assignmentId || "", current: () => batchId === id && ticket === batchEpoch && lastAssignment(batches().find(item => item.id === id))?.id === assignmentId });
  });
  $('#reviewFiles').addEventListener("change", () => { if (currentReviewKey) chooseFiles(currentReviewKey, $("#reviewFiles"), "#reviewFileList"); });
  $('#reviewForm').addEventListener("input", saveReviewDraft);
  $('#reviewForm').addEventListener("submit", event => {
    event.preventDefault();
    const batch = batches().find(item => item.id === batchId), ticket = batchEpoch;
    if (busy || !canReview(batch)) return;
    const id = batch.id, kind = reviewKey(batch), assignmentId = lastAssignment(batch).id;
    const scope = evidenceScope(kind, $("#reviewFiles"), batch.contractId, batch.contractVersion,
      () => batchId === id && ticket === batchEpoch && reviewKey(batches().find(item => item.id === id)) === kind && assignedTo(batches().find(item => item.id === id)));
    scope.batchId = id; scope.reviewAssignmentId = assignmentId; scope.fingerprint += ":" + assignmentId;
    void submit(event.currentTarget, kind, async value => {
      const current = batches().find(item => item.id === id), quantity = integer(value.acceptedQuantity, 0);
      if (!canReview(current) || quantity > current.deliveredQuantity) throw new Error("复核权限已变化，或数量超出本批次交付数量");
      const description = statement(value.statement);
      const uploaded = await uploadEvidence(kind, scope, "resolveDispute", id);
      if (!canReview(batches().find(item => item.id === id))) throw new Error("分派或说明记录已变化，请重新确认复核");
      return { path: `/v1/platform/batches/${encodeURIComponent(id)}/review`, body: { acceptedQuantity: quantity, statement: description, evidenceIds: uploaded.evidenceIds, reviewAssignmentId: assignmentId } };
    }, scope);
  });
  $('#deliveryForm').addEventListener("submit", event => {
    event.preventDefault(); const hash = location.hash, contractId = $('#deliveryForm [name="contractId"]').value;
    const contract = state?.contracts.find(item => item.id === contractId);
    if (!contract || busy || adminMode) return;
    const scope = evidenceScope("delivery", $("#deliveryFiles"), contract.id, contract.currentVersion, () => location.hash === hash && $('#deliveryForm [name="contractId"]').value === contractId);
    void submit(event.currentTarget, "delivery", async value => {
      const contract = state.contracts.find(item => item.id === value.contractId), quantity = integer(value.quantity);
      if (!canDeliver(contract)) throw new Error("请选择本供方机构已锁款且可交付的合同");
      if (BigInt(quantity) > remaining(contract)) throw new Error("交付数量超过合同剩余数量");
      const description = statement(value.statement);
      const uploaded = await uploadEvidence("delivery", scope, "deliverBatch");
      const latest = state?.contracts.find(item => item.id === contract.id);
      if (!canDeliver(latest) || latest.currentVersion !== scope.contractVersion) throw new Error("合同状态或版本已变化，请重新确认交付");
      return { path: "/v1/platform/deliveries", body: { id: uploaded.batchId, contractId: contract.id, quantity, statement: description, evidenceIds: uploaded.evidenceIds } };
    }, scope);
  });
  $('#deliveryFiles').addEventListener("change", () => chooseFiles("delivery", $("#deliveryFiles"), "#deliveryFileList"));
  $('#deliveryForm [name="contractId"]').addEventListener("change", () => chooseFiles("delivery", $("#deliveryFiles"), "#deliveryFileList"));
  $('#acceptanceFiles').addEventListener("change", () => { if (batchId) chooseFiles("acceptance:" + batchId, $("#acceptanceFiles"), "#acceptanceFileList"); });
  $('#batchAttestations').addEventListener("click", event => { const button = event.target.closest("[data-download-evidence]"); if (button && !button.disabled) void downloadEvidence(button); });
  $('#acceptanceForm').addEventListener("input", saveBatchDraft);
  $('#acceptanceForm [name="outcome"]').addEventListener("change", () => { acceptanceQuantity(); saveBatchDraft(); });
  $('#acceptanceForm').addEventListener("submit", event => {
    event.preventDefault(); const id = batchId, ticket = batchEpoch;
    const batch = batches().find(item => item.id === id);
    if (!canAccept(batch) || busy) return;
    const scope = evidenceScope("acceptance:" + id, $("#acceptanceFiles"), batch.contractId, batch.contractVersion, () => batchId === id && ticket === batchEpoch);
    scope.batchId = id;
    void submit(event.currentTarget, "acceptance:" + id, async value => {
      const batch = batches().find(item => item.id === id), quantity = integer(value.acceptedQuantity, 0);
      if (!canAccept(batch)) throw new Error("当前岗位、机构或批次状态不允许验收，需满足岗位分离");
      const valid = value.outcome === "ACCEPTED" ? quantity === batch.deliveredQuantity : value.outcome === "PARTIAL" ? quantity > 0 && quantity < batch.deliveredQuantity : ["REJECTED", "DISPUTED"].includes(value.outcome) && quantity === 0;
      if (!valid) throw new Error("通过须等于交付数量，部分通过须大于 0 且小于交付数量，拒收或争议须为 0");
      const description = statement(value.statement);
      const uploaded = await uploadEvidence("acceptance:" + id, scope, "acceptBatch", id);
      if (!canAccept(batches().find(item => item.id === id))) throw new Error("批次状态或说明记录已变化，请重新确认验收");
      return { path: `/v1/platform/batches/${encodeURIComponent(id)}/acceptance`, body: { outcome: value.outcome, acceptedQuantity: quantity, statement: description, evidenceIds: uploaded.evidenceIds } };
    }, scope);
  });
  $('#payableForm').addEventListener("submit", event => {
    event.preventDefault(); const id = batchId, ticket = batchEpoch;
    if (!canCreatePayable(batches().find(item => item.id === id))) return;
    void submit(event.currentTarget, "payable:" + id, () => {
      if (!canCreatePayable(batches().find(item => item.id === id))) throw new Error("当前岗位、机构或批次状态不允许创建应付，需满足岗位分离");
      return { path: `/v1/platform/batches/${encodeURIComponent(id)}/payable`, body: {} };
    }, { batchId: id, current: () => batchId === id && ticket === batchEpoch });
  });
  $('#quoteForm').addEventListener("submit", event => { event.preventDefault(); void submit(event.currentTarget, "quote", value => {
    const price = window.ethers.parseEther(value.unitPriceMon); if (price <= 0n) throw new Error("单价必须大于 0 MON");
    return { path: "/v1/platform/quotes", body: { id: "Q-" + crypto.randomUUID(), resourceId: value.resourceId, unitPriceWei: price.toString(), availableQuantity: integer(value.availableQuantity), etaHours: integer(value.etaHours, 0), validUntil: seconds(value.validUntil) } };
  }); });
  $('#reservationForm').addEventListener("submit", event => { event.preventDefault(); void submit(event.currentTarget, "reservation", value => ({ path: "/v1/platform/reservations", body: { id: "R-" + crypto.randomUUID(), quoteId: value.quoteId, taskId: value.taskId, quantity: integer(value.quantity), buyerWallet: value.buyerWallet } })); });
  $('#contractForm').addEventListener("submit", event => { event.preventDefault(); void submit(event.currentTarget, "contract", value => ({ path: "/v1/platform/contracts", body: { id: "C-" + crypto.randomUUID(), reservationId: value.reservationId, termsText: value.termsText, acceptanceText: value.acceptanceText, expiresAt: seconds(value.expiresAt), nonce: BigInt("0x" + crypto.randomUUID().replaceAll("-", "")).toString() } })); });
  function providerOptions() {
    const select = $('#walletProvider'), saved = select.value;
    select.innerHTML = [...providers].map(([id, item]) => `<option value="${escape(id)}">${escape(item.name)}</option>`).join("") || '<option value="">未检测到钱包</option>';
    if (providers.has(saved)) select.value = saved;
  }
  window.addEventListener("eip6963:announceProvider", event => { const detail = event.detail; if (detail?.provider?.request && typeof detail.info?.uuid === "string") { providers.set(detail.info.uuid, { name: String(detail.info.name || "钱包"), provider: detail.provider }); providerOptions(); } });
  if (window.ethereum?.request) providers.set("injected", { name: window.ethereum.isMetaMask ? "MetaMask" : "浏览器钱包", provider: window.ethereum });
  window.dispatchEvent(new Event("eip6963:requestProvider")); providerOptions();
  $('#signatureForm').addEventListener("submit", event => {
    event.preventDefault();
    const contract = selected, doc = documentData, account = binding;
    if (!contract || !doc || !account) return;
    void submit(event.currentTarget, "signature:" + contract.id, async () => {
      const v = terms(contract), wallet = providers.get($('#walletProvider').value)?.provider;
      if (!wallet) throw new Error("未检测到钱包，请在 MetaMask 浏览器中打开或安装扩展");
      const typed = (await api(`/v1/platform/contracts/${encodeURIComponent(contract.id)}/typed-data`, undefined, undefined, false)).data;
      if (typed.value.contractId !== contract.id || String(typed.value.version) !== String(contract.currentVersion) || !same(typed.value.termsHash, doc.termsHash) || !same(typed.value.acceptanceCriteriaHash, doc.acceptanceCriteriaHash)) throw new Error("签署内容已变化，请重新打开合同核对");
      for (const key of Object.keys(typed.value)) if (String(typed.value[key]).toLowerCase() !== String(v[key]).toLowerCase()) throw new Error("签署条款与当前展示不一致");
      if (String(typed.domain.chainId) !== String(state.configuration.chainId) || !same(typed.domain.verifyingContract, state.configuration.escrowContract)) throw new Error("合同签名域不匹配");
      const addresses = await wallet.request({ method: "eth_requestAccounts" });
      if (!same(addresses[0], account.wallet)) throw new Error("当前钱包不是岗位绑定的签署钱包");
      const chain = await wallet.request({ method: "eth_chainId" });
      if (BigInt(chain) !== BigInt(typed.domain.chainId)) throw new Error("请将钱包切换至 Monad 测试网后重试");
      const payload = window.ethers.TypedDataEncoder.getPayload(typed.domain, typed.types, typed.value);
      const signature = await wallet.request({ method: "eth_signTypedData_v4", params: [account.wallet, JSON.stringify(payload)] });
      if (!same(window.ethers.verifyTypedData(typed.domain, typed.types, typed.value, signature), account.wallet)) throw new Error("钱包签名验证失败");
      const latest = (await api("/v1/platform/operators/me", undefined, undefined, false)).data;
      if (!latest || latest.userId !== account.userId || !same(latest.wallet, account.wallet) || latest.role !== account.role) throw Object.assign(new Error("账户或岗位已变更，签名未提交"), { status: 403 });
      return { path: `/v1/platform/contracts/${encodeURIComponent(contract.id)}/signatures`, body: { version: contract.currentVersion, signature } };
    });
  });
  $('#quoteList').addEventListener("click", event => { const link = event.target.closest("[data-reserve]"); if (link) $('#reservationForm [name="quoteId"]').value = link.dataset.reserve; });
  $('#refresh').addEventListener("click", () => void refresh());
  window.addEventListener("hashchange", route);
  window.addEventListener("pageshow", event => { if (event.persisted) { clearPrivate("正在重新验证岗位"); void refresh(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 10000);
  icons(); void refresh();
})();
