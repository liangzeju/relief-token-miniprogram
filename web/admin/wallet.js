(() => {
  "use strict";
  const root = document.getElementById("wallet-admin");
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const short = value => value ? `${value.slice(0, 8)}...${value.slice(-6)}` : "--";
  const formatWei = value => {
    const wei = BigInt(value || 0);
    const unit = 1000000000000000000n;
    const whole = wei / unit;
    const fraction = (wei % unit).toString().padStart(18, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : String(whole);
  };
  const purposes = ["不限用途", "饮水食品", "医疗物资", "安置装备", "救援服务", "灾后重建"];
  const statuses = { AWAITING_SIGNATURE: "待钱包签名", SUBMITTED: "已提交，待出块", CONFIRMING: "链上确认中", CONFIRMED: "已确认入账", FAILED: "交易校验失败", REORGED: "链重组，重新确认" };
  let token = "", provider = null, account = null, data = null, refreshing = false, sending = false, deploymentTimer = null;
  let accountVersion = 0;
  let authVersion = 0;
  const providers = [];
  window.addEventListener("eip6963:announceProvider", event => {
    if (event.detail?.info?.rdns === "io.metamask" && !providers.includes(event.detail.provider)) providers.push(event.detail.provider);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const $ = id => document.getElementById(id);
  const deployKey = "relief.monad.testnet.deployment";
  root.innerHTML = `
    <div class="wa-head"><div><h2>Monad 测试网资金池</h2><small>Native MON · Chain ID 10143</small></div><span id="waState" class="wa-state" data-ready="false">正在连接</span></div>
    <p id="waContract" class="wa-contract">合约：读取中</p>
    <div class="wa-stats"><div><span>资金池余额 MON</span><strong id="waBalance">--</strong></div><div><span>累计捐赠 MON</span><strong id="waDonated">--</strong></div><div><span>已分配任务 MON</span><strong id="waAllocated">--</strong></div><div><span>链上捐赠人数</span><strong id="waDonors">--</strong></div></div>
    <small id="waSync">未分配余额：-- · 已拨付：-- · 确认区块：--</small>
    <div class="wa-process" id="waProcess"><span>钱包授权</span><span>部署合约</span><span>链上确认</span><span>任务分配</span></div>
    <p id="waMessage" class="wa-message" role="status">等待读取资金池状态</p>
    <div class="wa-columns">
      <div><h3>管理权限</h3><form id="waLogin"><label>管理员访问令牌<input id="waToken" type="password" autocomplete="off" required minlength="24"></label><div class="wa-actions"><button class="wa-primary" type="submit">验证权限</button><button type="button" id="waLogout" hidden>退出管理</button><span id="waAuth">未验证</span></div></form><p>捐赠人注册资料仅在验证管理权限后显示。</p></div>
      <div><h3>合约管理员钱包</h3><div class="wa-actions"><button id="waConnect">连接 MetaMask</button><span id="waAccount">未连接</span></div><p><a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">MetaMask 官方安装页</a> · <a href="https://faucet.monad.xyz/" target="_blank" rel="noopener noreferrer">Monad 测试网水龙头</a></p><button id="waDeploy" class="wa-primary" disabled>部署救灾资金池合约</button></div>
    </div>
    <details id="waTestMailbox" hidden><summary>本地测试邮箱</summary><div><button id="waMailRefresh" type="button">刷新测试邮件</button><p id="waMailStatus" role="status">仅含本地测试消息，未发送真实邮件。</p><div class="wa-table"><table><thead><tr><th>收件人</th><th>用途</th><th>测试验证码</th><th>有效期至</th></tr></thead><tbody id="waMailRows"></tbody></table></div></div></details>
    <details id="waRecovery"><summary>恢复已有部署交易</summary><div><form id="waRecoverForm"><label>部署交易哈希<input id="waDeploymentHash" pattern="0x[0-9a-fA-F]{64}" placeholder="0x..." required></label><button type="submit">核验部署交易</button></form></div></details>
    <details id="waTaskSetup"><summary>链上救援任务配置</summary><div><form id="waTaskForm"><label>已核验的救援任务<select id="waBusinessTask" required><option value="">验证管理权限后选择</option></select></label><div class="wa-fields"><label>捐赠用途<select id="waPurpose">${purposes.slice(1).map((p, i) => `<option value="${i + 1}">${p}</option>`).join("")}</select></label><label>紧急程度<select id="waUrgency"><option value="3">紧急</option><option value="2">优先</option><option value="1">常规</option></select></label><label>任务目标 MON<input id="waTarget" inputmode="decimal" required placeholder="例如 10.5"></label><label>物资 / 救援队收款地址<input id="waRecipient" pattern="0x[0-9a-fA-F]{40}" required placeholder="0x..."></label></div><label><span><input id="waActive" type="checkbox" checked> 启用自动分配</span></label><button id="waSaveTask" type="submit" disabled>签名保存链上任务</button></form></div></details>
    <details id="waReleaseSetup"><summary>释放已分配任务资金</summary><div><form id="waReleaseForm"><label>链上任务<select id="waReleaseTask" required><option value="">验证管理权限后选择</option></select></label><label>释放金额 MON<input id="waReleaseAmount" inputmode="decimal" required placeholder="例如 0.01"></label><button id="waReleaseSubmit" class="wa-primary" type="submit" disabled>签名释放任务资金</button></form><p>只能释放该任务已分配但尚未拨付的余额，收款地址以链上任务配置为准。</p></div></details>
    <div class="wa-records"><h3>任务资金分配</h3><div class="wa-table"><table><thead><tr><th>任务 / 用途</th><th>紧急程度</th><th>已分配 / 目标 MON</th><th>已拨付 MON</th><th>收款地址</th></tr></thead><tbody id="waTaskRows"><tr><td colspan="5">尚未读取</td></tr></tbody></table></div></div>
    <div class="wa-records" id="wallet-prototype-donations"><div class="wa-head"><h3>用户捐赠与链上去向</h3><button id="waRefresh" title="刷新链上捐赠记录">刷新记录</button></div><div class="wa-table"><table><thead><tr><th>用户注册资料</th><th>捐赠 / 钱包</th><th>用途 / MON</th><th>状态 / 交易</th><th>具体任务去向</th></tr></thead><tbody id="waDonationRows"><tr><td colspan="5">请先验证管理权限</td></tr></tbody></table></div></div>`;

  function message(value, error = false) { $("waMessage").textContent = value; $("waMessage").dataset.error = String(error); }
  async function api(path, body) {
    const response = await fetch(path.startsWith("/") ? path : `/v1/wallet/${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Relief-Actor": "admin" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || `请求失败 (${response.status})`), { code: result.error?.code, status: response.status });
    return result.data;
  }
  function controls() {
    $("waDeploy").disabled = !token || !account || !!data?.contractAddress || sending || data?.newOperationsEnabled === false;
    // signPrepared() can establish the wallet connection itself. Do not make the
    // form impossible to click merely because MetaMask has not exposed accounts yet.
    $("waSaveTask").disabled = !token || !data?.ready || sending || data?.newOperationsEnabled === false;
    $("waReleaseSubmit").disabled = !token || !data?.ready || sending || data?.newOperationsEnabled === false;
    $("waDeploy").title = data?.operationBlockReason || "部署测试网合约";
    $("waConnect").disabled = sending;
    $("waLogout").hidden = !token;
    $("waTestMailbox").hidden = !token;
    if (!token) $("waMailRows").innerHTML = "";
  }
  function link(hash, kind = "tx", label = short(hash)) {
    if (!/^0x[0-9a-fA-F]+$/.test(hash || "")) return "--";
    return `<a href="https://testnet.monadexplorer.com/${kind}/${esc(hash)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }
  function render(next) {
    $("wallet-prototype-donations").hidden = next.newOperationsEnabled === false;
    data = next;
    $("waState").textContent = next.ready ? "链上同步正常" : next.reason || "同步中";
    $("waState").dataset.ready = String(next.ready);
    $("waContract").innerHTML = next.contractAddress ? `资金池合约：${link(next.contractAddress, "address", next.contractAddress)}` : "资金池合约：尚未部署";
    $("waBalance").textContent = next.totals.balanceMon;
    $("waDonated").textContent = next.totals.donatedMon;
    $("waAllocated").textContent = next.totals.allocatedMon;
    $("waDonors").textContent = next.totals.donorCount;
    $("waSync").textContent = `未分配余额：${next.totals.unallocatedMon} MON · 已拨付：${next.totals.releasedMon} MON · 已退回：${next.totals.refundedMon} MON · 确认区块：${next.confirmedBlock ?? "--"}`;
    $("waProcess").innerHTML = [["钱包授权", !!account], ["部署合约", !!next.contractAddress], ["链上确认", next.ready], ["任务分配", next.tasks.some(t => BigInt(t.allocatedWei) > 0n)]].map(([label, done]) => `<span class="${done ? "done" : ""}">${esc(label)}${done ? " · 已完成" : " · 待完成"}</span>`).join("");
    $("waTaskRows").innerHTML = next.tasks.length ? next.tasks.map(task => `<tr><td>${esc(task.title)}<small>${esc(task.businessId || short(task.id))} · ${esc(purposes[task.purpose])} · ${task.active ? "已启用" : "已停用"}</small></td><td>${["", "常规", "优先", "紧急"][task.urgency]}</td><td>${esc(task.allocatedMon)} / ${esc(task.targetMon)}<progress class="wa-progress" max="100" value="${BigInt(task.targetWei) ? Number(BigInt(task.allocatedWei) * 100n / BigInt(task.targetWei)) : 0}"></progress></td><td>${esc(task.releasedMon)}</td><td>${link(task.recipient, "address")}</td></tr>`).join("") : '<tr><td colspan="5">尚无已确认的链上任务；未匹配到任务的捐赠保留在资金池中。</td></tr>';
    if (next.businessTasks) {
      const selected = $("waBusinessTask").value;
      const signature = JSON.stringify(next.businessTasks);
      if ($("waBusinessTask").dataset.signature !== signature) {
        $("waBusinessTask").innerHTML = '<option value="">请选择救援任务</option>' + next.businessTasks.map(t => `<option value="${esc(t.id)}">${esc(t.id)} · ${esc(t.title)}</option>`).join("");
        $("waBusinessTask").value = selected;
        $("waBusinessTask").dataset.signature = signature;
      }
    }
    if (next.tasks) {
      const selectedRelease = $("waReleaseTask").value;
      const releaseSignature = JSON.stringify(next.tasks.map(t => [t.id, t.businessId, t.title, t.allocatedWei, t.releasedWei]));
      if ($("waReleaseTask").dataset.signature !== releaseSignature) {
        $("waReleaseTask").innerHTML = '<option value="">请选择已分配任务</option>' + next.tasks.filter(t => BigInt(t.allocatedWei || 0) > BigInt(t.releasedWei || 0)).map(t => `<option value="${esc(t.id)}">${esc(t.title || t.businessId || short(t.id))} · 可释放 ${esc(formatWei(BigInt(t.allocatedWei || 0) - BigInt(t.releasedWei || 0)))} MON</option>`).join("");
        $("waReleaseTask").value = selectedRelease;
        $("waReleaseTask").dataset.signature = releaseSignature;
      }
    }
    if (next.donations) $("waDonationRows").innerHTML = next.donations.length ? next.donations.map(d => `<tr><td>${d.donor ? `<strong>${esc(d.donor.name)}</strong><small>${esc(d.donor.email)}${d.donor.emailVerified ? " · 邮箱已验证" : " · 邮箱未验证"}</small><small>${esc(d.donor.organization || "个人")}</small><small>注册：${esc(d.donor.registeredAt)}</small>` : "未通过平台注册"}</td><td>${esc(short(d.id))}<small>${link(d.wallet, "address")}</small><small>${esc(d.createdAt || "链上直接捐赠")}</small></td><td>${esc(purposes[d.purpose])}<small>${esc(d.amountMon)} MON</small></td><td>${esc(statuses[d.status] || d.status)}<small>${link(d.txHash)}</small>${d.failureReason ? `<small>${esc(d.failureReason)}</small>` : ""}</td><td>${d.allocations.map(a => `<div>${esc(a.title)}<small>${esc(a.amountMon)} MON · ${link(a.txHash, "tx", "分配凭证")}</small></div>`).join("") || "尚无链上分配"}${d.status === "CONFIRMED" ? `<small>待分配 ${esc(d.unallocatedMon)} MON · 已退回 ${esc(d.refundedMon || "0")} MON</small>` : ""}</td></tr>`).join("") : '<tr><td colspan="5">尚无用户捐赠记录</td></tr>';
    controls();
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const version = authVersion;
    try { const next = await api(token ? "admin/overview" : "dashboard"); if (version === authVersion) render(next); }
    catch (error) {
      if (version !== authVersion) return;
      if ([401, 403].includes(error.status)) { token = ""; $("waAuth").textContent = "管理会话已失效"; $("waDonationRows").innerHTML = '<tr><td colspan="5">请先验证管理权限</td></tr>'; window.dispatchEvent(new CustomEvent("relief:admin-auth", { detail: { authenticated: false } })); controls(); }
      message(error.message, true);
    } finally { refreshing = false; if (version !== authVersion) void refresh(); }
  }
  async function connect() {
    const candidate = providers[0] || (window.ethereum?.isMetaMask ? window.ethereum : window.ethereum?.providers?.find(p => p.isMetaMask));
    if (!candidate) throw new Error("未检测到 MetaMask。请在已安装 MetaMask 扩展的 Chrome / Edge 中打开此地址。");
    if (provider !== candidate) {
      provider = candidate;
      provider.on?.("accountsChanged", addresses => { accountVersion++; account = addresses[0] || null; $("waAccount").textContent = short(account); controls(); });
      provider.on?.("chainChanged", () => { accountVersion++; message("钱包网络已变化，下一次操作将重新核验测试网。"); });
    }
    // Read existing permission first. Calling eth_requestAccounts repeatedly while
    // MetaMask has an unresolved permission prompt produces wallet_requestPermissions
    // already-pending errors and can strand the page in an apparent disconnected state.
    let addresses = await provider.request({ method: "eth_accounts" });
    if (!addresses.length) {
      try {
        addresses = await provider.request({ method: "eth_requestAccounts" });
      } catch (error) {
        if (String(error?.message || "").toLowerCase().includes("already pending")) {
          throw new Error("MetaMask 仍有一个待处理的连接请求。请打开 MetaMask 处理或关闭该请求后，再刷新页面重试。");
        }
        throw error;
      }
    }
    account = addresses[0]; if (!account) throw new Error("钱包未授权账户");
    $("waAccount").textContent = short(account); controls();
    return account;
  }
  async function ensureNetwork() {
    if (!provider || !account) await connect();
    if (Number(await provider.request({ method: "eth_chainId" })) !== 10143) {
      try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }); }
      catch (error) {
        if (error.code !== 4902) throw error;
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x279f", chainName: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: [data.rpcUrl], blockExplorerUrls: ["https://testnet.monadexplorer.com"] }] });
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] });
      }
    }
    const addresses = await provider.request({ method: "eth_accounts" });
    account = addresses[0];
    if (!account || Number(await provider.request({ method: "eth_chainId" })) !== 10143) throw new Error("请连接 Monad 测试网账户");
    return account;
  }
  async function signPrepared(path, body) {
    await ensureNetwork(); const version = accountVersion; const from = account;
    const prepared = await api(path, { ...body, owner: from });
    if (version !== accountVersion || from !== account) throw new Error("钱包状态发生变化，请重新操作");
    if (Number(await provider.request({ method: "eth_chainId" })) !== 10143) throw new Error("钱包网络已变化，请重试");
    return provider.request({ method: "eth_sendTransaction", params: [prepared.transaction] });
  }
  async function run(action) {
    if (sending) return;
    sending = true; controls();
    try { await action(); } catch (error) { message(error.code === 4001 ? "已取消钱包操作，未发送交易。" : error.message, true); }
    finally { sending = false; controls(); }
  }
  function rememberHash(hash) { $("waDeploymentHash").value = hash; try { localStorage.setItem(deployKey, hash); } catch (_) {} }
  async function confirmDeployment() {
    clearTimeout(deploymentTimer);
    const hash = $("waDeploymentHash").value.trim();
    if (!token || !hash) return;
    try {
      await api("admin/deploy-confirm", { txHash: hash });
      try { localStorage.removeItem(deployKey); } catch (_) {}
      message("资金池合约已通过字节码与区块确认核验。请配置救援任务。"); await refresh();
    } catch (error) {
      message(error.message, error.code !== "DEPLOYMENT_PENDING");
      if (error.code === "DEPLOYMENT_PENDING") deploymentTimer = setTimeout(() => void confirmDeployment(), 4000);
    }
  }
  $("waLogin").addEventListener("submit", event => { event.preventDefault(); void run(async () => {
    const version = ++authVersion, suppliedToken = $("waToken").value.trim();
    try {
      await api("/v1/admin/session", { token: suppliedToken });
      if (version !== authVersion) return;
      token = "session";
      const next = await api("admin/overview");
      if (version !== authVersion) return;
      render(next); $("waToken").value = ""; $("waAuth").textContent = "已验证";
      window.dispatchEvent(new CustomEvent("relief:admin-auth", { detail: { authenticated: true } }));
      message("管理会话已建立，与移动端用户登录相互独立。");
      if ($("waDeploymentHash").value && !data.contractAddress) await confirmDeployment();
    } catch (error) { if (version === authVersion) { token = ""; controls(); } throw error; }
  }); });
  $("waLogout").addEventListener("click", () => void run(async () => {
    await api("/v1/admin/logout", {});
    authVersion++; token = "";
    if (data) { const { donations, businessTasks, ...publicData } = data; data = publicData; }
    clearTimeout(deploymentTimer); $("waToken").value = ""; $("waAuth").textContent = "未验证";
    $("waDonationRows").innerHTML = '<tr><td colspan="5">请先验证管理权限</td></tr>';
    $("waBusinessTask").innerHTML = '<option value="">验证管理权限后选择</option>';
    delete $("waBusinessTask").dataset.signature;
    window.dispatchEvent(new CustomEvent("relief:admin-auth", { detail: { authenticated: false } }));
    controls(); await refresh();
  }));
  $("waConnect").addEventListener("click", () => void run(async () => { await connect(); await ensureNetwork(); message("MetaMask 已连接 Monad 测试网。"); }));
  $("waDeploy").addEventListener("click", () => void run(async () => { if ($("waDeploymentHash").value) { await confirmDeployment(); return; } message("请在 MetaMask 中确认合约部署交易。此操作需要测试网 MON 支付 Gas。"); const hash = await signPrepared("admin/deploy-prepare", {}); rememberHash(hash); message(`部署交易已发送：${hash}，等待链上确认。`); await confirmDeployment(); }));
  $("waRecoverForm").addEventListener("submit", event => { event.preventDefault(); rememberHash($("waDeploymentHash").value.trim()); void run(confirmDeployment); });
  $("waTaskForm").addEventListener("submit", event => { event.preventDefault(); void run(async () => { const body = { businessId: $("waBusinessTask").value, purpose: Number($("waPurpose").value), urgency: Number($("waUrgency").value), targetMon: $("waTarget").value.trim(), recipient: $("waRecipient").value.trim(), active: $("waActive").checked }; message("请在 MetaMask 中确认任务配置交易。"); const hash = await signPrepared("admin/task-prepare", body); message(`任务配置交易已发送：${hash}。区块确认后更新任务列表。`); }); });
  $("waReleaseForm").addEventListener("submit", event => { event.preventDefault(); void run(async () => { const taskId = $("waReleaseTask").value; const amountMon = $("waReleaseAmount").value.trim(); if (!taskId || !amountMon) throw new Error("请选择任务并输入释放金额"); message("请在 MetaMask 中确认任务资金释放交易。"); const hash = await signPrepared("admin/task-release-prepare", { taskId, amountMon }); message(`任务资金释放交易已发送：${hash}。等待 TaskReleased 事件确认。`); }); });
  $("waBusinessTask").addEventListener("change", () => { const existing = data?.tasks.find(t => t.businessId === $("waBusinessTask").value); if (!existing) return; $("waPurpose").value = existing.purpose; $("waUrgency").value = existing.urgency; $("waTarget").value = existing.targetMon; $("waRecipient").value = existing.recipient; $("waActive").checked = existing.active; });
  $("waRefresh").addEventListener("click", () => void refresh());
  $("waMailRefresh").addEventListener("click", () => void run(async () => {
    const version = authVersion;
    const mailbox = await api("admin/test-mailbox");
    if (version !== authVersion || !token) return;
    $("waMailStatus").textContent = "本地测试消息，未发送真实邮件。";
    $("waMailRows").innerHTML = (mailbox.messages || []).map(mail => `<tr><td>${esc(mail.to)}</td><td>${mail.purpose === "password-reset" ? "密码找回" : "邮箱验证"}</td><td><code>${esc(mail.code)}</code></td><td>${esc(new Date(mail.expiresAt).toLocaleString("zh-CN"))}</td></tr>`).join("") || '<tr><td colspan="4">暂无测试邮件</td></tr>';
  }));
  try { $("waDeploymentHash").value = localStorage.getItem(deployKey) || ""; } catch (_) {}
  const events = new EventSource("/v1/wallet/events");
  events.addEventListener("change", () => void refresh());
  const polling = setInterval(() => void refresh(), 5000);
  window.addEventListener("pagehide", () => { events.close(); clearInterval(polling); clearTimeout(deploymentTimer); });
  void api("/v1/admin/session").then(session => {
    token = session.authenticated ? "session" : "";
    $("waAuth").textContent = token ? "已验证" : "未验证";
    window.dispatchEvent(new CustomEvent("relief:admin-auth", { detail: { authenticated: !!token } }));
    controls(); return refresh();
  }).then(() => message(data?.ready ? "链上入账与分配记录已同步。" : data?.reason || "正在连接后端。")).catch(error => message(error.message, true));
})();
