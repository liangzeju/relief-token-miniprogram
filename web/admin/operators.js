(() => {
  "use strict";
  const root = document.getElementById("operators-admin");
  if (!root) return;
  const roles = { supplier: "供应商", dispatcher: "调度员", contract_approver: "合同审批", acceptance: "验收", finance: "财务", reviewer: "评审", official_verifier: "官方核验", reporter: "上报员", auditor: "审计" };
  let authenticated = false, busy = false, epoch = 0, controller = null;
  root.innerHTML = `
    <div class="op-admin-head"><h2>岗位管理</h2><div class="op-admin-actions"><a href="/operations/">岗位工作台</a><a id="op-admin-review" href="/operations/?mode=admin" hidden>管理员只读审阅</a><button id="op-admin-refresh" type="button" disabled>刷新岗位</button></div></div>
    <p class="op-admin-note">岗位授权不代表身份、机构真实性或 KYC 已核验。</p>
    <p id="op-admin-status" class="op-admin-message" role="status" aria-atomic="true">请先在上方验证管理权限。</p>
    <div id="op-admin-private" hidden>
      <form id="op-admin-form" autocomplete="off"><fieldset id="op-admin-fields" disabled>
        <legend>签发岗位邀请</legend><div class="op-admin-grid">
          <label for="op-admin-email">受邀邮箱<input id="op-admin-email" name="email" type="email" required maxlength="254" autocomplete="off"></label>
          <label for="op-admin-org">机构 ID<input id="op-admin-org" name="organizationId" required maxlength="160" autocomplete="off"></label>
          <label for="op-admin-role">岗位<select id="op-admin-role" name="role" required><option value="">请选择岗位</option></select></label>
        </div><button id="op-admin-invite" class="op-admin-primary" type="submit">签发邀请</button>
      </fieldset></form>
      <p id="op-admin-result" class="op-admin-message" role="status" aria-atomic="true"></p>
      <section id="op-admin-codes" class="op-admin-codes" hidden aria-label="本次签发的邀请码"><div class="op-admin-head"><h3>本次签发</h3><button id="op-admin-clear" type="button">清除显示</button></div><p class="op-admin-note">邀请码仅可领取一次，有效期 24 小时。刷新或退出后不再显示，请妥善交给受邀人。</p><div id="op-admin-code-list"></div></section>
      <h3>岗位记录</h3><div id="op-admin-list"></div>
    </div>`;
  const $ = id => document.getElementById("op-admin-" + id);
  Object.entries(roles).forEach(([value, label]) => $("role").add(new Option(label, value)));
  function message(id, value, error = false) { $(id).textContent = value; $(id).dataset.error = String(error); }
  function controls() {
    $("private").hidden = !authenticated;
    $("review").hidden = !authenticated;
    $("fields").disabled = !authenticated || busy;
    $("refresh").disabled = !authenticated || busy;
    root.setAttribute("aria-busy", String(busy));
    $("list").querySelectorAll("button").forEach(button => { button.disabled = busy || !authenticated; });
  }
  function clearCodes() { $("code-list").replaceChildren(); $("codes").hidden = true; }
  function reset(text = "请先在上方验证管理权限。") {
    epoch++; controller?.abort(); controller = null; authenticated = false; busy = false;
    clearCodes(); $("form").reset(); $("list").replaceChildren(); message("result", ""); message("status", text); controls();
  }
  async function api(path, body, signal) {
    const response = await fetch("/v1/platform/operators" + path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { "X-Relief-Actor": "admin", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error?.message || "请求失败，请稍后重试。"), { status: response.status });
    if (!("data" in result)) throw new Error("岗位服务返回数据不完整，请刷新确认。");
    return result.data;
  }
  function fail(error, target) {
    if ([401, 403].includes(error.status)) {
      reset(error.status === 401 ? "管理会话已失效，请重新验证权限。" : "当前会话无岗位管理权限，请重新验证。");
      message("status", $("status").textContent, true);
    } else message(target, error.message, true);
  }
  function details(parent, fields) {
    const dl = document.createElement("dl"); dl.className = "op-admin-details";
    fields.forEach(([label, value]) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = value ?? "--"; dl.append(dt, dd);
    }); parent.append(dl);
  }
  function renderList(items) {
    $("list").replaceChildren();
    if (!items.length) { const p = document.createElement("p"); p.textContent = "暂无已领取岗位；尚未领取的邀请不在此列表中。"; $("list").append(p); return; }
    items.forEach(item => {
      const row = document.createElement("article"); row.className = "op-admin-record"; row.dataset.userId = item.userId;
      details(row, [["账户", item.email], ["机构 ID", item.organizationId], ["岗位", roles[item.role] || item.role], ["绑定钱包", item.wallet], ["状态", item.status === "active" ? "已授权" : "已撤权"]]);
      if (item.status === "active") {
        const button = document.createElement("button"); button.type = "button"; button.className = "op-admin-revoke"; button.textContent = "撤销岗位";
        button.addEventListener("click", () => revoke(item)); row.append(button);
      }
      $("list").append(row);
    });
  }
  async function refresh() {
    if (!authenticated || busy) return;
    const version = epoch; controller = new AbortController(); busy = true; controls(); message("status", "正在读取岗位记录…");
    try {
      const items = await api("", undefined, controller.signal);
      if (version !== epoch) return;
      if (!Array.isArray(items)) throw new Error("岗位列表格式异常，请重试。");
      renderList(items); message("status", "岗位记录已更新，共 " + items.length + " 条。");
    } catch (error) { if (version === epoch) { $("list").replaceChildren(); fail(error, "status"); } }
    finally { if (version === epoch) { busy = false; controls(); } }
  }
  async function mutate(path, body, onSuccess) {
    if (!authenticated || busy) return;
    const version = epoch; controller = new AbortController(); busy = true; controls(); message("result", "正在提交…");
    let done = false;
    try {
      const value = await api(path, body, controller.signal);
      if (version !== epoch) return;
      onSuccess(value); done = true;
    } catch (error) { if (version === epoch) fail(error, "result"); }
    finally { if (version === epoch) { busy = false; controls(); if (done) void refresh(); } }
  }
  function revoke(item) {
    if (!authenticated || busy) return;
    const version = epoch;
    if (!window.confirm("确认撤销 " + item.email + " 在机构 " + item.organizationId + " 的“" + (roles[item.role] || item.role) + "”岗位？撤权后该账户将无法继续使用此岗位权限。")) return;
    if (version !== epoch) return;
    void mutate("/" + encodeURIComponent(item.userId) + "/revoke", {}, () => message("result", "岗位已撤销。"));
  }
  $("form").addEventListener("submit", event => {
    event.preventDefault(); if (!authenticated || busy || !$("form").reportValidity()) return;
    const body = { email: $("email").value.trim(), organizationId: $("org").value.trim(), role: $("role").value };
    if (!body.organizationId || /[<>\x00-\x1f\x7f]/.test(body.organizationId)) { message("result", "请输入有效机构 ID，不能包含尖括号或控制字符。", true); return; }
    void mutate("/invitations", body, invitation => {
      if (!invitation || !/^[a-f0-9]{64}$/i.test(invitation.code)) throw new Error("邀请已提交，但未收到有效邀请码，请核对服务状态。");
      const item = document.createElement("article"); item.className = "op-admin-record";
      details(item, [["受邀邮箱", invitation.email], ["机构 / 岗位", invitation.organizationId + " / " + (roles[invitation.role] || invitation.role)], ["有效期至", new Date(invitation.expiresAt).toLocaleString("zh-CN")]]);
      const code = document.createElement("code"); code.className = "op-admin-code"; code.textContent = invitation.code; item.append(code);
      $("code-list").append(item); $("codes").hidden = false; message("result", "邀请已签发，等待受邀账户领取。");
    });
  });
  $("refresh").addEventListener("click", refresh);
  $("clear").addEventListener("click", clearCodes);
  window.addEventListener("relief:admin-auth", event => {
    if (!event.detail?.authenticated) { reset(); return; }
    if (!authenticated) { authenticated = true; epoch++; controls(); void refresh(); }
  });
  // Invalidate requests at logout intent, before its network round trip completes.
  document.addEventListener("click", event => { if (event.target.closest("#waLogout")) reset("已清除岗位会话，请重新验证管理权限后查看。"); }, true);
  window.addEventListener("pagehide", () => reset());
  controls();
})();
