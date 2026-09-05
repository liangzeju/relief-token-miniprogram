(function () {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const list = (value) => Array.isArray(value) ? value : [];
  const lower = (value) => String(value || "").toLowerCase();
  const addressOK = (value) => /^0x[0-9a-f]{40}$/i.test(value || "") && !/^0x0{40}$/i.test(value);
  const hashOK = (value) => /^0x[0-9a-f]{64}$/i.test(value || "");
  const chainOK = (value) => /^0x[0-9a-f]+$/i.test(value || "") && BigInt(value) === 10143n;
  const sameAddress = (a, b) => addressOK(a) && addressOK(b) && lower(a) === lower(b);
  // Minimal ABI from ReliefPool: recovery checks the call and its receipt together.
  async function verifyActionRecovery(record, txHash, selected, ethers, confirmations) {
    const fail = (message) => { throw new Error(message); };
    const quantity = (value) => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : fail("链上交易数据不完整，请稍后重试");
    const method = record.action === "refund" ? "refundUnallocated" : record.action === "reallocate" ? "allocateRemaining" : null;
    const expected = record.transaction;
    if (!method || !hashOK(record.id) || !hashOK(txHash) || !expected || !chainOK(expected.chainId) || !sameAddress(expected.from, record.wallet) || !addressOK(expected.to) || quantity(expected.value) !== 0n) fail("恢复记录的交易参数无效");
    if (!selected || !chainOK(await selected.request({ method: "eth_chainId" }))) fail("请连接 Monad Testnet 后查询");
    if (!ethers || typeof ethers.Interface !== "function") fail("钱包交易校验组件未加载，请刷新页面");
    const iface = new ethers.Interface([
      "function refundUnallocated(bytes32 donationId)",
      "function allocateRemaining(bytes32 donationId)",
      "event DonationRefunded(bytes32 indexed donationId, address indexed donor, uint256 amountWei)",
      "event DonationAllocated(bytes32 indexed donationId, bytes32 indexed taskId, uint256 amountWei)"
    ]);
    const calldata = iface.encodeFunctionData(method, [record.id]);
    if (lower(expected.data) !== lower(calldata)) fail("恢复记录的调用方法或捐赠编号不匹配");
    const tx = await selected.request({ method: "eth_getTransactionByHash", params: [txHash] });
    if (!tx) fail("尚未查询到交易，请核对哈希后稍后重试");
    if (!chainOK(tx.chainId) || lower(tx.hash) !== lower(txHash) || !sameAddress(tx.from, record.wallet) || !sameAddress(tx.to, expected.to) || quantity(tx.value) !== 0n || lower(tx.input) !== lower(calldata)) fail("交易的网络、调用方法或捐赠编号与恢复记录不匹配");
    const receipt = await selected.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (!receipt || tx.blockNumber == null || receipt.blockNumber == null) fail("交易尚未出块，请稍后查询");
    if (lower(receipt.transactionHash) !== lower(txHash) || !sameAddress(receipt.from, record.wallet) || !sameAddress(receipt.to, expected.to) || !hashOK(receipt.blockHash) || lower(tx.blockHash) !== lower(receipt.blockHash) || quantity(tx.blockNumber) !== quantity(receipt.blockNumber)) fail("交易回执与恢复记录不匹配");
    const head = await selected.request({ method: "eth_blockNumber" });
    const required = confirmations == null ? 2 : Number(confirmations);
    if (!Number.isSafeInteger(required) || required < 1) fail("链上确认配置无效");
    if (quantity(head) - quantity(receipt.blockNumber) + 1n < BigInt(required)) fail("交易仍在等待确认");
    const block = await selected.request({ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] });
    if (!block || lower(block.hash) !== lower(receipt.blockHash)) fail("交易所在区块已变化，请稍后重新核验");
    if (!chainOK(await selected.request({ method: "eth_chainId" }))) fail("网络已变化，请连接 Monad Testnet 后重新查询");
    if (quantity(receipt.status) !== 1n) fail("合约调用失败，恢复记录已保留，资金数额未增加");
    if (!Array.isArray(receipt.logs)) fail("交易事件数据不完整，请稍后重试");
    let eventCount = 0;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, expected.to)) continue;
      let event;
      try { event = iface.parseLog(log); } catch (_) { fail("交易事件无法校验，恢复记录已保留"); }
      const eventName = record.action === "refund" ? "DonationRefunded" : "DonationAllocated";
      if (log.removed || !event || event.name !== eventName || lower(event.args.donationId) !== lower(record.id) || event.args.amountWei <= 0n) fail("交易事件与恢复记录不匹配");
      if (record.action === "refund" && !sameAddress(event.args.donor, record.wallet)) fail("退款事件的捐赠人与恢复记录不匹配");
      if (record.action === "reallocate" && (!hashOK(event.args.taskId) || /^0x0{64}$/i.test(event.args.taskId))) fail("分配事件的任务编号无效");
      eventCount++;
    }
    if (record.action === "refund" && eventCount !== 1) fail("未找到唯一匹配的退款事件，恢复记录已保留");
    // allocateRemaining emits nothing when no funds can be allocated.
    return { noAllocation: record.action === "reallocate" && eventCount === 0 };
  }
  if (typeof module === "object" && module.exports) {
    module.exports = { verifyActionRecovery };
    return;
  }
  if (location.protocol === "file:") return;
  const labels = { AWAITING_SIGNATURE: "等待钱包授权", SUBMITTED: "已提交，等待链上确认", CONFIRMING: "链上确认中", CONFIRMED: "已确认", FAILED: "失败", REORGED: "链重组，重新核验中" };
  const storageKey = "relief-wallet-pending-v1";
  let config = null, dashboard = null, me = { user: null, donations: [], totals: {} };
  let configError = "", dashboardError = "", meError = "";
  let emailMode = null, emailModeError = "";
  let provider = null, announced = null, address = "", chain = "", balance = null;
  let walletEpoch = 0, authEpoch = 0, connectionEpoch = 0, refreshVersion = 0;
  let walletBusy = false, authBusy = false, refreshing = false, refreshAgain = false;
  let authMode = "login", preview = null, stream = null, streamOpen = false, lastFetch = 0;
  let pending = readPending(), prepareIntent = null;
  const retrying = new Set();
  const boundAddress = () => me.user && (typeof me.user.wallet === "string" ? me.user.wallet : me.user.wallet && me.user.wallet.address || me.user.address);
  const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const icons = () => { if (window.lucide) window.lucide.createIcons(); };
  function displayMon(value) {
    const text = String(value == null ? "0" : value);
    if (!/^\d+(\.\d+)?$/.test(text)) return "0";
    const parts = text.split(".");
    const fraction = (parts[1] || "").replace(/0+$/, "");
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
  }
  function parseAmount(value) {
    if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error("金额须为正数，最多 18 位小数，不支持科学计数法");
    if (!window.ethers || typeof window.ethers.parseEther !== "function") throw new Error("钱包金额组件未加载，请刷新页面");
    const wei = window.ethers.parseEther(value);
    if (wei <= 0n || wei >= (1n << 256n)) throw new Error("请输入有效的正数 MON 金额");
    return wei;
  }
  function newKey() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return "wallet-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // This transport deliberately bypasses older shared clients that attach demo tokens.
  async function request(path, options) {
    options = options || {};
    if (!path.startsWith("/v1/")) throw new Error("请求地址无效");
    const headers = new Headers(options.headers || {});
    headers.delete("Authorization");
    if (options.body != null) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, Object.assign({}, options, { headers, credentials: "same-origin", cache: "no-store", signal: controller.signal }));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload.error || {};
        const error = new Error(detail.message || "服务请求失败（" + response.status + "）");
        error.status = response.status; error.code = detail.code;
        throw error;
      }
      if (!("data" in payload)) throw new Error("服务返回的数据不完整");
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请稍后重试");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const get = async (path) => (await request("/v1/wallet/" + path)).data;
  const post = async (path, body, key) => (await request("/v1/wallet/" + path, { method: "POST", body: JSON.stringify(body), headers: key ? { "Idempotency-Key": key } : {} })).data;
  function readPending() {
    try { return list(JSON.parse(localStorage.getItem(storageKey))).filter((r) => r && typeof r.id === "string" && typeof r.userId === "string" && typeof r.submitKey === "string" && (!r.txHash || hashOK(r.txHash))); }
    catch (_) { return []; }
  }
  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(pending));
  }
  function saveRecord(record, required) {
    const index = pending.findIndex((r) => r.submitKey === record.submitKey);
    if (index === -1) pending.push(record); else pending[index] = record;
    try { persist(); } catch (_) {
      if (required) throw new Error("浏览器无法保存交易恢复记录，请允许本站本地存储后重试");
      notice("#donateResult", "交易记录暂存于本页，请勿关闭页面。交易哈希：" + (record.txHash || "等待钱包返回"), true);
    }
    renderPending();
  }
  function removeRecord(record) {
    pending = pending.filter((r) => r.submitKey !== record.submitKey);
    try { persist(); } catch (_) { /* A retained retry is idempotent. */ }
    renderPending();
  }
  function notice(id, message, error) {
    setText(id, message); $(id).classList.toggle("error", !!error);
  }
  function errorText(error) {
    const code = Number(error.code || error.data && error.data.originalError && error.data.originalError.code);
    if (code === 4001) return "已取消钱包授权，未增加任何已确认余额。";
    if (code === -32002) return "MetaMask 中已有待处理请求，请打开扩展完成或取消。";
    return error.message || "操作失败，请重试";
  }
  function explorerLink(hash, title, type) {
    if (type === "address" ? !addressOK(hash) : !hashOK(hash)) return esc(title || hash);
    let base = "https://testnet.monadexplorer.com";
    try { const url = new URL(config && config.explorerUrl || base); if (url.protocol === "https:") base = url.origin + url.pathname.replace(/\/$/, ""); } catch (_) { /* Use the testnet explorer. */ }
    return '<a href="' + esc(base + "/" + (type || "tx") + "/" + hash) + '" target="_blank" rel="noopener noreferrer">' + esc(title || hash) + ' <i data-lucide="external-link" aria-hidden="true"></i></a>';
  }
  function chainReady() {
    return !!(config && config.ready && Number(config.chainId) === 10143 && chainOK(config.chainHex) && addressOK(config.contractAddress) && dashboard && dashboard.ready && Number(dashboard.chainId) === 10143 && sameAddress(config.contractAddress, dashboard.contractAddress) && !configError && !dashboardError);
  }
  function unavailableReason() {
    if (!config || configError) return configError || "正在读取测试网配置";
    if (!config.contractAddress) return "未部署 · 尚未部署资金池合约，捐赠暂不可用";
    if (!chainReady()) return dashboardError || config.reason || dashboard && dashboard.reason || "等待链上同步";
    if (!me.user) return "请先登录或注册账户";
    if (meError) return "账户资料暂不可用，请刷新后重试";
    if (!address) return "请先在首页连接 MetaMask";
    if (!chainOK(chain)) return "请连接并切换到 Monad Testnet";
    if (!boundAddress()) return "请在首页签名绑定钱包";
    if (!sameAddress(address, boundAddress())) return "当前钱包与账户绑定地址不一致，请在 MetaMask 切换账户";
    return "";
  }
  function newDonationBlockReason(current = config) {
    return current && current.newOperationsEnabled === false ? current.operationBlockReason || "新捐赠暂未开放，请等待平台配置完成" : "";
  }
  function renderDashboard() {
    if (!config || config.newOperationsEnabled !== true) return;
    const deployed = config && addressOK(config.contractAddress);
    const totals = deployed && dashboard ? dashboard.totals || {} : {};
    setText("#poolMonValue", displayMon(totals.donatedMon));
    setText("#escrowMonValue", displayMon(totals.balanceMon));
    setText("#availableMonValue", displayMon(totals.unallocatedMon));
    setText("#participantValue", String(totals.donorCount || 0));
    const status = dashboard && dashboard.syncStatus;
    const syncLabel = configError || dashboardError ? "服务不可用" : !config ? "待配置" : !deployed ? "未部署" : status === "RPC_ERROR" ? "RPC不可用" : chainReady() ? "已同步" : "同步中";
    setText("#walletSyncStatus", syncLabel);
    $("#walletSyncStatus").classList.toggle("danger", !!(configError || dashboardError || status === "RPC_ERROR"));
    setText("#poolProgressText", "已分配 " + displayMon(totals.allocatedMon) + " MON");
    setText("#poolTargetText", "未分配 " + displayMon(totals.unallocatedMon) + " MON");
    let ratio = 0;
    try {
      const donated = window.ethers.parseEther(String(totals.donatedMon || "0"));
      const allocated = window.ethers.parseEther(String(totals.allocatedMon || "0"));
      ratio = donated > 0n ? Number(allocated * 10000n / donated) / 100 : 0;
    } catch (_) { /* Missing amounts have zero progress. */ }
    $("#poolProgress").value = Math.max(0, Math.min(100, ratio));
    const synced = dashboard && dashboard.lastSyncedAt;
    const syncTime = synced && Number.isFinite(Date.parse(synced)) ? new Date(synced).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
    setText("#poolGapText", !deployed ? (configError || "尚未部署资金池合约 · 0 MON · 待配置") : (dashboardError || configError || dashboard.reason || "仅统计达到 " + (config.confirmations || 2) + " 次确认的捐赠") + " · " + syncTime + (dashboard && dashboard.confirmedBlock != null ? " · 确认区块 " + dashboard.confirmedBlock : ""));
    $("#walletContract").innerHTML = deployed ? "收款合约：" + explorerLink(config.contractAddress, config.contractAddress, "address") : "收款合约：待配置";
  }
  function renderWallet() {
    setText("#walletAddress", address || "尚未连接钱包");
    setText("#walletNetwork", address ? (chainOK(chain) ? "Monad Testnet" : "网络不匹配") : "未连接");
    setText("#walletConnect span", walletBusy ? "正在处理…" : address && chainOK(chain) ? "重新连接 MetaMask" : address ? "切换 Monad Testnet" : "连接 MetaMask");
    $("#walletConnect").disabled = walletBusy || authBusy;
    $("#walletInstall").hidden = !!(provider || announced || injected());
    $("#walletBind").hidden = !me.user || !!boundAddress();
    $("#walletBind").disabled = walletBusy || authBusy || !!meError || !address || !chainOK(chain);
    setText("#walletBalance", balance == null ? (address ? "待读取" : "未连接") : displayMon(balance) + " MON");
    const reason = unavailableReason();
    const donationReason = newDonationBlockReason() || reason;
    setText("#donationAvailability", donationReason || "原生 MON · 链上确认后计入资金池");
    $("#donateFields").disabled = !!donationReason || walletBusy || authBusy || !!preview;
    $("#donationSend").disabled = walletBusy || authBusy || !!reason || !preview || (!preview.action && !!newDonationBlockReason());
    $("#donationCancel").disabled = walletBusy;
    $("#logoutBtn").disabled = walletBusy || authBusy;
    $("#accountAuth").disabled = walletBusy || authBusy;
    $("#authFields").disabled = authBusy || walletBusy;
    $("#authLoginTab").disabled = authBusy || walletBusy;
    $("#authRegisterTab").disabled = authBusy || walletBusy;
    renderEmailControls();
  }
  function renderEmailControls() {
    const busy = authBusy || walletBusy, enabled = emailMode === "local-test" && !emailModeError;
    const note = emailModeError ? "邮箱服务配置读取失败：" + emailModeError : emailMode === "local-test"
      ? "本地测试邮箱 · 不发送真实邮件，验证码由管理员另行提供；不代表身份认证。"
      : emailMode === "disabled" ? "邮箱服务未启用，暂不可获取验证码或重置密码。" : "正在读取邮箱服务配置…";
    setText("#emailModeNote", note); setText("#passwordModeNote", note);
    $("#emailVerification").hidden = !me.user;
    $("#emailFields").disabled = busy || !enabled || !me.user || !!meError || me.user.emailTestVerified === true;
    $("#passwordFields").disabled = busy || !enabled || !!me.user;
    $("#forgotPassword").hidden = authMode !== "login";
    $("#forgotPassword").disabled = busy;
    $("#passwordBack").disabled = busy;
  }
  function allocationHtml(items) {
    return list(items).map((a) => '<div class="allocation-row"><strong>' + esc(a.title || a.taskId) + '</strong><span>' + displayMon(a.amountMon) + ' MON</span><code>' + esc(a.taskId || "") + '</code>' + (a.txHash ? explorerLink(a.txHash, "分配交易") : "") + '</div>').join("") || '<p class="muted">暂无任务分配</p>';
  }
  function donationCard(d) {
    let canAct = false;
    try { canAct = d.status === "CONFIRMED" && window.ethers.parseEther(String(d.unallocatedMon || "0")) > 0n; } catch (_) { /* No balance means no action. */ }
    return '<article class="order"><div class="order-head"><strong>' + displayMon(d.amountMon) + ' MON</strong><span class="badge' + (["FAILED", "REORGED"].includes(d.status) ? ' danger' : '') + '">' + esc(labels[d.status] || d.status || "等待更新") + '</span></div><code>' + esc(d.id) + '</code><p>用途：' + esc(purposeLabel(d.purpose)) + '</p>' + (d.txHash ? '<p>' + explorerLink(d.txHash, d.txHash) + '</p>' : '') + (d.reason || d.error || d.failureReason ? '<p>' + esc(d.reason || d.error || d.failureReason) + '</p>' : '') + allocationHtml(d.allocations) + '<p>未分配：' + displayMon(d.unallocatedMon) + ' MON · 已退回：' + displayMon(d.refundedMon) + ' MON</p>' + (canAct ? '<div class="wallet-actions"><button class="secondary-button" type="button" data-donation-action="reallocate" data-id="' + esc(d.id) + '">继续按用途分配</button><button class="secondary-button" type="button" data-donation-action="refund" data-id="' + esc(d.id) + '">退回未分配 MON</button></div>' : '') + '</article>';
  }
  function purposeLabel(value) {
    const item = list(config && config.purposes).find((p) => Number(p.id) === Number(value));
    return item ? item.label : ["不限用途", "饮水食品", "医疗", "安置", "救援", "重建"][Number(value)] || String(value);
  }
  function renderUser() {
    const user = me.user, totals = user ? me.totals || {} : {};
    setText("#loginOpenBtn span", user ? "我的账户" : "登录 / 注册");
    $("#logoutBtn").hidden = !user; $("#accountAuth").hidden = !!user;
    setText("#accountName", user ? user.name : "未登录");
    setText("#accountIdentity", user ? user.email + " · " + (user.emailTestVerified === true ? "测试邮箱已验证" : "邮箱未验证") + (user.organization ? " · " + user.organization : "") : "登录或注册以查询个人链上记录");
    setText("#accountWallet", user ? "绑定钱包：" + (boundAddress() || "尚未绑定") : "");
    if (config && config.newOperationsEnabled === true) {
    setText("#homeEscrow", displayMon(totals.donatedMon) + " MON");
    setText("#accountEscrow", displayMon(totals.donatedMon) + " MON");
    setText("#accountAllocated", displayMon(totals.allocatedMon) + " MON");
    setText("#accountAvailable", displayMon(totals.unallocatedMon) + " MON");
    setText("#homeAccountNote", meError ? "账户数据读取失败，等待刷新" : user ? "个人链上确认记录" : "登录后查询个人记录");
    setText("#accountStatus", meError || (user ? "仅已确认捐赠计入累计金额" : "登录后查询个人记录"));
    $("#donationList").innerHTML = user ? list(me.donations).map(donationCard).join("") || '<p class="empty">暂无捐赠记录</p>' : '<p class="empty">登录后查询</p>';
    }
    renderPending(); renderWallet(); icons();
  }
  function setMe(next) {
    const oldUser = me.user;
    me = { user: next.user || null, donations: list(next.donations), totals: next.totals || {} };
    if ((oldUser && oldUser.id) !== (me.user && me.user.id) || (oldUser && oldUser.email) !== (me.user && me.user.email)) {
      authEpoch++;
      $("#emailVerifyForm").reset(); $("#passwordResetForm").reset();
      notice("#emailResult", ""); notice("#passwordResult", "");
    }
    if ((oldUser && oldUser.id) !== (me.user && me.user.id) || lower(oldUser && oldUser.wallet) !== lower(boundAddress())) invalidate();
    meError = "";
    window.dispatchEvent(new CustomEvent("relief:wallet-user", { detail: me.user }));
    renderUser();
  }
  function invalidate(message) {
    walletEpoch++; preview = null; $("#donationPreview").hidden = true;
    if (message) notice("#walletNotice", message, true);
  }
  function guard(ticket) {
    if (ticket.wallet !== walletEpoch || ticket.auth !== authEpoch || ticket.provider !== provider || !me.user || ticket.userId !== me.user.id) {
      const error = new Error("账户、钱包或网络已变化，本次操作已停止，请重新确认"); error.code = "STALE"; throw error;
    }
  }
  const ticketNow = () => ({ wallet: walletEpoch, auth: authEpoch, provider, userId: me.user && me.user.id });
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true; const version = ++refreshVersion, auth = authEpoch;
    try {
      const results = await Promise.allSettled([get("config"), get("dashboard"), get("me"), get("auth-config")]);
      if (version !== refreshVersion) return;
      if (results[0].status === "fulfilled") {
        const next = results[0].value;
        if (config && (lower(config.contractAddress) !== lower(next.contractAddress) || config.chainId !== next.chainId || config.ready && !next.ready)) invalidate("链上配置已更新，请重新预览捐赠");
        config = next; configError = "";
        const purposes = list(config.purposes).filter((p) => Number.isInteger(p.id) && p.id >= 0 && p.id <= 5);
        if (purposes.length) {
          const select = $("#donationPurpose"), current = select.value;
          select.innerHTML = purposes.map((p) => '<option value="' + p.id + '">' + esc(p.label) + '</option>').join("");
          if (purposes.some((p) => String(p.id) === current)) select.value = current;
        }
      } else configError = results[0].reason.message;
      if (results[1].status === "fulfilled") { dashboard = results[1].value; dashboardError = ""; }
      else dashboardError = results[1].reason.message;
      if (results[3].status === "fulfilled" && ["local-test", "disabled"].includes(results[3].value && results[3].value.emailMode)) {
        emailMode = results[3].value.emailMode; emailModeError = "";
      } else {
        emailMode = null; emailModeError = results[3].status === "rejected" ? errorText(results[3].reason) : "服务返回的邮箱模式无效";
      }
      if (auth === authEpoch && !authBusy) {
        if (results[2].status === "fulfilled") setMe(results[2].value);
        else { meError = results[2].reason.message; if (results[2].reason.status === 401) setMe({ user: null }); }
      }
      lastFetch = Date.now(); renderDashboard(); renderUser();
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }
  function injected() {
    const eth = window.ethereum;
    return list(eth && eth.providers).find((p) => p.isMetaMask) || (eth && eth.isMetaMask ? eth : null);
  }
  function adopt(next) {
    if (!next || next === provider) return;
    if (provider && typeof provider.removeListener === "function") {
      provider.removeListener("accountsChanged", accountsChanged); provider.removeListener("chainChanged", chainChanged); provider.removeListener("disconnect", disconnected);
    }
    provider = next; invalidate(); address = ""; chain = ""; balance = null;
    if (typeof provider.on === "function") {
      provider.on("accountsChanged", accountsChanged); provider.on("chainChanged", chainChanged); provider.on("disconnect", disconnected);
    }
  }
  function accountsChanged(accounts) {
    address = addressOK(list(accounts)[0]) ? accounts[0] : ""; balance = null;
    invalidate(address ? "钱包账户已变化，请核对绑定地址" : "钱包已断开授权"); renderWallet(); void readBalance();
  }
  function chainChanged(value) {
    chain = value; balance = null;
    invalidate(chainOK(value) ? "已切换到 Monad Testnet，请重新确认当前操作" : "网络已变化，请切换回 Monad Testnet"); renderWallet(); void readBalance();
  }
  function disconnected() {
    connectionEpoch++; address = ""; chain = ""; balance = null;
    invalidate("MetaMask 已断开连接，请重新连接"); renderWallet();
  }
  async function readBalance() {
    if (!provider || !address || !chainOK(chain)) return;
    const epoch = walletEpoch, selected = provider, account = address;
    try {
      const value = await selected.request({ method: "eth_getBalance", params: [account, "latest"] });
      if (epoch === walletEpoch && selected === provider && window.ethers) { balance = window.ethers.formatEther(value); renderWallet(); }
    } catch (_) { if (epoch === walletEpoch) { balance = null; setText("#walletBalance", "余额读取失败"); } }
  }
  async function connect() {
    if (walletBusy || authBusy) return;
    const selected = announced || injected();
    if (!selected) { $("#walletInstall").hidden = false; notice("#walletNotice", "请用已安装扩展的Chrome/Edge打开本页", true); return; }
    adopt(selected); walletBusy = true; const connection = ++connectionEpoch;
    notice("#walletNotice", "请在 MetaMask 中确认连接"); renderWallet();
    try {
      await selected.request({ method: "eth_requestAccounts" });
      if (connection !== connectionEpoch || selected !== provider) return;
      if (!chainOK(await selected.request({ method: "eth_chainId" }))) {
        try { await selected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }); }
        catch (error) {
          if (Number(error.code || error.data && error.data.originalError && error.data.originalError.code) !== 4902) throw error;
          if (connection !== connectionEpoch || selected !== provider) return;
          await selected.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x279f", chainName: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: ["https://testnet-rpc.monad.xyz"], blockExplorerUrls: ["https://testnet.monadexplorer.com"] }] });
          if (connection !== connectionEpoch || selected !== provider) return;
          await selected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] });
        }
      }
      if (connection !== connectionEpoch || selected !== provider) return;
      const epoch = walletEpoch;
      const accounts = await selected.request({ method: "eth_accounts" });
      const network = await selected.request({ method: "eth_chainId" });
      if (connection !== connectionEpoch || epoch !== walletEpoch || selected !== provider) throw new Error("钱包状态已变化，请重新连接");
      address = addressOK(list(accounts)[0]) ? accounts[0] : ""; chain = network;
      if (!address || !chainOK(chain)) throw new Error("请授权一个 MetaMask 账户，并选择 Monad Testnet");
      notice("#walletNotice", me.user ? boundAddress() ? (sameAddress(address, boundAddress()) ? "已连接账户绑定钱包" : "当前钱包与账户绑定地址不一致") : "钱包已连接，请点击签名绑定钱包" : "钱包已连接。登录或注册后可签名绑定。无交易被发送。", !!(boundAddress() && !sameAddress(address, boundAddress())));
      void readBalance();
    } catch (error) { if (connection === connectionEpoch) notice("#walletNotice", errorText(error), true); }
    finally { walletBusy = false; renderWallet(); }
  }
  async function validateIdentity(ticket, requireContract, requireNewDonation) {
    guard(ticket);
    const [accounts, network, current] = await Promise.all([ticket.provider.request({ method: "eth_accounts" }), ticket.provider.request({ method: "eth_chainId" }), get("me")]);
    guard(ticket);
    if (!current.user || current.user.id !== ticket.userId) { setMe(current); throw new Error("登录状态已变化，请重新登录"); }
    const wallet = typeof current.user.wallet === "string" ? current.user.wallet : current.user.wallet && current.user.wallet.address || current.user.address;
    if (!sameAddress(list(accounts)[0], address) || !sameAddress(wallet, address) || !chainOK(network)) throw new Error("钱包地址或网络与登录账户不一致，请重新连接并核对绑定");
    if (requireContract) {
      const latest = await get("config"); guard(ticket);
      if (requireNewDonation) {
        const reason = newDonationBlockReason(latest) || newDonationBlockReason();
        if (reason) throw new Error(reason);
      }
      if (!latest.ready || Number(latest.chainId) !== 10143 || !chainOK(latest.chainHex) || !sameAddress(latest.contractAddress, config && config.contractAddress)) throw new Error(latest.reason || "资金池配置已变化，请刷新后重试");
    }
  }
  async function bind() {
    if (walletBusy || authBusy || !me.user || !address || !chainOK(chain)) return;
    walletBusy = true; const ticket = ticketNow(); renderWallet();
    notice("#walletNotice", "正在获取一次性绑定消息");
    try {
      const accounts = await provider.request({ method: "eth_accounts" }); guard(ticket);
      if (!sameAddress(list(accounts)[0], address)) throw new Error("当前钱包账户已变化，请重新连接");
      const challenge = await post("challenge", { address }); guard(ticket);
      if (typeof challenge.message !== "string" || !challenge.nonce) throw new Error("绑定消息无效");
      const bytes = new TextEncoder().encode(challenge.message);
      const hex = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      notice("#walletNotice", "请核对 MetaMask 中的绑定消息并签名（有效期 5 分钟）");
      const signature = await ticket.provider.request({ method: "personal_sign", params: [hex, address] }); guard(ticket);
      const current = await ticket.provider.request({ method: "eth_accounts" }); guard(ticket);
      if (!sameAddress(list(current)[0], address)) throw new Error("签名期间钱包账户已变化，请重新绑定");
      const result = await post("verify", { nonce: challenge.nonce, signature }); guard(ticket);
      authEpoch++; setMe({ user: result.user || result, donations: me.donations, totals: me.totals });
      notice("#walletNotice", "钱包绑定成功，尚未发送任何交易"); void refresh();
    } catch (error) { notice("#walletNotice", errorText(error), true); }
    finally { walletBusy = false; renderUser(); }
  }
  function openAuth() {
    if (authBusy || walletBusy) return;
    if (me.user) { location.hash = "account"; return; }
    if (!$("#loginDialog").open) $("#loginDialog").showModal();
  }
  function setAuthMode(mode) {
    if (authBusy || walletBusy) return;
    authMode = mode; const register = mode === "register", recovery = mode === "recovery", form = $("#authForm");
    $("#authPanel").hidden = recovery; $(".auth-tabs").hidden = recovery; $("#passwordResetForm").hidden = !recovery;
    setText("#loginTitle", recovery ? "找回密码" : register ? "注册账户" : "账户登录"); setText("#authSubmit", register ? "注册" : "登录");
    document.querySelectorAll("[data-register-only]").forEach((label) => { label.hidden = !register; label.querySelector("input").disabled = !register; });
    form.elements.name.required = register;
    form.elements.password.autocomplete = register ? "new-password" : "current-password";
    ["login", "register"].forEach((value) => {
      const tab = $(value === "login" ? "#authLoginTab" : "#authRegisterTab");
      tab.setAttribute("aria-selected", String(mode === value)); tab.tabIndex = mode === value ? 0 : -1;
    });
    $("#authPanel").setAttribute("aria-labelledby", register ? "authRegisterTab" : "authLoginTab");
    notice("#authResult", "");
    renderEmailControls();
  }
  async function emailAction(action, event) {
    if (event) event.preventDefault();
    const verification = action.startsWith("email/"), sending = action.endsWith("request");
    if (authBusy || walletBusy || emailMode !== "local-test" || emailModeError) return;
    if (verification ? !me.user || meError || me.user.emailTestVerified === true : me.user || authMode !== "recovery") return;
    const form = $(verification ? "#emailVerifyForm" : "#passwordResetForm"), resultId = verification ? "#emailResult" : "#passwordResult";
    const body = {};
    if (!verification) {
      form.elements.email.value = form.elements.email.value.trim();
      if (!form.elements.email.reportValidity()) return;
      body.email = form.elements.email.value;
    }
    if (!sending) {
      body.code = form.elements.code.value.trim();
      if (!body.code || body.code.length > 128) { notice(resultId, "请输入有效的验证码", true); return; }
      if (!verification) {
        body.password = form.elements.password.value;
        if (body.password.length < 10 || body.password.length > 128) { notice(resultId, "密码须为 10–128 个字符", true); return; }
      }
      if (!form.reportValidity()) return;
    }
    authBusy = true; authEpoch++;
    const ticket = ticketNow(), email = me.user && me.user.email;
    const sameIdentity = () => ticket.auth === authEpoch && ticket.userId === (me.user && me.user.id) && email === (me.user && me.user.email);
    const check = () => {
      if (!sameIdentity() || ticket.wallet !== walletEpoch || ticket.provider !== provider || emailMode !== "local-test" || emailModeError) {
        const error = new Error("账户、钱包或邮箱服务已变化，请重新确认后重试"); error.code = "STALE"; throw error;
      }
    };
    renderWallet(); notice(resultId, sending ? "正在请求验证码…" : verification ? "正在验证…" : "正在重置密码…");
    let reset = false;
    try {
      const result = await post(action, body); check();
      if (sending) {
        notice(resultId, verification ? "验证码请求已受理，请向管理员获取本地测试验证码。" : "如果该邮箱可用于找回密码，重置请求将被受理。请向管理员获取本地测试验证码。");
      } else if (verification) {
        if (!result || !result.user || result.user.id !== ticket.userId || result.user.email !== email || result.user.emailTestVerified !== true) throw new Error("邮箱验证返回数据不完整，请刷新账户后确认");
        setMe({ user: result.user, donations: me.donations, totals: me.totals });
        form.reset(); notice(resultId, "测试邮箱已验证；不代表身份认证。");
      } else {
        if (!result || result.reset !== true) throw new Error("密码重置返回数据不完整，请重试");
        reset = true; form.reset();
        $("#authForm").elements.email.value = body.email; $("#authForm").elements.password.value = "";
        setMe({ user: null }); invalidate();
      }
    } catch (error) {
      if (sameIdentity()) {
        if (error.status === 401 && verification) { setMe({ user: null }); notice("#walletNotice", "登录已失效，请重新登录", true); }
        else notice(resultId, errorText(error), true);
      }
    } finally {
      authBusy = false; authEpoch++;
      if (reset) {
        setAuthMode("login"); notice("#authResult", "密码已重置，原有登录会话已失效。请使用新密码登录。");
        if ($("#loginDialog").open) $("#authForm").elements.password.focus();
      }
      renderUser(); void refresh();
    }
  }
  async function authenticate(event) {
    event.preventDefault();
    if (authBusy || walletBusy || me.user || authMode === "recovery" || !event.target.reportValidity()) return;
    const form = event.target, body = { email: form.elements.email.value.trim(), password: form.elements.password.value };
    if (body.password.length < 10) { notice("#authResult", "密码至少需要 10 个字符", true); return; }
    if (authMode === "register") {
      body.name = form.elements.name.value.trim(); body.organization = form.elements.organization.value.trim();
      if (!body.name) { notice("#authResult", "请输入姓名", true); return; }
    }
    authBusy = true; authEpoch++; invalidate(); renderWallet(); notice("#authResult", authMode === "register" ? "正在注册…" : "正在登录…");
    try {
      const result = await post(authMode, body), user = result.user || result;
      if (!user || !user.id) throw new Error("账户返回数据不完整");
      setMe({ user }); form.elements.password.value = ""; $("#loginDialog").close();
      notice("#walletNotice", address ? "已登录。请点击签名绑定钱包完成绑定。" : "已登录，可以连接 MetaMask");
    } catch (error) { notice("#authResult", errorText(error), true); }
    finally { authBusy = false; authEpoch++; renderUser(); void refresh(); }
  }
  async function logout() {
    if (authBusy || walletBusy) return;
    authBusy = true; authEpoch++; invalidate(); renderWallet();
    try { await post("logout", {}); setMe({ user: null }); $("#authForm").reset(); notice("#donateResult", ""); }
    catch (error) { meError = "退出未完成：" + errorText(error); }
    finally { authBusy = false; authEpoch++; if (!me.user) setAuthMode("login"); renderUser(); void refresh(); }
  }
  function validateTransaction(tx, amount, action) {
    if (!tx || !sameAddress(tx.from, boundAddress()) || !sameAddress(tx.from, address) || !sameAddress(tx.to, config && config.contractAddress) || !chainOK(tx.chainId) || !/^0x[0-9a-f]+$/i.test(tx.value || "") || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data || "")) throw new Error("交易参数与当前账户或资金池不匹配，已停止发送");
    if (BigInt(tx.value) !== (action ? 0n : parseAmount(amount))) throw new Error("交易金额与预览不一致，已停止发送");
    return { from: tx.from, to: tx.to, value: tx.value, data: tx.data, chainId: tx.chainId };
  }
  function showPreview(record) {
    preview = record;
    setText("#donationPreviewTitle", record.action === "refund" ? "确认退回未分配 MON" : record.action === "reallocate" ? "确认继续按用途分配" : "确认捐赠");
    $("#donationSummary").innerHTML = '<dt>网络</dt><dd>Monad Testnet · 10143</dd><dt>' + (record.action ? "本次调用附带 MON" : "捐赠金额") + '</dt><dd>' + displayMon(record.action ? "0" : record.amountMon) + ' MON</dd><dt>用途</dt><dd>' + esc(purposeLabel(record.purpose)) + '</dd><dt>收款合约</dt><dd>' + explorerLink(record.transaction.to, record.transaction.to, "address") + '</dd><dt>发送钱包</dt><dd>' + esc(record.wallet) + '</dd>' + (record.action ? '<dt>捐赠编号</dt><dd>' + esc(record.id) + '</dd>' : '');
    $("#donationAllocations").innerHTML = record.action ? '<p>原捐赠未分配金额：' + displayMon(record.unallocatedMon) + ' MON。' + (record.action === "refund" ? '合约将退回至原捐赠钱包。' : '合约将按原用途匹配可用任务。') + '</p>' : allocationHtml(record.allocations) + '<p>预计待分配：' + displayMon(record.unallocatedMon) + ' MON</p>';
    $("#donationPreview").hidden = false; renderWallet(); icons();
  }
  async function prepare(event) {
    event.preventDefault(); if (walletBusy || authBusy || !event.target.reportValidity()) return;
    const reason = newDonationBlockReason() || unavailableReason(); if (reason) { notice("#donateResult", reason, true); return; }
    const amountMon = event.target.elements.amountMon.value.trim(), purpose = Number(event.target.elements.purpose.value);
    try { parseAmount(amountMon); if (!Number.isInteger(purpose) || purpose < 0 || purpose > 5) throw new Error("请选择有效用途"); }
    catch (error) { notice("#donateResult", error.message, true); return; }
    walletBusy = true; const ticket = ticketNow(); renderWallet(); notice("#donateResult", "正在计算用途分配，尚未发送交易");
    try {
      await validateIdentity(ticket, true, true); guard(ticket);
      const fingerprint = [ticket.userId, lower(address), amountMon, purpose, lower(config.contractAddress)].join(":");
      const previous = pending.find((r) => r.fingerprint === fingerprint && !r.action);
      if (previous && (previous.txHash || ["SENDING", "UNKNOWN"].includes(previous.phase))) throw new Error("已有相同捐赠等待确认，请先处理下方交易恢复记录");
      if (!prepareIntent || prepareIntent.fingerprint !== fingerprint) prepareIntent = { fingerprint, key: previous && previous.prepareKey || newKey() };
      const result = await post("donations/prepare", { amountMon, purpose }, prepareIntent.key); guard(ticket);
      if (!result.id) throw new Error("服务未返回捐赠编号");
      const transaction = validateTransaction(result.transaction, amountMon);
      const record = { id: result.id, userId: ticket.userId, wallet: address, fingerprint, prepareKey: prepareIntent.key, submitKey: previous && previous.submitKey || newKey(), amountMon, purpose, transaction, allocations: list(result.allocations), unallocatedMon: result.unallocatedMon || "0", phase: "AWAITING_SIGNATURE", txHash: null };
      saveRecord(record, true); showPreview(record); notice("#donateResult", "等待确认预览后发送 · AWAITING_SIGNATURE");
    } catch (error) { notice("#donateResult", errorText(error), true); }
    finally { walletBusy = false; renderWallet(); }
  }
  async function prepareAction(button) {
    if (walletBusy || authBusy) return;
    const reason = unavailableReason(); if (reason) { notice("#donateResult", reason, true); return; }
    const action = button.dataset.donationAction, id = button.dataset.id;
    if (!["refund", "reallocate"].includes(action)) return;
    const donation = list(me.donations).find((d) => d.id === id); if (!donation) return;
    if (pending.some((r) => r.userId === me.user.id && r.id === id && r.action && ["SENDING", "UNKNOWN", "SUBMITTED"].includes(r.phase))) { notice("#donateResult", "此捐赠已有待确认合约调用，请先等待链上确认", true); return; }
    walletBusy = true; const ticket = ticketNow(); renderWallet();
    try {
      await validateIdentity(ticket, true); guard(ticket);
      const result = await post("donations/" + action, { id }); guard(ticket);
      const transaction = validateTransaction(result.transaction, "0", action);
      const record = { id, userId: ticket.userId, wallet: address, action, submitKey: newKey(), transaction, amountMon: "0", purpose: donation.purpose, unallocatedMon: donation.unallocatedMon || "0", phase: "AWAITING_SIGNATURE", txHash: null };
      saveRecord(record, true); showPreview(record); $("#donationPreview").scrollIntoView({ block: "center" });
      notice("#donateResult", "请确认合约调用，尚未发送交易");
    } catch (error) { notice("#donateResult", errorText(error), true); }
    finally { walletBusy = false; renderWallet(); }
  }
  async function submitRecord(record) {
    if (!record.txHash || record.action || !me.user || record.userId !== me.user.id || retrying.has(record.submitKey)) return;
    retrying.add(record.submitKey); renderPending();
    try {
      const response = await post("donations/submit", { id: record.id, txHash: record.txHash }, record.submitKey);
      if (!response || !response.id) throw new Error("后端未确认交易登记，请重试提交回执");
      removeRecord(record);
      if (me.user && record.userId === me.user.id) notice("#donateResult", (labels[response.status] || "已登记，等待后端核验") + " · 交易哈希 " + record.txHash);
    } catch (error) {
      record.phase = "SUBMITTED"; saveRecord(record, false);
      if (me.user && record.userId === me.user.id) notice("#donateResult", "交易已发送，但回执登记未确认：" + errorText(error) + "。请重试提交回执，不会再次发送钱包交易。", true);
    } finally { retrying.delete(record.submitKey); renderPending(); void refresh(); }
  }
  async function send() {
    if (!preview || walletBusy || authBusy) return;
    const reason = (!preview.action && newDonationBlockReason()) || unavailableReason(); if (reason) { notice("#donateResult", reason, true); return; }
    const record = preview;
    if (record.txHash || record.phase !== "AWAITING_SIGNATURE") { notice("#donateResult", "已有钱包请求，不能重复发送。请处理交易恢复记录。", true); return; }
    walletBusy = true; const ticket = ticketNow(); let requested = false, staged = false; renderWallet();
    try {
      await validateIdentity(ticket, true, !record.action); guard(ticket);
      const transaction = validateTransaction(record.transaction, record.amountMon, record.action);
      if (record.userId !== ticket.userId || !sameAddress(record.wallet, address)) throw new Error("预览账户已变化，请重新预览");
      const latest = readPending().find((r) => r.submitKey === record.submitKey);
      if (latest && (latest.txHash || latest.phase !== "AWAITING_SIGNATURE")) {
        pending = readPending(); invalidate();
        throw new Error("另一页面已处理此钱包请求，请刷新并核对交易恢复记录");
      }
      record.phase = "SENDING"; staged = true; saveRecord(record, true);
      notice("#donateResult", "请在 MetaMask 核对金额、收款合约与网络，然后确认发送");
      guard(ticket); requested = true;
      const txHash = await ticket.provider.request({ method: "eth_sendTransaction", params: [transaction] });
      if (!hashOK(txHash)) throw new Error("钱包未返回有效交易哈希，请先在 MetaMask 核对交易状态");
      // Persist the hash even if a wallet event invalidates the UI while the popup is open.
      record.txHash = txHash; record.phase = "SUBMITTED"; saveRecord(record, false);
      preview = null; prepareIntent = null; $("#donationPreview").hidden = true;
      if (ticket.auth === authEpoch && me.user && me.user.id === record.userId) {
        if (record.action) notice("#donateResult", "合约调用已发送，等待后端索引 · " + txHash);
        else await submitRecord(record);
      }
      void refresh(); void readBalance();
    } catch (error) {
      if (staged) {
        if (Number(error.code || error.data && error.data.originalError && error.data.originalError.code) === 4001 || !requested) {
          record.phase = "AWAITING_SIGNATURE";
        } else if (!record.txHash) { record.phase = "UNKNOWN"; preview = null; $("#donationPreview").hidden = true; }
        saveRecord(record, false);
      }
      notice("#donateResult", errorText(error) + (record.phase === "UNKNOWN" ? "。发送结果不明，请检查 MetaMask 活动记录并补填哈希，勿重复发送。" : ""), true);
    } finally { walletBusy = false; renderWallet(); renderPending(); }
  }
  function renderPending() {
    const inputs = new Map(Array.from($("#pendingSubmissions").querySelectorAll("[data-recovery-hash]"), (input) => [input.dataset.recoveryHash, input.value]));
    const mine = me.user ? pending.filter((r) => r.userId === me.user.id && (r.txHash || ["SENDING", "UNKNOWN"].includes(r.phase))) : [];
    $("#pendingSubmissions").innerHTML = mine.map((r) => '<article class="order"><h3>' + (r.action ? "合约调用" : "捐赠") + '恢复记录</h3><p>' + esc(r.id) + '</p>' + (r.txHash ? '<p>' + explorerLink(r.txHash, r.txHash) + '</p><p>' + (r.action ? '已发送，等待链上索引；不会重复发送。' : '已发送，等待回执登记。') + '</p>' + (r.action ? '<button type="button" class="secondary-button" data-check-action="' + esc(r.submitKey) + '">检查链上确认</button>' : '<button type="button" class="secondary-button" data-submit-retry="' + esc(r.submitKey) + '"' + (retrying.has(r.submitKey) ? ' disabled' : '') + '>重试提交回执</button>') : '<p>钱包请求结果待确认。请先检查 MetaMask 活动记录，勿重复发送。</p><label>已发送的交易哈希<input type="text" data-recovery-hash="' + esc(r.submitKey) + '" placeholder="0x…" maxlength="66" autocomplete="off"></label><button type="button" class="secondary-button" data-recover="' + esc(r.submitKey) + '">保存哈希并查询</button>') + '</article>').join("");
    $("#pendingSubmissions").querySelectorAll("[data-recovery-hash]").forEach((input) => { input.value = inputs.get(input.dataset.recoveryHash) || ""; });
  }
  async function checkAction(record, candidateHash) {
    const txHash = candidateHash || record && record.txHash;
    if (!record || !record.action || !txHash || walletBusy || authBusy || !me.user || record.userId !== me.user.id) return;
    walletBusy = true; const ticket = ticketNow(); renderWallet();
    try {
      const result = await verifyActionRecovery(record, txHash, ticket.provider, window.ethers, config && config.confirmations);
      guard(ticket);
      removeRecord(record);
      notice("#donateResult", (result.noAllocation ? "合约调用已确认，本次未产生分配" : "合约调用已确认，资金数额以后端索引为准") + " · " + txHash);
      void refresh();
    } catch (error) { notice("#donateResult", errorText(error), true); }
    finally { walletBusy = false; renderWallet(); }
  }
  function startEvents() {
    if (!window.EventSource || stream) return;
    stream = new EventSource("/v1/wallet/events");
    stream.onopen = () => { streamOpen = true; void refresh(); };
    stream.addEventListener("change", () => { void refresh(); });
    stream.onerror = () => { streamOpen = false; };
  }
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event.detail;
    if (detail && detail.info && detail.info.rdns === "io.metamask" && detail.provider && typeof detail.provider.request === "function") { announced = detail.provider; renderWallet(); }
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.addEventListener("ethereum#initialized", renderWallet);
  $("#walletConnect").addEventListener("click", connect);
  $("#walletBind").addEventListener("click", bind);
  $("#accountAuth").addEventListener("click", openAuth);
  $("#authLoginTab").addEventListener("click", () => setAuthMode("login"));
  $("#authRegisterTab").addEventListener("click", () => setAuthMode("register"));
  $(".auth-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); setAuthMode(event.key === "Home" ? "login" : event.key === "End" ? "register" : authMode === "login" ? "register" : "login");
    $(authMode === "login" ? "#authLoginTab" : "#authRegisterTab").focus();
  });
  $("#authForm").addEventListener("submit", authenticate);
  $("#emailRequest").addEventListener("click", () => { void emailAction("email/request"); });
  $("#emailVerifyForm").addEventListener("submit", (event) => { void emailAction("email/verify", event); });
  $("#passwordRequest").addEventListener("click", () => { void emailAction("password/request"); });
  $("#passwordResetForm").addEventListener("submit", (event) => { void emailAction("password/reset", event); });
  $("#forgotPassword").addEventListener("click", () => {
    if (authBusy || walletBusy) return;
    const input = $("#passwordResetForm").elements.email;
    if (!input.value) input.value = $("#authForm").elements.email.value;
    setAuthMode("recovery"); if (!$("#passwordFields").disabled) input.focus();
  });
  $("#passwordBack").addEventListener("click", () => {
    if (authBusy || walletBusy) return;
    setAuthMode("login"); $("#forgotPassword").focus();
  });
  $("#logoutBtn").addEventListener("click", logout);
  $("#donateForm").addEventListener("submit", prepare);
  $("#donationSend").addEventListener("click", send);
  $("#donationCancel").addEventListener("click", () => { if (!walletBusy) { invalidate(); notice("#donateResult", "已取消预览，未发送交易"); renderWallet(); } });
  $("#accountRetry").addEventListener("click", () => { void refresh(); void readBalance(); });
  $("#retryBtn").addEventListener("click", () => { void refresh(); });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    if (button.dataset.donationAction) { void prepareAction(button); return; }
    const key = button.dataset.submitRetry || button.dataset.recover || button.dataset.checkAction;
    const record = key && me.user && pending.find((r) => r.submitKey === key && r.userId === me.user.id);
    if (!record || authBusy) return;
    if (button.dataset.checkAction) { void checkAction(record); return; }
    if (button.dataset.recover) {
      const input = button.closest("article").querySelector("input"), hash = input.value.trim();
      if (!hashOK(hash)) { notice("#donateResult", "请输入有效的 0x 开头 64 位交易哈希", true); return; }
      // A manually entered action hash remains editable until it is verified.
      if (record.action) { void checkAction(record, hash); return; }
      record.txHash = hash; record.phase = "SUBMITTED"; saveRecord(record, false);
    }
    if (record.action) void checkAction(record); else void submitRecord(record);
  });
  window.addEventListener("online", () => { void refresh(); startEvents(); });
  window.addEventListener("offline", () => { dashboardError = "网络已断开，保留上次确认数据"; meError = "网络已断开，账户数据可能过期"; invalidate(); renderDashboard(); renderUser(); });
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) return;
    pending = readPending();
    const current = preview && pending.find((r) => r.submitKey === preview.submitKey);
    if (current && (current.txHash || current.phase !== "AWAITING_SIGNATURE")) { invalidate("另一页面正在处理此交易，请核对恢复记录"); renderWallet(); }
    renderPending();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { void refresh(); void readBalance(); } });
  window.ReliefWallet = { request, renderDashboard, renderUser, openAuth, refresh };
  renderDashboard(); renderUser(); void refresh(); startEvents();
  setTimeout(renderWallet, 800);
  setInterval(() => { if (!streamOpen || Date.now() - lastFetch > 30000) void refresh(); }, 5000);
}());
