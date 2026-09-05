(() => {
  "use strict";
  const root = document.getElementById("wallet-donations");
  if (!root) return;
  const purposes = ["不限用途", "饮水食品", "医疗物资", "安置装备", "救援服务", "灾后重建"];
  const idPattern = /^0x[\da-f]{64}$/i;
  const statuses = { PREPARED: "仅准备，未计入账本", RECORDED: "已记录入账", REORGED: "原入账已撤下，待重新核验" };
  const activityNames = { DonationReceived: "入账", DonationAllocated: "分配", ContractLocked: "合同锁款", BatchPaid: "批次支出", ContractClosed: "合同关闭", DonationRefunded: "退款", TaskClosed: "任务关闭" };
  let authenticated = false, busy = false, epoch = 0, controller = null, timer = null;
  let offset = 0, limit = 25, total = 0;
  root.innerHTML = `
    <div class="fr-head"><h2>用户捐赠明细</h2><button id="fr-refresh" type="button" title="刷新捐赠记录" aria-label="刷新捐赠记录" disabled>↻</button></div>
    <p id="fr-status" role="status" aria-live="polite">请先在上方验证管理权限。</p>
    <div id="fr-private" hidden>
      <p id="fr-connection" class="fr-note"></p>
      <div id="fr-list-panel">
        <h3>全部记录汇总</h3><p class="fr-note">汇总不受筛选影响；仅准备的金额不计入账本。金额单位：MON。</p>
        <div id="fr-summary" class="fr-summary"></div>
        <form id="fr-filters" autocomplete="off">
          <label>状态<select id="fr-status-filter"><option value="all">全部状态</option><option value="PREPARED">仅准备，未计入账本</option><option value="RECORDED">已记录入账</option></select></label>
          <label>用途<select id="fr-purpose"><option value="all">全部用途</option></select></label>
          <label class="fr-search">捐赠 ID 前缀<input id="fr-query" type="search" maxlength="66" placeholder="0x + 4 至 64 位十六进制" spellcheck="false" autocomplete="off"></label>
          <label>每页<select id="fr-limit"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
          <button type="submit">筛选</button>
        </form>
        <div id="fr-list"></div>
        <div class="fr-pagination"><span id="fr-page"></span><button id="fr-prev" type="button" title="上一页" aria-label="上一页" disabled>←</button><button id="fr-next" type="button" title="下一页" aria-label="下一页" disabled>→</button></div>
      </div>
      <div id="fr-detail-panel" hidden><a id="fr-back" href="#wallet-donations">← 返回捐赠列表</a><div id="fr-detail"></div></div>
    </div>`;
  const $ = id => document.getElementById("fr-" + id);
  purposes.forEach((label, index) => $("purpose").add(new Option(label, String(index))));
  $("status-filter").add(new Option("原入账已撤下", "REORGED"));
  for (const element of root.querySelectorAll("[id^='fr-']")) element.dataset.testid = element.id;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function mon(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return "--";
    const wei = BigInt(value), unit = 10n ** 18n;
    return `${wei / unit}.${String(wei % unit).padStart(18, "0")}`;
  }
  function date(value) {
    if (value === null || value === undefined || value === "") return "--";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "--" : parsed.toLocaleString("zh-CN", { hour12: false });
  }
  function chainLink(value, chainId, kind = "tx") {
    const valid = kind === "address" ? /^0x[\da-f]{40}$/i : idPattern;
    if (String(chainId) !== "10143" || !valid.test(value || "")) return el("span", value ?? "--");
    const a = el("a", value);
    a.href = `https://testnet.monadexplorer.com/${kind}/${value}`;
    a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }
  function fields(parent, entries, className = "fr-fields") {
    const dl = el("dl", null, className);
    for (const [label, value] of entries) {
      const dd = el("dd"); dd.append(value instanceof Node ? value : el("span", value ?? "--"));
      const group = el("div"); group.append(el("dt", label), dd); dl.append(group);
    }
    parent.append(dl);
  }
  function table(parent, headers, rows) {
    if (!rows.length) { parent.append(el("p", "暂无记录", "fr-note")); return; }
    const t = el("table"), head = el("thead"), tr = el("tr"), body = el("tbody");
    headers.forEach(h => tr.append(el("th", h))); head.append(tr);
    rows.forEach(values => {
      const row = el("tr");
      values.forEach((value, index) => {
        const cell = el("td"); cell.dataset.label = headers[index];
        cell.append(value instanceof Node ? value : el("span", value ?? "--")); row.append(cell);
      }); body.append(row);
    });
    t.append(head, body); parent.append(t);
  }
  function route() {
    const hash = location.hash;
    return hash.startsWith("#wallet-donation/") ? hash.slice("#wallet-donation/".length) : null;
  }
  function message(text, error = false) { $("status").textContent = text; $("status").dataset.error = String(error); }
  function clearData() {
    for (const id of ["list", "detail", "summary", "connection", "page"]) $(id).replaceChildren();
    total = 0;
  }
  function controls() {
    $("private").hidden = !authenticated;
    $("refresh").disabled = busy;
    $("prev").disabled = !authenticated || busy || offset === 0;
    $("next").disabled = !authenticated || busy || offset + limit >= total;
    $("list-panel").hidden = route() !== null;
    $("detail-panel").hidden = route() === null;
    root.setAttribute("aria-busy", String(busy));
  }
  function cancel() { epoch++; controller?.abort(); controller = null; clearTimeout(timer); timer = null; busy = false; }
  function reset(text = "请先在上方验证管理权限。", error = false) {
    cancel(); authenticated = false; clearData(); $("filters").reset();
    $("query").setCustomValidity(""); offset = 0; limit = 25;
    message(text, error); controls();
  }
  function schedule() {
    clearTimeout(timer);
    if (authenticated && !document.hidden) timer = setTimeout(() => void refresh(), 10000);
  }
  async function api(path, signal) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { "X-Relief-Actor": "admin" }, signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(response.status === 404 ? "未找到该捐赠记录。" : result.error?.message || "捐赠记录读取失败，请重试。"), { status: response.status });
    if (!result.data) throw new Error("捐赠服务返回数据不完整。");
    return result.data;
  }
  function renderList(data) {
    const connection = data.connection || {};
    $("connection").textContent = connection.reason || "尚未配置账本连接。";
    if (connection.configured) $("connection").append(el("span", ` · 状态 ${connection.indexerState ?? "--"} · 已索引 ${connection.indexedThroughBlock ?? "--"} · 确认高度 ${connection.confirmedBlock ?? "--"} · 链 ID ${connection.chainId ?? "--"} · 账本版本 ${data.projectionVersion ?? "--"}`));
    const summary = connection.configured ? data.summary : null;
    const entries = [["仅准备笔数", summary?.preparedCount ?? "--"], ["已记录笔数", summary?.recordedCount ?? "--"], ["撤下待核验笔数", summary?.reorgedCount ?? "--"]];
    for (const [key, label] of [["donatedWei", "已记录捐赠"], ["gasReservedWei", "Gas 预留"], ["availableWei", "可用金额"], ["allocatedWei", "已分配"], ["lockedWei", "合同锁定"], ["spentWei", "实际支出"], ["refundedWei", "已退款"], ["balanceWei", "账本余额"]]) entries.push([label, mon(summary?.[key])]);
    fields($("summary"), entries, "fr-summary-values");
    const rows = (data.items || []).map(item => {
      const identity = el("div"); identity.append(el("strong", item.donorName ?? "--"), el("small", item.userId ?? "--"), chainLink(item.wallet, connection.chainId, "address"));
      const id = el("a", item.id);
      if (idPattern.test(item.id)) id.href = `#wallet-donation/${item.id}`;
      const amount = el("div", mon(item.amountWei)); amount.append(el("small", `Gas 预留 ${mon(item.gasReservedWei)}`));
      const purpose = el("div", purposes[item.purpose] ?? "--"); purpose.append(el("small", item.projectId ?? "不限项目"));
      return [id, identity, purpose, amount, statuses[item.status] ?? "未知状态", date(item.createdAt), item.status === "RECORDED" ? chainLink(item.txHash, connection.chainId) : "--"];
    });
    table($("list"), ["捐赠 ID", "捐赠人 / 用户 ID / 钱包", "用途 / 项目", "金额（MON）", "状态", "创建时间", "入账交易"], rows);
    const page = data.pagination;
    if (!page || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset || page.limit !== limit) throw new Error("分页响应不一致，请重新筛选。");
    total = page.total;
    $("page").textContent = `共 ${total} 条 · ${rows.length ? offset + 1 : 0}–${offset + rows.length}`;
  }
  function renderDetail(data, id) {
    if (typeof data.id !== "string" || data.id.toLowerCase() !== id.toLowerCase()) throw new Error("捐赠详情与当前 ID 不一致。");
    const target = $("detail"), recorded = data.status === "RECORDED", profile = data.profile || {};
    $("connection").textContent = data.connection?.reason || "仅显示已保存的账本记录。";
    target.append(el("h3", "捐赠详情"), el("p", statuses[data.status] ?? "未知状态", "fr-record-status"));
    fields(target, [["捐赠 ID", data.id], ["用途", purposes[data.purpose] ?? "--"], ["项目 ID", data.projectId ?? "不限项目"], [recorded ? "捐赠金额（MON）" : "准备金额（MON，未入账）", mon(data.amountWei)], ["Gas 预留（MON）", mon(data.gasReservedWei)], ["创建时间", date(data.createdAt)], ["登记承诺", data.registrationHash], ["链 ID", data.chainId], ["资金池", chainLink(data.poolAddress, data.chainId, "address")], ["入账交易", recorded ? chainLink(data.txHash, data.chainId) : "--"], ["入账区块", recorded ? data.blockNumber : "--"]]);
    target.append(el("h3", "用户登记资料"), el("p", "登记资料不代表身份、机构真实性或 KYC 已核验；测试邮箱验证不代表真实邮箱已验证。", "fr-note"));
    fields(target, [["用户 ID", profile.id ?? data.userId], ["姓名", profile.name ?? data.donorName], ["邮箱", profile.email], ["机构", profile.organization], ["钱包", chainLink(profile.wallet ?? data.wallet, data.chainId, "address")], ["注册时间", date(profile.registeredAt)], ["测试邮箱验证", profile.emailTestVerified ? "本地测试已通过" : "未通过本地测试"], ["测试验证时间", date(profile.emailTestVerifiedAt)], ["邮箱验证模式", profile.emailVerificationMode], ["真实邮箱验证", "未核验"]]);
    target.append(el("h3", "本捐赠账本余额（MON）"));
    const balances = recorded ? data.balances : null;
    fields(target, [["可用", mon(balances?.availableWei)], ["Gas 预留", mon(balances?.gasReservedWei)], ["已分配", mon(balances?.allocatedWei)], ["锁定", mon(balances?.lockedWei)], ["实际支出", mon(balances?.spentWei)], ["已退款", mon(balances?.refundedWei)]]);
    if ((data.orphanedReceipts || []).length) {
      target.append(el("h3", "已撤下的历史入账"));
      table(target, ["原交易", "原区块", "原区块哈希"], data.orphanedReceipts.map(item => [chainLink(item.txHash, data.chainId), item.blockNumber, item.blockHash]));
    }
    if (!recorded) { target.append(el("p", data.status === "REORGED" ? "原入账不在当前规范账本中，金额未计入余额，等待重新核验。" : "仅准备，尚无已记录的链上资金去向。", "fr-note")); return; }
    for (const [title, headers, rows] of [
      ["任务分配", ["任务 ID", "可用金额（MON）"], (data.allocations || []).map(a => [a.taskId, mon(a.availableWei)])],
      ["合同锁定", ["合同 ID", "任务 ID", "本来源金额（MON）", "剩余金额（MON）", "交易"], (data.contracts || []).map(c => [c.contractId, c.taskId, mon(c.amountWei), mon(c.remainingWei), chainLink(c.txHash, data.chainId)])],
      ["实际支付记录", ["付款 ID", "批次 ID", "任务 ID", "合同 ID", "本来源金额（MON）", "交易"], (data.payments || []).map(p => [p.paymentId, p.batchId, p.taskId, p.contractId, mon(p.amountWei), chainLink(p.txHash, data.chainId)])],
      ["退款记录", ["退款 ID", "金额（MON）", "交易"], (data.refunds || []).map(r => [r.refundId, mon(r.amountWei), chainLink(r.txHash, data.chainId)])]
    ]) { target.append(el("h3", title)); table(target, headers, rows); }
    target.append(el("h3", "链上来源记录"), el("p", "金额仅属于本捐赠来源，不代表整笔批次金额。", "fr-note"));
    const activity = el("div"); activity.id = "fr-activity"; activity.dataset.testid = "fr-activity"; target.append(activity);
    table(activity, ["事件", "交易", "区块 / 日志序号", "任务 ID", "合同 ID", "批次 ID", "本捐赠来源金额（MON）"], (data.activity || []).map(a => [activityNames[a.type] ?? a.type, chainLink(a.txHash, data.chainId), `${a.blockNumber ?? "--"} / ${a.logIndex ?? "--"}`, a.taskId, a.contractId, a.batchId, a.amountWei == null && ["TaskClosed", "ContractClosed"].includes(a.type) ? "--（未单列金额）" : mon(a.amountWei)]));
  }
  async function refresh() {
    cancel(); const ticket = epoch, selected = route();
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    busy = true; clearData(); message("正在读取已保存的捐赠记录…"); controls();
    try {
      const session = await api("/v1/admin/session", signal);
      if (ticket !== epoch) return;
      signal.throwIfAborted();
      if (!session.authenticated) { reset("管理会话未验证，请在上方验证权限。", true); return; }
      authenticated = true; controls();
      if (selected !== null && !idPattern.test(selected)) throw new Error("捐赠 ID 无效，应为 0x 开头的 64 位十六进制值。");
      const query = $("query").value.trim();
      if (selected === null && query && !/^0x[\da-f]{4,64}$/i.test(query)) throw new Error("捐赠 ID 前缀须为 0x 加 4 至 64 位十六进制字符。");
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), status: $("status-filter").value, purpose: $("purpose").value });
      if (query) params.set("q", query);
      const data = await api(selected === null ? `/v1/funding/admin/donations?${params}` : `/v1/funding/admin/donations/${selected}`, signal);
      if (ticket !== epoch || selected !== route()) return;
      signal.throwIfAborted();
      if (selected === null) renderList(data); else renderDetail(data, selected);
      message(data.connection?.live ? `索引已追上确认区块 ${data.connection.indexedThroughBlock}。` : "已读取保存的记录；当前索引未追上确认高度。");
    } catch (error) {
      if (ticket !== epoch) return;
      clearData();
      if ([401, 403].includes(error.status)) { reset("管理会话已失效或无权访问，请重新验证。", true); return; }
      message(signal.aborted ? "读取超时，请刷新重试。" : error.message, true);
    } finally {
      if (ticket === epoch) { busy = false; controller = null; controls(); schedule(); }
    }
  }
  $("refresh").addEventListener("click", () => void refresh());
  $("filters").addEventListener("submit", event => {
    event.preventDefault(); offset = 0; void refresh();
  });
  for (const id of ["status-filter", "purpose", "limit"]) $(id).addEventListener("change", () => {
    limit = Number($("limit").value); offset = 0; if (authenticated) void refresh();
  });
  $("prev").addEventListener("click", () => { offset = Math.max(0, offset - limit); void refresh(); });
  $("next").addEventListener("click", () => { if (offset + limit < total) { offset += limit; void refresh(); } });
  window.addEventListener("hashchange", () => {
    cancel(); clearData(); controls();
    if (authenticated) void refresh();
    if (location.hash === "#wallet-donations" || route() !== null) root.scrollIntoView({ block: "start" });
  });
  window.addEventListener("relief:admin-auth", event => {
    reset(); if (event.detail?.authenticated === true) void refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancel(); clearData(); message(authenticated ? "页面已暂停读取。" : "请先在上方验证管理权限。"); controls(); }
    else if (authenticated) void refresh();
  });
  window.addEventListener("pagehide", () => reset());
  window.addEventListener("pageshow", event => { if (event.persisted) void refresh(); });
  if (route() !== null) requestAnimationFrame(() => root.scrollIntoView({ block: "start" }));
  void refresh();
})();
