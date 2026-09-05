(() => {
  "use strict";
  const root = document.getElementById("funding-mobile");
  if (!root || location.protocol === "file:") return;
  const $ = id => document.getElementById(id);
  const purposes = ["不限用途", "饮水食品", "医疗物资", "安置装备", "救援服务", "灾后重建"];
  const statuses = { PREPARED: "仅准备，未入账", RECORDED: "已记录入账", REORGED: "原入账已撤下，待重新核验" };
  const types = { DonationReceived: "捐赠入账", DonationAllocated: "分配到任务", ContractLocked: "合同锁款", BatchPaid: "批次支付", ContractClosed: "合同关闭", TaskClosed: "任务关闭", DonationRefunded: "退款" };
  let epoch = 0, controller, timer, userId = null, offset = 0, total = 0, prototype = false, lastDetail = null;
  const limit = 10;
  const selected = () => location.hash.startsWith("#donation/") ? location.hash.slice(10) : null;
  const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
  const mon = value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? `${BigInt(value) / 1000000000000000000n}.${String(BigInt(value) % 1000000000000000000n).padStart(18, "0")}` : "--";
  function el(tag, text) { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; }
  function text(id, value) { $(id).textContent = value; }
  function icon(name) { const node = el("i"); node.dataset.lucide = name; node.setAttribute("aria-hidden", "true"); return node; }
  root.innerHTML = `<div class="section-heading"><h2>我的捐赠与资金去向</h2><button id="mf-refresh" type="button" class="icon-button" title="刷新捐赠记录" aria-label="刷新捐赠记录"></button></div>
    <p id="mf-status" class="muted mf-status" role="status"></p><div id="mf-private" hidden>
    <div id="mf-list-panel"><div id="mf-summary"></div><div class="mf-controls"><label>状态<select id="mf-state"><option value="all">全部状态</option></select></label><label>用途<select id="mf-purpose"><option value="all">全部用途</option></select></label></div><div id="mf-list"></div>
    <div class="mf-pages"><button id="mf-prev" class="icon-button" type="button" title="上一页" aria-label="上一页"></button><span id="mf-page"></span><button id="mf-next" class="icon-button" type="button" title="下一页" aria-label="下一页"></button></div></div>
    <div id="mf-detail-panel" hidden><a id="mf-back" class="back-link" href="#account">返回我的捐赠</a><div id="mf-detail"></div></div></div>`;
  $("mf-refresh").append(icon("refresh-cw")); $("mf-prev").append(icon("arrow-left")); $("mf-next").append(icon("arrow-right"));
  for (const [value, name] of Object.entries(statuses)) $("mf-state").add(new Option(name, value));
  purposes.forEach((name, n) => $("mf-purpose").add(new Option(name, String(n))));
  function message(value, error = false) { text("mf-status", value); $("mf-status").dataset.error = String(error); }
  function personal(summary) {
    text("homeEscrow", mon(summary?.balanceWei) + " MON"); text("accountEscrow", mon(summary?.balanceWei) + " MON");
    text("accountAllocated", mon(summary?.allocatedWei) + " MON"); text("accountAvailable", mon(summary?.availableWei) + " MON");
  }
  function clearPrivate() {
    for (const name of ["mf-list", "mf-detail", "mf-summary", "mf-page"]) $(name).replaceChildren();
    $("mf-private").hidden = true; total = 0;
    if (!prototype) personal(null);
  }
  function cancel() { epoch++; controller?.abort(); clearTimeout(timer); controller = null; }
  function controls(busy = false) {
    $("mf-refresh").disabled = busy;
    $("mf-prev").disabled = busy || !userId || offset === 0; $("mf-next").disabled = busy || !userId || offset + limit >= total;
    $("mf-list-panel").hidden = selected() !== null; $("mf-detail-panel").hidden = selected() === null;
  }
  function link(value, kind = "tx") {
    if (!(kind === "address" ? /^0x[0-9a-f]{40}$/i.test(value || "") : hash(value))) return el("span", value ?? "--");
    const node = el("a", value); node.href = `https://testnet.monadexplorer.com/${kind}/${value}`;
    node.target = "_blank"; node.rel = "noopener noreferrer"; return node;
  }
  function fields(parent, values) {
    const dl = el("dl"); dl.className = "mf-fields";
    for (const [label, value] of values) { const group = el("div"), dd = el("dd"); dd.append(value instanceof Node ? value : el("span", value ?? "--")); group.append(el("dt", label), dd); dl.append(group); }
    parent.append(dl);
  }
  function pool(data, error) {
    const summary = data?.summary;
    text("poolMonValue", mon(summary?.donatedWei)); text("escrowMonValue", mon(summary?.balanceWei)); text("availableMonValue", mon(summary?.availableWei));
    text("participantValue", summary?.donorCount ?? "--"); text("walletSyncStatus", error ? "读取失败" : data?.connection.live ? "已追上确认块" : data?.connection.configured ? "已保存账本" : "未配置");
    $("walletSyncStatus").classList.toggle("danger", !!error);
    text("poolProgressText", "任务中可用 " + mon(summary?.allocatedWei) + " MON"); text("poolTargetText", "未分配 " + mon(summary?.availableWei) + " MON");
    $("poolProgress").value = summary && BigInt(summary.donatedWei) > 0n ? Number(BigInt(summary.allocatedWei) * 10000n / BigInt(summary.donatedWei)) / 100 : 0;
    text("poolGapText", error || data?.connection.reason || "资金池账本尚未读取");
    $("walletContract").replaceChildren(el("span", "资金池："), data?.connection.poolAddress ? link(data.connection.poolAddress, "address") : el("span", "未配置"));
  }
  async function api(url, signal) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error?.message || "记录读取失败"), { status: response.status });
    if (!result.data) throw new Error("记录响应不完整"); return result.data;
  }
  function renderList(data, id) {
    lastDetail = null;
    if (!Array.isArray(data.items) || data.items.some(item => item.userId !== id)) throw new Error("记录与当前用户不匹配");
    if (data.pagination?.offset !== offset || data.pagination?.limit !== limit) throw new Error("分页记录不一致");
    total = data.pagination.total;
    personal(data.summary);
    fields($("mf-summary"), [["累计已记录捐赠 MON", mon(data.summary?.donatedWei)], ["实际救灾支出 MON", mon(data.summary?.spentWei)],
      ["Gas 预留 MON", mon(data.summary?.gasReservedWei)], ["合同锁定 MON", mon(data.summary?.lockedWei)], ["已退款 MON", mon(data.summary?.refundedWei)]]);
    for (const item of data.items) {
      const article = el("article"); article.className = "mf-record";
      const a = el("a", mon(item.amountWei) + " MON"); a.href = "#donation/" + item.id;
      article.append(a, el("p", statuses[item.status]), el("p", purposes[item.purpose]), el("small", item.id)); $("mf-list").append(article);
    }
    if (!data.items.length) $("mf-list").append(el("p", "暂无符合条件的捐赠记录"));
    text("mf-page", `共 ${total} 条 · ${data.items.length ? offset + 1 : 0} 至 ${offset + data.items.length}`);
    message(data.connection.reason);
  }
  function renderDetail(data, id, donationId) {
    if (data.userId !== id || data.id !== donationId.toLowerCase()) throw new Error("详情与当前用户或捐赠编号不一致");
    personal(data.accountSummary);
    const target = $("mf-detail"); target.append(el("h3", statuses[data.status]));
    fields(target, [["捐赠 ID", data.id], ["金额 MON", mon(data.amountWei)], ["用途", purposes[data.purpose]], ["项目", data.projectId ?? "不限项目"],
      ["原捐赠钱包", link(data.wallet, "address")], ["入账交易", link(data.txHash)], ["注册时姓名", data.profile.name], ["注册邮箱", data.profile.email]]);
    fields(target, [["未分配 MON", mon(data.balances?.availableWei)], ["任务中可用 MON", mon(data.balances?.allocatedWei)], ["合同锁定 MON", mon(data.balances?.lockedWei)],
      ["实际支出 MON", mon(data.balances?.spentWei)], ["已退回 MON", mon(data.balances?.refundedWei)], ["Gas 预留 MON", mon(data.balances?.gasReservedWei)]]);
    target.append(el("h3", "资金去向")); const flow = el("ol"); flow.className = "mf-flow"; flow.id = "mf-flow";
    for (const item of data.activity) {
      const li = el("li"); li.append(el("strong", types[item.type] ?? item.type), el("p", item.amountWei == null ? "金额未单列" : mon(item.amountWei) + " MON"));
      for (const [name, value] of [["任务", item.taskId], ["合同", item.contractId], ["批次", item.batchId]]) if (value) li.append(el("small", name + "：" + value));
      li.append(link(item.txHash)); flow.append(li);
    }
    target.append(flow);
    if (!data.activity.length) target.append(el("p", "当前账本没有已记录的资金流转"));
    for (const item of data.orphanedReceipts) { target.append(el("h3", "已撤下的历史入账"), link(item.txHash), el("p", "原区块：" + item.blockNumber)); }
    message(data.connection?.reason || "仅显示已保存的本人资金来源，不代表实时链上状态。");
    if (lastDetail !== donationId) { lastDetail = donationId; requestAnimationFrame(() => root.scrollIntoView({ block: "start" })); }
  }
  async function refresh() {
    cancel(); const ticket = epoch, donationId = selected(); controller = new AbortController();
    let poolLoaded = false;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    if (!userId) clearPrivate();
    controls(true); message("正在读取账本更新…");
    try {
      const config = await api("/v1/wallet/config", signal); if (ticket !== epoch) return;
      prototype = config.newOperationsEnabled === true; root.hidden = prototype; $("prototype-donation-history").hidden = !prototype;
      if (prototype) return;
      $("poolMonValue").closest("section").querySelector(".eyebrow").textContent = "资金池 · 累计已记录捐赠 MON";
      $("escrowMonValue").previousElementSibling.textContent = "账本余额 MON";
      $("homeEscrow").previousElementSibling.textContent = "我在资金池中的余额";
      $("accountEscrow").previousElementSibling.textContent = "我的资金池余额";
      $("accountAllocated").previousElementSibling.textContent = "任务中可用";
      $("poolProgress").setAttribute("aria-label", "任务可用余额占已记录捐赠比例");
      try { const data = await api("/v1/funding/pool", signal); if (ticket !== epoch) return; pool(data); poolLoaded = true; }
      catch (error) { if (ticket !== epoch) return; pool(null, error.message); poolLoaded = true; }
      const current = await api("/v1/wallet/me", signal); if (ticket !== epoch) return;
      const nextUserId = current.user?.id ?? null;
      if (nextUserId !== userId) clearPrivate();
      userId = nextUserId;
      if (!userId) { message("登录后查看自己的捐赠记录"); text("homeAccountNote", "登录后查询个人记录"); text("accountStatus", "登录后查询个人记录"); return; }
      if (donationId !== null && !hash(donationId)) throw new Error("捐赠编号无效");
      const params = new URLSearchParams({ offset, limit, status: $("mf-state").value, purpose: $("mf-purpose").value });
      const data = await api(donationId === null ? "/v1/funding/me/donations?" + params : "/v1/funding/me/donations/" + donationId, signal);
      const after = await api("/v1/wallet/me", signal);
      if (ticket !== epoch || donationId !== selected()) return;
      if (after.user?.id !== userId) throw Object.assign(new Error("登录账户已变化，请重新读取"), { status: 401 });
      clearPrivate();
      if (donationId === null) renderList(data, userId); else renderDetail(data, userId, donationId);
      $("mf-private").hidden = false;
      const live = data.connection?.live === true;
      text("homeAccountNote", live ? "已追上确认块，显示本人已核验投影" : "本人已保存账本，非实时链上余额");
      text("accountStatus", live ? `已同步至确认区块 ${data.connection.indexedThroughBlock}` : "本人已保存账本，准备及撤下金额不计入余额");
    } catch (error) {
      if (ticket !== epoch) return; clearPrivate();
      if (!prototype && !poolLoaded) pool(null, "资金池读取未完成，请重新查询");
      message([401, 403].includes(error.status) ? "请重新登录后读取自己的记录" : signal.aborted ? "读取超时，请重试" : error.message, true);
      text("homeAccountNote", "个人记录暂不可用"); text("accountStatus", "个人记录暂不可用");
    } finally {
      if (ticket === epoch) { controls(); if (!document.hidden && !prototype) timer = setTimeout(refresh, 10000); }
    }
  }
  $("mf-refresh").addEventListener("click", refresh); $("accountRetry").addEventListener("click", refresh);
  for (const name of ["mf-state", "mf-purpose"]) $(name).addEventListener("change", () => { offset = 0; void refresh(); });
  $("mf-prev").addEventListener("click", () => { offset = Math.max(0, offset - limit); void refresh(); });
  $("mf-next").addEventListener("click", () => { if (offset + limit < total) offset += limit; void refresh(); });
  window.addEventListener("relief:wallet-user", event => {
    const next = event.detail?.id ?? null;
    if (next === userId) return; cancel(); userId = next; offset = 0; clearPrivate();
    $("mf-state").value = "all"; $("mf-purpose").value = "all"; void refresh();
  });
  document.addEventListener("click", event => { if (event.target.closest("#logoutBtn")) { cancel(); clearPrivate(); message("已清除本页捐赠资料"); } }, true);
  window.addEventListener("hashchange", () => { if (!prototype) { clearPrivate(); void refresh(); } });
  document.addEventListener("visibilitychange", () => { cancel(); clearPrivate(); if (!document.hidden) void refresh(); });
  window.addEventListener("pagehide", () => { cancel(); clearPrivate(); });
  window.addEventListener("pageshow", event => { if (event.persisted) void refresh(); });
  clearPrivate(); pool(); window.lucide?.createIcons(); void refresh();
})();
