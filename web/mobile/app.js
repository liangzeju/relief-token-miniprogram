(function () {
  "use strict";
  if (location.protocol === "file:") return;
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const fmt = (value) => number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
  const mon = (value) => fmt(value) + " MON";
  const list = (value) => Array.isArray(value) ? value : [];
  const icon = (name) => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const empty = (text) => '<p class="empty">' + esc(text) + '</p>';
  const categories = ["全部", "饮水食品", "医疗物资", "安置装备", "救援服务", "灾后重建"];
  const intentKey = "relief-mobile-pending-intents-v1";
  const statusLabels = { PENDING_REVIEW: "等待管理员审核", APPROVED: "审核通过", REJECTED: "审核拒绝", MON_REVIEW_PENDING: "MON 登记待审核", MON_DEPOSIT_CONFIRMED: "演示 MON 入账已确认", MON_DEPOSIT_PENDING: "演示 MON 入账待确认", DISPATCHING: "调度中", EXECUTING: "执行中", IN_PROGRESS: "履约中", COMPLETED: "已完成", CANCELLED: "已取消", PENDING_APPROVAL: "合同待审核", FUNDS_RESERVED: "演示资金已托管", SETTLED: "已结算" };
  let state = null;
  let online = false;
  let overviewBusy = false;
  let privateBusy = false;
  let catalogBusy = false;
  let catalogEpoch = 0;
  let catalogStatus = "loading";
  let catalogError = "";
  let catalogQuotes = [];
  let catalogVersion = null;
  let catalogFetchedAt = 0;
  let profile = null;
  let accountEpoch = 0;
  let privateRevision = 0;
  let orders = [];
  let orderMessage = "";
  let category = "全部";
  let search = "";
  let selection = null;
  let ordering = false;
  let toastTimer;
  let intents = readStorage("sessionStorage", intentKey, {});
  if (!intents || typeof intents !== "object" || Array.isArray(intents)) intents = {};
  const dialogFocus = new WeakMap();

  function parsedRoute() {
    const raw = location.hash.slice(1);
    const parts = raw.split("/");
    if (parts[0] === "donation" && parts.length === 2) return { name: "account" };
    const detailParents = { article: "home", task: "tasks", resource: "market" };
    if (parts.length === 2 && detailParents[parts[0]]) {
      try { return { name: detailParents[parts[0]], kind: parts[0], id: decodeURIComponent(parts[1]) }; }
      catch (_) { return { name: detailParents[parts[0]], kind: parts[0], id: "" }; }
    }
    return { name: raw };
  }
  function detailHash(kind, id) { return "#" + kind + "/" + encodeURIComponent(id); }
  function leaveDetail() {
    const current = parsedRoute();
    if (current.kind) location.hash = current.name;
    else if ($("#detailDialog").open) $("#detailDialog").close();
  }

  function readStorage(kind, key, fallback) {
    try { return JSON.parse(window[kind].getItem(key)) || fallback; } catch (_) { return fallback; }
  }
  function icons() { if (window.lucide) window.lucide.createIcons(); }
  function status(value) { return statusLabels[value] || value || "状态待更新"; }
  function api() { if (!window.ReliefApi) throw new Error("共享 API 未加载，请检查后端服务并刷新页面"); return window.ReliefApi; }
  function request(path, options) {
    return window.ReliefWallet.request(path, options);
  }
  function safeUrl(value) {
    try { const url = new URL(value, location.origin); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch (_) { return ""; }
  }
  function imageUrl(value) {
    if (!value) return "";
    const API = api();
    const path = typeof API.image === "function" ? API.image(value) : (String(value).startsWith("/") ? API.url(value) : value);
    return safeUrl(path);
  }
  function media(value, name, extra) {
    const url = imageUrl(value);
    return url ? '<img class="media ' + (extra || "") + '" src="' + esc(url) + '" alt="' + esc(name + "（示意图）") + '" loading="lazy">' : '<div class="media-missing">暂无示意图</div>';
  }
  function legacyMode() { return !!state?.capabilities?.legacyDemoEnabled; }
  function quoteMoney(quote) { return window.ethers.formatEther(BigInt(quote.unitPriceWei)); }
  function validateCatalog(payload) {
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim().length > 0 && value === value.trim();
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    if (!object(payload) || !Array.isArray(payload.data) || !integer(payload.version)) throw new Error("报价响应格式无效");
    if (typeof window.ethers?.formatEther !== "function") throw new Error("报价金额组件未加载");
    const ids = new Set();
    const quotes = payload.data.map(quote => {
      if (!object(quote) || ![quote.id, quote.resourceId, quote.name, quote.supplierOrganizationId].every(text) ||
        ![quote.image, quote.unit, quote.category].every(value => value === null || typeof value === "string") ||
        typeof quote.unitPriceWei !== "string" || !/^[1-9][0-9]{0,77}$/.test(quote.unitPriceWei) ||
        BigInt(quote.unitPriceWei) >= (1n << 256n) || !integer(quote.availableQuantity) ||
        !integer(quote.etaHours) || !integer(quote.validUntil) || quote.validUntil === 0 ||
        quote.validUntil > 8640000000000 || ids.has(quote.id)) throw new Error("供方报价字段无效或 source ID 重复");
      ids.add(quote.id);
      return { ...quote };
    });
    return { quotes, version: payload.version };
  }
  function liveQuotes(item) {
    if (catalogStatus !== "ready" || Date.now() - catalogFetchedAt >= 10000) return [];
    return catalogQuotes.filter(quote => quote.resourceId === item.id && quote.availableQuantity > 0 && quote.validUntil > Date.now() / 1000)
      .sort((a, b) => BigInt(a.unitPriceWei) < BigInt(b.unitPriceWei) ? -1 : BigInt(a.unitPriceWei) > BigInt(b.unitPriceWei) ? 1 : a.id.localeCompare(b.id));
  }
  function quoteStatusText() {
    if (catalogStatus === "loading") return "正在读取供方报价";
    if (catalogStatus !== "ready") return "报价不可用：" + catalogError;
    if (Date.now() - catalogFetchedAt >= 10000) return "报价不可用：数据已超时，等待更新";
    return "供方报价 · 每 5 秒查询 · 最近获取 " + dateText(catalogFetchedAt) + " · 版本 " + catalogVersion;
  }
  function noQuoteText() {
    return catalogStatus === "ready" && Date.now() - catalogFetchedAt < 10000 ? "暂无有效供方报价" : quoteStatusText();
  }
  function quoteSummary(item) {
    const quotes = liveQuotes(item), lowest = quotes[0];
    if (!lowest) return '<div class="price">' + mon(item.priceMon) + ' <small>参考价 / ' + esc(item.unit) + '</small></div><span class="meta quote-state">' + esc(noQuoteText()) + '</span>';
    return '<div class="price">' + quoteMoney(lowest) + ' <small>MON / ' + esc(lowest.unit || item.unit) + ' 起</small></div><span class="meta quote-kind">供方报价 · ' + quotes.length + ' 条有效报价</span><span class="meta">此起价报价可供 ' + fmt(lowest.availableQuantity) + ' ' + esc(lowest.unit || item.unit) + ' · ETA ' + fmt(lowest.etaHours) + ' 小时</span><span class="meta">供方 ID：' + esc(lowest.supplierOrganizationId) + '</span>';
  }
  function quoteRow(quote, item) {
    return '<h3>供方 ID：' + esc(quote.supplierOrganizationId) + '</h3><p class="quote-price">' + quoteMoney(quote) + ' MON / ' + esc(quote.unit || item.unit) + '</p><dl class="detail-meta"><div><dt>报价 source ID</dt><dd><code>' + esc(quote.id) + '</code></dd></div><div><dt>资源 ID</dt><dd>' + esc(quote.resourceId) + '</dd></div><div><dt>报价可供量</dt><dd>' + fmt(quote.availableQuantity) + ' ' + esc(quote.unit || item.unit) + '</dd></div><div><dt>ETA</dt><dd>' + fmt(quote.etaHours) + ' 小时</dd></div><div><dt>有效期至（本地时间）</dt><dd><time datetime="' + new Date(quote.validUntil * 1000).toISOString() + '">' + esc(dateText(quote.validUntil * 1000)) + '</time></dd></div></dl>';
  }
  function replaceChanged(node, html) {
    if (node && node._quoteHtml !== html) { node.innerHTML = html; node._quoteHtml = html; }
  }
  function refreshQuoteViews() {
    if (!state || legacyMode()) return;
    const statusNode = $("#catalogStatus");
    if (statusNode) { statusNode.textContent = quoteStatusText(); statusNode.dataset.state = catalogStatus; }
    document.querySelectorAll("[data-quote-summary]").forEach(node => {
      const item = list(state.marketplace).find(entry => entry.id === node.dataset.quoteSummary);
      if (item) replaceChanged(node, quoteSummary(item));
    });
    const region = $("#resourceQuotes"), dialog = $("#detailDialog");
    if (!region || !dialog.open) return;
    const item = list(state.marketplace).find(entry => entry.id === region.dataset.resourceId);
    if (!item) return;
    const previousScroll = dialog.scrollTop;
    const top = dialog.getBoundingClientRect().top;
    const anchor = Array.from(region.querySelectorAll("[data-quote-id]")).find(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > top && bounds.top < top + dialog.clientHeight;
    });
    const anchorTop = anchor?.getBoundingClientRect().top;
    const quotes = liveQuotes(item), rows = region.querySelector(".quote-list");
    replaceChanged(region.querySelector(".quote-summary"), quoteSummary(item));
    region.querySelector(".quote-status").textContent = quoteStatusText();
    // Keep quote nodes and the visible reading anchor across availability updates.
    const existing = new Map(Array.from(rows.children, row => [row.dataset.quoteId, row]));
    quotes.forEach((quote, index) => {
      const row = existing.get(quote.id) || document.createElement("article");
      row.className = "supplier-quote"; row.dataset.quoteId = quote.id;
      replaceChanged(row, quoteRow(quote, item));
      if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] || null);
      existing.delete(quote.id);
    });
    existing.forEach(row => row.remove());
    dialog.scrollTop = previousScroll;
    if (anchor?.isConnected && previousScroll > 0) dialog.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
  function invalidateCatalog(message) {
    catalogStatus = "error"; catalogError = message; catalogQuotes = []; catalogVersion = null;
    refreshQuoteViews();
  }
  async function refreshCatalog() {
    if (catalogBusy) return;
    catalogBusy = true;
    const epoch = catalogEpoch;
    try {
      const result = validateCatalog(await api().request("/v1/platform/catalog", { method: "GET" }));
      if (epoch !== catalogEpoch) return;
      catalogQuotes = result.quotes; catalogVersion = result.version;
      catalogFetchedAt = Date.now(); catalogStatus = "ready"; catalogError = "";
      refreshQuoteViews();
    } catch (error) {
      if (epoch === catalogEpoch) invalidateCatalog(error.message || "读取失败");
    } finally { catalogBusy = false; }
  }
  function expireCatalog() {
    if (catalogStatus !== "ready") return;
    if (Date.now() - catalogFetchedAt >= 10000) { invalidateCatalog("数据已超时，等待更新"); return; }
    const current = catalogQuotes.filter(quote => quote.validUntil > Date.now() / 1000 && quote.availableQuantity > 0);
    if (current.length !== catalogQuotes.length) { catalogQuotes = current; refreshQuoteViews(); }
  }
  function renderCatalogLabels() {
    const legacy = legacyMode();
    $(".demo-banner strong").textContent = legacy ? "MOCK CATALOGUE · 演练物资与任务" : "资源参考目录 · 供方报价";
    $(".demo-banner span").textContent = legacy ? "商城价格、库存、新闻关联任务为演练数据；下方资金池单独展示 Monad 测试网链上资金。" : "目录图片与任务为演练参考；供方报价及可供量来自岗位报价记录，不代表机构身份认证。";
    $(".resource-band h2").textContent = legacy ? "演练物资参考价" : "资源参考与供方报价";
    $(".resource-band > .caption").textContent = legacy ? "商城估价为演练数据，不代表测试网资金购买力或库存承诺。" : "供方报价以有效期和可供量为准；参考价不代表真实库存或履约承诺。";
    let notice = $("#catalogStatus");
    if (!notice) {
      notice = document.createElement("p"); notice.id = "catalogStatus"; notice.className = "catalog-status";
      notice.setAttribute("role", "status"); $("#marketList").before(notice);
    }
    notice.hidden = legacy;
    if (!legacy) { notice.textContent = quoteStatusText(); notice.dataset.state = catalogStatus; }
  }
  function toast(text) { $("#toast").textContent = text; $("#toast").classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3500); }
  function setConnection(kind, text) { $("#connection").dataset.state = kind; $("#connectionText").textContent = text; }
  function dateText(value) { if (!value) return "更新时间未提供"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false }); }
  function taskTitle(task) { return task.title || (typeof task.location === "string" ? task.location : task.location && (task.location.name || task.location.address)) || task.id; }
  function target(task) { return number(task.poolNeedMon ?? task.monTarget); }
  function raised(task) { return number(task.allocatedMon ?? task.monRaised); }
  function gap(task) { return Math.max(0, target(task) - raised(task)); }
  function progress(value, total) { return total > 0 ? Math.min(100, value / total * 100) : 0; }
  function humanGap(task) {
    const direct = task.manpowerGap ?? task.personnelGap ?? task.humanGap;
    if (typeof direct === "number") return fmt(direct) + " 人";
    if (typeof direct === "string") return direct;
    if (task.manpowerNeed != null) return fmt(Math.max(0, number(task.manpowerNeed) - number(task.manpowerAssigned))) + " 人";
    if (task.participantTarget != null) return fmt(Math.max(0, number(task.participantTarget) - number(task.participants))) + " 人（演练参与目标）";
    const requirements = task.requirements || {};
    return requirements.manpower || requirements.personnel || list(task.gaps).filter((item) => typeof item === "string" && /人|队|班|志愿|医护/.test(item)).join("；") || "后端暂未提供人力缺口";
  }
  function eligible(task) { return (task.verified === true || task.verificationStatus === "VERIFIED") && !["COMPLETED", "CANCELLED", "REJECTED"].includes(task.status); }
  function taskCard(task, detail) {
    const ratio = progress(raised(task), target(task));
    return '<article class="task-card"><div class="task-top"><div><span class="badge ' + (task.severity === "critical" ? "danger" : "warn") + '">' + esc(task.urgencyLabel || task.disasterType || task.disaster || "救援任务") + '</span><h3>' + esc(taskTitle(task)) + '</h3></div>' + (detail ? '' : '<button class="text-button" type="button" data-task="' + esc(task.id) + '">详情</button>') + '</div><p>' + esc(task.need || (task.requirements && task.requirements.material) || "需求待补充") + '</p><div class="task-metrics"><span>资金缺口 <strong>' + mon(gap(task)) + '</strong></span><span>进度 ' + fmt(Math.round(ratio)) + '%</span></div><progress max="100" value="' + ratio + '" aria-label="任务资金进度"></progress><p class="human-gap">人力缺口 · ' + esc(humanGap(task)) + '</p><p>' + esc(status(task.status)) + ' · ' + (eligible(task) ? "演练任务已核验" : "待核验或已结束") + '</p></article>';
  }
  function renderDashboard() {
    if (window.ReliefWallet) window.ReliefWallet.renderDashboard();
    $("#updatedAt").textContent = dateText(state.updatedAt);
    const catalog = list(state.marketplace).filter((item) => number(item.priceMon) > 0);
    const picks = [];
    ["饮水食品", "医疗物资", "救援服务"].forEach((kind) => { const item = catalog.find((entry) => entry.category === kind); if (item) picks.push(item); });
    renderCatalogLabels();
    $("#resourceList").innerHTML = picks.length ? picks.map((item) => '<div class="resource-item"><a href="' + detailHash("resource", item.id) + '">' + esc(item.name) + '</a>' + (legacyMode() ? '<strong>' + mon(item.priceMon) + '</strong><span>演练参考价 / ' + esc(item.unit) + '</span>' : '<div data-quote-summary="' + esc(item.id) + '">' + quoteSummary(item) + '</div>') + '</div>').join("") : empty("暂无可用商品参考价");
    const tasks = list(state.tasks);
    $("#taskCount").textContent = tasks.length + " 项";
    $("#taskList").innerHTML = tasks.map((task) => taskCard(task)).join("") || empty("暂无救援任务");
    $("#homeTaskList").innerHTML = tasks.slice(0, 2).map((task) => taskCard(task)).join("") || empty("暂无任务缺口");
  }
  function sourceLinks(article) {
    const sources = list(article.sources).slice();
    if (article.sourceUrl) sources.unshift({ url: article.sourceUrl, name: article.sourceName || article.source || "官方来源" });
    const seen = new Set();
    const links = sources.map((source) => {
      const value = typeof source === "string" ? source : source.url || source.sourceUrl;
      const url = value && safeUrl(value);
      if (!url || seen.has(url)) return "";
      seen.add(url);
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(typeof source === "string" ? "查看来源" : source.name || source.title || source.label || "查看来源") + ' ' + icon("external-link") + '</a>';
    }).join("");
    return '<div class="source-links">' + (links || '<span class="muted">后端未提供来源链接</span>') + '</div>';
  }
  function renderArticles() {
    const articles = list(state.disasterUpdates).slice().sort((a, b) => (Date.parse(b.publishedAt || b.date) || 0) - (Date.parse(a.publishedAt || a.date) || 0));
    $("#articleList").innerHTML = articles.slice(0, 6).map((article) => '<article class="story">' + media(article.image, article.title) + '<div class="story-body"><span class="story-meta">' + esc(article.date || article.publishedAt || "") + ' · ' + esc(article.sourceName || article.source || "灾情动态") + '</span><h3>' + esc(article.title) + '</h3><p>' + esc(article.summary) + '</p>' + sourceLinks(article) + '<button type="button" class="text-button" data-article="' + esc(article.id) + '">阅读全文 ' + icon("arrow-right") + '</button></div></article>').join("") || empty("暂无灾情文章");
  }
  function renderCategories() {
    $("#categoryTabs").innerHTML = categories.map((name) => '<button type="button" role="tab" aria-controls="marketList" aria-selected="' + (name === category) + '" tabindex="' + (name === category ? "0" : "-1") + '" data-category="' + name + '">' + name + '</button>').join("");
  }
  function renderMarket() {
    if (!state) return;
    const catalog = list(state.marketplace);
    const query = search.trim().toLocaleLowerCase();
    const filtered = catalog.filter((item) => (category === "全部" || item.category === category) && [item.name, item.supplier, item.description, item.category].join(" ").toLocaleLowerCase().includes(query));
    $("#marketCount").textContent = filtered.length + " / " + catalog.length + " 件商品";
    $("#clearSearch").hidden = !search;
    $("#marketList").innerHTML = filtered.map((item) => '<article class="product">' + media(item.image, item.name) + '<div class="product-body"><span class="meta">' + esc(item.category) + '</span><h3>' + esc(item.name) + '</h3>' + (legacyMode() ? '<div class="price">' + fmt(item.priceMon) + ' <small>MON / ' + esc(item.unit) + '</small></div><span class="meta">库存 ' + fmt(item.stock) + ' ' + esc(item.unit) + ' · ETA ' + fmt(item.etaHours) + ' 小时</span><span class="meta">' + esc(item.supplier) + '</span>' : '<div class="quote-summary" data-quote-summary="' + esc(item.id) + '">' + quoteSummary(item) + '</div>') + '<button class="secondary-button" type="button" data-item="' + esc(item.id) + '">' + (!legacyMode() ? "查看供方报价" : number(item.stock) >= 1 ? "查看并申领" : "暂时缺货 · 详情") + icon("arrow-right") + '</button></div></article>').join("") || '<div class="empty">' + (catalog.length ? '没有符合条件的商品<button class="text-button" type="button" data-reset-search>清除筛选</button>' : "后端暂无上架商品") + '</div>';
    icons();
  }
  function renderAccount() {
    if (window.ReliefWallet) window.ReliefWallet.renderUser();
    const archive = $("#orderList").closest("section");
    archive.hidden = !state?.capabilities?.legacyDemoEnabled && orders.length === 0;
    archive.querySelector("h2").textContent = state?.capabilities?.legacyDemoEnabled ? "我的申领订单" : "历史演示申请";
    $("#orderStatus").textContent = profile ? orderMessage : "";
    $("#orderList").innerHTML = profile ? (orders.map(orderCard).join("") || empty(orderMessage || "暂无申领订单")) : empty("登录后查看自己的订单");
    icons();
  }
  function orderCard(order) {
    return '<article class="order"><div class="order-head"><strong>' + esc(order.itemName) + '</strong><span class="badge ' + (order.status === "REJECTED" ? "danger" : order.status === "PENDING_REVIEW" ? "warn" : "") + '">' + esc(status(order.status)) + '</span></div><code>' + esc(order.id) + '</code><p>' + esc(order.taskTitle || order.taskId) + '</p><p>数量 ' + fmt(order.quantity) + ' · 总额 ' + mon(order.totalMon) + '</p><p>合同：' + (order.contractId ? esc(order.contractId) : "尚未生成") + '</p>' + (order.contractId ? '<button class="text-button" type="button" data-contract="' + esc(order.contractId) + '">查看合同</button>' : '') + (order.reviewReason || order.reason ? '<p>审核说明：' + esc(order.reviewReason || order.reason) + '</p>' : '') + '</article>';
  }
  async function refreshOverview() {
    if (overviewBusy) return;
    overviewBusy = true;
    $("#retryBtn").disabled = true;
    try {
      const next = await api().liveData();
      if (!next || !next.dashboard || !Array.isArray(next.marketplace) || !Array.isArray(next.tasks)) throw new Error("后端概览数据不完整");
      state = next;
      online = true;
      setConnection(state.capabilities?.storage === "write-failed" ? "error" : "online", state.capabilities?.storage === "write-failed" ? "存储故障 · 只读最近成功数据 · 写入已停止" : legacyMode() ? "已连接后端 · 每 5 秒更新 · 演练数据" : "已连接后端 · 参考目录与任务每 5 秒更新");
      renderDashboard(); renderArticles(); renderMarket(); renderAccount(); refreshSelection(); openDeepLink(parsedRoute(), true); icons();
    } catch (error) {
      online = false;
      setConnection("error", "连接失败：" + error.message + (state ? "。当前为上次成功数据，等待重连。" : "。尚未取得数据，请重试。"));
      if (!state) {
        ["#resourceList", "#homeTaskList", "#taskList", "#articleList", "#marketList"].forEach((id) => { $(id).innerHTML = empty("数据未加载，请点击上方重新连接"); });
        $("#marketCount").textContent = "未连接"; $("#taskCount").textContent = "未连接";
      }
      updateOrderTotal();
    } finally { overviewBusy = false; $("#retryBtn").disabled = false; }
  }
  async function refreshPrivate() {
    if (!profile || privateBusy || ordering) return;
    privateBusy = true;
    const epoch = accountEpoch;
    const revision = privateRevision;
    try {
      const result = await request("/v1/market-orders");
      if (!profile || epoch !== accountEpoch || revision !== privateRevision) return;
      if (!Array.isArray(result.data)) throw new Error("订单数据格式不完整");
      orders = result.data; orderMessage = "";
    } catch (error) {
      if (epoch === accountEpoch && revision === privateRevision) orderMessage = "订单读取失败：" + error.message;
    } finally { privateBusy = false; if (epoch === accountEpoch) renderAccount(); }
  }
  function route() {
    const current = parsedRoute();
    const name = current.name;
    if (!["home", "market", "tasks", "account"].includes(name)) { location.replace("#home"); return; }
    document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== "view-" + name; });
    document.querySelectorAll("[data-route]").forEach((link) => { if (link.dataset.route === name) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
    if (!ordering) document.querySelectorAll("dialog[open]").forEach((dialog) => { if (dialog.id !== "detailDialog" || !current.kind) dialog.close(); });
    document.title = ({ home: "首页", market: "商城", tasks: "任务", account: "我的" }[name]) + " | Relief MON";
    window.scrollTo(0, 0);
    if (name === "account") refreshPrivate();
    if (current.kind && state) openDeepLink(current);
  }
  function openDeepLink(current = parsedRoute(), refreshing = false) {
    if (!current.kind || !state) return;
    const exists = current.kind === "article" ? list(state.disasterUpdates).some(item => item.id === current.id)
      : current.kind === "task" ? list(state.tasks).some(item => item.id === current.id)
      : list(state.marketplace).some(item => item.id === current.id);
    if (!exists) {
      selection = null;
      showDialog("#detailDialog", "内容不可用", '<p class="notice">该内容已下架、撤回或链接无效。</p><a class="primary-button" href="#' + current.name + '">返回列表</a>');
      return;
    }
    const dialog = $("#detailDialog");
    const key = detailHash(current.kind, current.id) + ":" + !!state.capabilities?.legacyDemoEnabled;
    // Overview polling must not replace an in-progress form or its saved receipt.
    if (refreshing && dialog.open && dialog.dataset.routeKey === key && current.kind === "resource") { refreshQuoteViews(); return; }
    const previousScroll = refreshing && dialog.open ? dialog.scrollTop : 0;
    dialog.dataset.routeKey = key;
    if (current.kind === "article") openArticle(current.id);
    else if (current.kind === "task") openTask(current.id);
    else openItem(current.id);
    if (refreshing) dialog.scrollTop = previousScroll;
  }
  function showDialog(id, title, html) {
    const dialog = $(id);
    if (!dialog.open) dialogFocus.set(dialog, document.activeElement);
    if (title) $("#detailTitle").textContent = title;
    if (html != null) $("#detailContent").innerHTML = html;
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0; icons();
  }
  function openLogin() {
    if (profile) { location.hash = "account"; return; }
    window.ReliefWallet.openAuth();
  }
  function openArticle(id) {
    const article = list(state && state.disasterUpdates).find((entry) => entry.id === id);
    if (!article) return toast("文章已更新，请重新加载");
    selection = null;
    const related = list(state.tasks).filter((task) => list(article.relatedTasks).includes(task.id));
    showDialog("#detailDialog", article.title, media(article.image, article.title, "detail-media") + '<p class="caption">' + esc(article.imageCaption || "图片为示意，非新闻现场照片") + ' · ' + esc(article.date || article.publishedAt || "") + '</p>' + sourceLinks(article) + '<p class="caption">统计截至 ' + esc(article.asOf || article.publishedAt || article.date || "来源未注明") + '</p><dl class="detail-meta">' + list(article.stats).map((stat) => '<div><dt>' + esc(stat.label) + '</dt><dd>' + esc(stat.value) + '</dd></div>').join("") + '</dl><div class="detail-copy"><p>' + esc(article.summary) + '</p>' + list(article.paragraphs).map((p) => '<p>' + esc(p) + '</p>').join("") + '</div>' + (related.length ? '<h3>关联演练任务</h3>' + related.map((task) => taskCard(task)).join("") : ''));
  }
  function contractHtml(contract) { return '<section class="contract-detail"><h3>' + esc(contract.subject || contract.id) + '</h3><p>' + esc(contract.id) + ' · ' + esc(status(contract.status)) + '</p><p>' + esc(contract.party || contract.supplier || "") + ' · ' + mon(contract.amountMon) + '</p><progress max="100" value="' + Math.min(100, number(contract.progress)) + '" aria-label="合同履约进度"></progress><p>演示合同，非真实链上托管证明。</p></section>'; }
  function openContract(id) {
    const contract = list(state && state.contracts).find((item) => item.id === id);
    selection = null;
    showDialog("#detailDialog", "合同详情", contract ? contractHtml(contract) : '<p>后端订单已关联合同 ' + esc(id) + '，公开概览暂未提供合同详情。</p>');
  }
  function openTask(id) {
    const task = list(state && state.tasks).find((entry) => entry.id === id);
    if (!task) return toast("任务已更新，请刷新");
    selection = null;
    const contracts = list(state.contracts).filter((entry) => entry.taskId === id);
    showDialog("#detailDialog", taskTitle(task), '<p class="caption">演练任务 · ' + esc(task.id) + '</p>' + taskCard(task, true) + '<div class="detail-copy">' + list(task.subsections || task.sections).map((part) => '<h3>' + esc(part.title) + '</h3><p>' + esc(part.value || part.body || part.detail) + '</p>').join("") + '</div><h3>资金需求</h3><p>目标 ' + mon(target(task)) + ' · 已分配 ' + mon(raised(task)) + '</p><h3>关联合同</h3>' + (contracts.map(contractHtml).join("") || '<p class="muted">暂无关联合同</p>') + '<a class="primary-button" href="#market">前往商城 ' + icon("shopping-bag") + '</a>');
  }
  function taskOptions(current) {
    return '<option value="">请选择救援任务</option>' + list(state && state.tasks).filter(eligible).map((task) => '<option value="' + esc(task.id) + '"' + (current === task.id ? ' selected' : '') + '>' + esc(taskTitle(task)) + '</option>').join("");
  }
  function openItem(id) {
    const item = list(state && state.marketplace).find((entry) => entry.id === id);
    if (!item) return toast("商品已下架，请刷新");
    if (!state?.capabilities?.legacyDemoEnabled) {
      selection = null;
      showDialog("#detailDialog", item.name, media(item.image, item.name, "detail-media") + '<p class="caption">平台资源参考目录 · 图片为示意</p><p>' + esc(item.description || "暂无资源说明") + '</p><ul class="specs">' + list(item.specs).map(spec => '<li>' + esc(spec) + '</li>').join("") + '</ul><dl class="detail-meta"><div><dt>采购主体</dt><dd>平台</dd></div></dl><section id="resourceQuotes" data-resource-id="' + esc(item.id) + '"><h3>当前有效供方报价</h3><p class="quote-status caption" role="status"></p><div class="quote-summary"></div><p class="caption">供方 ID 和 source ID 标识报价来源，不代表机构真实性或 KYC 认证。</p><div class="quote-list"></div></section><a class="primary-button" href="#home">捐赠 MON</a>');
      refreshQuoteViews();
      return;
    }
    selection = { id: id };
    showDialog("#detailDialog", item.name, media(item.image, item.name, "detail-media") + '<p class="caption">演示 MON 参考估价 · 图片为示意</p><div class="detail-price" id="detailPrice">' + mon(item.priceMon) + ' / ' + esc(item.unit) + '</div><p>' + esc(item.description || "暂无商品描述") + '</p><ul class="specs">' + list(item.specs).map((spec) => '<li>' + esc(spec) + '</li>').join("") + '</ul><dl class="detail-meta"><div><dt>供应商</dt><dd>' + esc(item.supplier) + '</dd></div><div><dt>预计到达</dt><dd>' + fmt(item.etaHours) + ' 小时</dd></div><div><dt>可申领库存</dt><dd id="detailStock">' + fmt(item.stock) + ' ' + esc(item.unit) + '</dd></div><div><dt>分类</dt><dd>' + esc(item.category) + '</dd></div></dl><form id="orderForm" class="stack-form"><fieldset id="orderFields"><label>救援任务<select id="orderTask" required>' + taskOptions("") + '</select></label><p id="taskSelectionNote" class="caption"></p><label for="orderQuantity">申领数量（' + esc(item.unit) + '）</label><div class="stepper"><button type="button" id="quantityMinus" class="icon-button" title="减少数量" aria-label="减少数量">' + icon("minus") + '</button><input id="orderQuantity" type="number" min="1" step="1" max="' + Math.floor(number(item.stock)) + '" value="1" required inputmode="numeric"><button type="button" id="quantityPlus" class="icon-button" title="增加数量" aria-label="增加数量">' + icon("plus") + '</button></div><div class="order-total"><span>预计总额</span><strong id="orderTotal">' + mon(item.priceMon) + '</strong></div><button class="primary-button" id="orderSubmit" type="submit">提交申领</button></fieldset><p id="orderResult" class="form-result" role="status"></p></form>');
    $("#orderTask").addEventListener("change", updateOrderTotal);
    $("#orderQuantity").addEventListener("input", updateOrderTotal);
    $("#quantityMinus").addEventListener("click", () => stepQuantity(-1));
    $("#quantityPlus").addEventListener("click", () => stepQuantity(1));
    $("#orderForm").addEventListener("submit", submitOrder);
    updateOrderTotal();
  }
  function selectedItem() { return selection && list(state && state.marketplace).find((item) => item.id === selection.id); }
  function refreshSelection() {
    if (!selection || !$("#orderForm") || ordering) return;
    const item = selectedItem();
    const currentTask = $("#orderTask").value;
    const options = taskOptions(currentTask);
    if ($("#orderTask").dataset.options !== options) { $("#orderTask").innerHTML = options; $("#orderTask").dataset.options = options; }
    $("#detailStock").textContent = item ? fmt(item.stock) + " " + item.unit : "商品已下架";
    $("#detailPrice").textContent = item ? mon(item.priceMon) + " / " + item.unit : "暂无报价";
    $("#orderQuantity").max = item ? Math.floor(number(item.stock)) : 0;
    updateOrderTotal();
  }
  function stepQuantity(delta) {
    const input = $("#orderQuantity");
    input.value = Math.max(1, Math.min(Math.floor(number(selectedItem() && selectedItem().stock)), (Number(input.value) || 1) + delta));
    updateOrderTotal();
  }
  function updateOrderTotal() {
    if (!selection || !$("#orderForm")) return;
    const item = selectedItem();
    const quantity = Number($("#orderQuantity").value);
    const stock = item ? Math.floor(number(item.stock)) : 0;
    const validQuantity = Number.isSafeInteger(quantity) && quantity > 0 && quantity <= stock;
    const task = list(state && state.tasks).find((entry) => entry.id === $("#orderTask").value && eligible(entry));
    const total = item ? quantity * number(item.priceMon) : 0;
    $("#orderTotal").textContent = Number.isFinite(total) && quantity > 0 ? mon(total) : "—";
    $("#quantityMinus").disabled = ordering || quantity <= 1;
    $("#quantityPlus").disabled = ordering || quantity >= stock;
    $("#orderSubmit").disabled = ordering || !online || !item || !validQuantity || !task || !Number.isFinite(total) || number(item.priceMon) <= 0;
    $("#orderSubmit").textContent = ordering ? "正在提交…" : !online ? "等待连接恢复" : !stock ? "暂时缺货" : profile ? "提交申领" : "登录后申领";
    $("#taskSelectionNote").textContent = list(state && state.tasks).some(eligible) ? "申领须经管理员审核，审核后关联演示合同。" : "暂无可申领的已核验任务。";
  }
  // Retry keys survive closing a dialog or reloading, but clear after a confirmed response.
  function intentFor(path, body) {
    const fingerprint = (profile && profile.id || "anonymous") + ":" + path + ":" + JSON.stringify(body);
    if (!intents[fingerprint]) {
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      intents[fingerprint] = "mobile-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      try { sessionStorage.setItem(intentKey, JSON.stringify(intents)); } catch (_) { /* In-memory retry keys still protect this page session. */ }
    }
    return { fingerprint: fingerprint, key: intents[fingerprint] };
  }
  function clearIntent(intent) { delete intents[intent.fingerprint]; try { sessionStorage.setItem(intentKey, JSON.stringify(intents)); } catch (_) { /* Storage may be disabled. */ } }
  async function submitOrder(event) {
    event.preventDefault();
    if (ordering) return;
    if (!profile) { openLogin(); return; }
    updateOrderTotal();
    if ($("#orderSubmit").disabled || !$("#orderForm").reportValidity()) return;
    const body = { itemId: selection.id, taskId: $("#orderTask").value, quantity: Number($("#orderQuantity").value) };
    const intent = intentFor("/v1/market-orders", body);
    const epoch = accountEpoch;
    ordering = true; privateRevision++; $("#orderFields").disabled = true; updateOrderTotal();
    $("#orderResult").className = "form-result"; $("#orderResult").textContent = "正在提交后端审核…";
    try {
      const response = await request("/v1/market-orders", { method: "POST", headers: { "Idempotency-Key": intent.key }, body: JSON.stringify(body) });
      if (epoch !== accountEpoch || !profile) return;
      const order = response.data;
      if (!order || !order.id || !["PENDING_REVIEW", "APPROVED", "REJECTED"].includes(order.status)) throw new Error("后端未返回有效订单，结果待确认，请使用相同内容重试");
      clearIntent(intent);
      orders = [order].concat(orders.filter((entry) => entry.id !== order.id));
      orderMessage = ""; selection = null;
      $("#detailTitle").textContent = status(order.status);
      $("#detailContent").innerHTML = '<p class="notice">演练申领已由后端记录，审批结果与合同以后台处理为准。</p>' + orderCard(order) + '<a class="primary-button" href="#account">查看我的订单 ' + icon("arrow-right") + '</a>';
      renderAccount(); icons(); refreshOverview();
    } catch (error) {
      if (epoch !== accountEpoch || !profile) return;
      $("#orderResult").className = "form-result error";
      $("#orderResult").textContent = "提交未确认：" + error.message + "。可查看我的订单，或原样重试；相同请求沿用幂等键。";
    } finally { ordering = false; if ($("#orderFields")) $("#orderFields").disabled = false; refreshSelection(); refreshPrivate(); }
  }
  $("#loginOpenBtn").addEventListener("click", openLogin);
  window.addEventListener("relief:wallet-user", (event) => {
    const next = event.detail;
    if ((profile && profile.id) !== (next && next.id)) { accountEpoch++; orders = []; orderMessage = ""; }
    profile = next;
    renderAccount(); updateOrderTotal(); refreshPrivate();
  });
  $("#retryBtn").addEventListener("click", () => { refreshOverview(); refreshPrivate(); refreshCatalog(); });
  $("#accountRetry").addEventListener("click", () => profile ? refreshPrivate() : openLogin());
  $("#marketSearch").addEventListener("input", (event) => { search = event.target.value; renderMarket(); });
  function resetSearch() { search = ""; category = "全部"; $("#marketSearch").value = ""; renderCategories(); renderMarket(); }
  $("#clearSearch").addEventListener("click", () => { search = ""; $("#marketSearch").value = ""; renderMarket(); $("#marketSearch").focus(); });
  $("#categoryTabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let index = categories.indexOf(category);
    index = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + categories.length) % categories.length;
    category = categories[index]; renderCategories(); renderMarket(); $("#categoryTabs [aria-selected=true]").focus();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-close")) { if (ordering && button.closest("#detailDialog")) return; if (button.closest("#detailDialog")) leaveDetail(); else button.closest("dialog").close(); }
    if (button.dataset.category) { category = button.dataset.category; renderCategories(); renderMarket(); $("#categoryTabs [aria-selected=true]").focus(); }
    if (button.dataset.item) location.hash = detailHash("resource", button.dataset.item);
    if (button.dataset.article) location.hash = detailHash("article", button.dataset.article);
    if (button.dataset.task) location.hash = detailHash("task", button.dataset.task);
    if (button.dataset.contract) openContract(button.dataset.contract);
    if (button.hasAttribute("data-reset-search")) resetSearch();
  });
  document.addEventListener("error", (event) => {
    if (event.target.tagName !== "IMG") return;
    const replacement = document.createElement("div"); replacement.className = "media-missing"; replacement.textContent = "示意图暂不可用"; event.target.replaceWith(replacement);
  }, true);
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("cancel", (event) => { if (dialog.id === "detailDialog" && (ordering || parsedRoute().kind)) { event.preventDefault(); if (!ordering) leaveDetail(); } });
    dialog.addEventListener("close", () => { if (dialog.id === "detailDialog" && !ordering) selection = null; const previous = dialogFocus.get(dialog); if (previous && previous.isConnected) previous.focus(); });
    dialog.addEventListener("click", (event) => { if (event.target !== dialog || ordering) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { if (dialog.id === "detailDialog") leaveDetail(); else dialog.close(); } });
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("online", () => { refreshOverview(); refreshPrivate(); refreshCatalog(); });
  window.addEventListener("offline", () => { catalogEpoch++; invalidateCatalog("网络已断开"); online = false; setConnection("error", "网络已断开，当前数据可能已过期；恢复连接后自动重试。"); updateOrderTotal(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { expireCatalog(); refreshCatalog(); } });
  renderCategories(); renderAccount(); renderCatalogLabels(); icons(); route(); refreshOverview(); refreshPrivate(); refreshCatalog();
  setInterval(() => { refreshOverview(); refreshPrivate(); }, 5000);
  setInterval(refreshCatalog, 5000);
  setInterval(expireCatalog, 1000);
}());
