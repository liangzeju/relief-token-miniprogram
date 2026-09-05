(() => {
  "use strict";
  const root = document.getElementById("operators-account");
  if (!root) return;
  const roles = { supplier: "供应商", dispatcher: "调度员", contract_approver: "合同审批", acceptance: "验收", finance: "财务", reviewer: "评审", official_verifier: "官方核验", reporter: "上报员", auditor: "审计" };
  const errors = { INVALID_CODE: "请输入 64 位十六进制邀请码。", INVITATION_UNAVAILABLE: "邀请不存在、已过期或已被领取，请联系管理员核对。", EMAIL_MISMATCH: "邀请邮箱与当前账户不一致，请使用受邀邮箱登录。", ASSIGNMENT_CONFLICT: "此账户或钱包已有有效岗位，请联系管理员核对。", INVALID_WALLET: "请先为当前账户签名绑定有效钱包。" };
  let user = null, identity = "", epoch = 0, busy = false, known = false, assignment = null, controller = null, denied = false;
  root.innerHTML = `
    <div class="op-mobile-head"><h2>我的岗位</h2><button id="op-mobile-refresh" type="button" disabled title="刷新岗位状态" aria-label="刷新岗位状态"><i data-lucide="refresh-cw" aria-hidden="true"></i></button></div>
    <p id="op-mobile-identity" class="op-mobile-note"></p>
    <p id="op-mobile-status" class="op-mobile-message" role="status" aria-atomic="true">登录后查看岗位或领取邀请。</p>
    <dl id="op-mobile-details" class="op-mobile-details" hidden></dl>
    <form id="op-mobile-form" autocomplete="off"><fieldset id="op-mobile-fields" disabled>
      <label for="op-mobile-code">岗位邀请码</label><input id="op-mobile-code" name="code" type="password" required minlength="64" maxlength="64" pattern="[0-9a-fA-F]{64}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="op-mobile-note">
      <button id="op-mobile-claim" class="op-mobile-primary" type="submit">领取岗位</button>
    </fieldset></form>
    <p id="op-mobile-result" class="op-mobile-message" role="status" aria-atomic="true"></p>
    <p id="op-mobile-note" class="op-mobile-note">领取账户须与受邀邮箱一致，并已签名绑定钱包。岗位授权不代表身份、机构真实性或 KYC 已核验。</p>
    <div class="op-mobile-links"><a id="op-mobile-workspace" href="/operations/">岗位工作台 <i data-lucide="arrow-up-right" aria-hidden="true"></i></a><a id="op-mobile-review" href="/operations/?mode=admin">管理员只读审阅</a></div>`;
  const $ = id => document.getElementById("op-mobile-" + id);
  const wallet = value => typeof value?.wallet === "string" ? value.wallet : value?.wallet?.address || "";
  const key = value => value?.id ? JSON.stringify([value.id, value.email, wallet(value).toLowerCase()]) : "";
  const bound = () => /^0x[0-9a-f]{40}$/i.test(wallet(user)) && !/^0x0{40}$/i.test(wallet(user));
  function message(id, value, error = false) { $(id).textContent = value; $(id).dataset.error = String(error); }
  function controls() {
    $("fields").disabled = !user || !bound() || busy || !known || !!assignment || denied;
    $("form").hidden = !!assignment;
    $("refresh").disabled = !user || busy;
    root.setAttribute("aria-busy", String(busy));
  }
  function reset(next) {
    epoch++; controller?.abort(); controller = null; busy = false; known = false; assignment = null; denied = false;
    user = next?.id ? { id: next.id, email: next.email, wallet: wallet(next) } : null; identity = key(user);
    $("form").reset(); $("details").replaceChildren(); $("details").hidden = true;
    $("identity").textContent = user ? "领取账户：" + user.email + " · 绑定钱包：" + (wallet(user) || "未绑定") : "";
    message("result", ""); message("status", user ? "正在确认岗位状态…" : "登录后查看岗位或领取邀请。"); controls();
  }
  async function api(path, body, signal) {
    const response = await fetch("/v1/platform/operators" + path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(errors[result.error?.code] || result.error?.message || "网络请求失败，请重试。"), { status: response.status });
    if (!("data" in result)) throw new Error("岗位数据不完整，请刷新重试。");
    return result.data;
  }
  function render(value) {
    if (value && (value.userId !== user.id || String(value.wallet).toLowerCase() !== wallet(user).toLowerCase() || value.status !== "active")) throw new Error("岗位与当前账户或钱包不一致，请刷新账户后重试。");
    assignment = value; known = true; denied = false; $("details").replaceChildren(); $("details").hidden = !value;
    if (value) {
      [["岗位", roles[value.role] || value.role], ["机构 ID", value.organizationId], ["状态", "已授权"], ["绑定钱包", value.wallet]].forEach(([label, text]) => {
        const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = text; $("details").append(dt, dd);
      });
      message("status", "当前岗位已生效。");
    } else message("status", bound() ? "当前无有效岗位，可领取管理员邀请。" : "当前无有效岗位，请先连接并签名绑定钱包。");
  }
  function fail(error, target) {
    if ([401, 403].includes(error.status)) {
      const current = user; reset(error.status === 401 ? null : current); denied = true;
      message("status", error.status === 401 ? "登录会话已失效，请重新登录后刷新岗位。" : "当前账户无权执行此操作，请核对账户后刷新岗位。", true);
      controls();
    } else message(target, error.message, true);
  }
  async function refresh() {
    if (!user || busy) return;
    const version = epoch; controller = new AbortController(); busy = true; known = false; controls(); message("status", "正在读取岗位状态…");
    try {
      const value = await api("/me", undefined, controller.signal); if (version !== epoch) return; render(value);
    } catch (error) {
      if (version === epoch) { assignment = null; $("details").replaceChildren(); $("details").hidden = true; fail(error, "status"); }
    } finally { if (version === epoch) { busy = false; controls(); } }
  }
  $("form").addEventListener("submit", async event => {
    event.preventDefault(); if ($("fields").disabled || !$("form").reportValidity()) return;
    const version = epoch, code = $("code").value; controller = new AbortController(); busy = true; controls(); message("result", "正在领取岗位…");
    try {
      const value = await api("/claim", { code }, controller.signal); if (version !== epoch) return;
      if (!value) throw new Error("领取结果不完整，请刷新岗位确认。");
      render(value); $("form").reset(); message("result", "岗位领取成功。");
    } catch (error) { if (version === epoch) fail(error, "result"); }
    finally { if (version === epoch) { busy = false; controls(); } }
  });
  $("refresh").addEventListener("click", refresh);
  // Repeated wallet refresh events must not discard an invitation being entered.
  window.addEventListener("relief:wallet-user", event => {
    if (key(event.detail) === identity) return;
    reset(event.detail); if (user) void refresh();
  });
  document.addEventListener("click", event => { if (event.target.closest("#logoutBtn")) reset(null); }, true);
  window.addEventListener("pagehide", () => reset(null));
  controls();
})();
