"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../../web");
const user = { id: "email-user", name: "Email tester", email: "tester@example.com", emailVerified: false, emailTestVerified: false };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(browser, initialUser = null, mode = "local-test") {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const state = { user: initialUser, mode, calls: [], handlers: {}, errors: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(() => {
    const listeners = {};
    window.walletTransactions = [];
    window.ethereum = {
      isMetaMask: true,
      on: (name, fn) => { listeners[name] = fn; },
      removeListener: name => { delete listeners[name]; },
      request: async ({ method, params }) => {
        if (method === "eth_sendTransaction") { window.walletTransactions.push(params[0]); return "0x" + "56".repeat(32); }
        return method === "eth_chainId" ? "0x279f" : method === "eth_getBalance" ? "0x0" : ["0x" + "12".repeat(20)];
      }
    };
    window.changeTestChain = () => listeners.chainChanged("0x1");
    window.userEvents = [];
    window.addEventListener("relief:wallet-user", event => window.userEvents.push(event.detail));
  });
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
    if (pathname.startsWith("/v1/wallet/")) {
      const endpoint = pathname.slice("/v1/wallet/".length);
      state.calls.push({ endpoint, method: req.method(), body: req.postDataJSON() });
      if (state.handlers[endpoint]) return state.handlers[endpoint](route, req);
      const data = endpoint === "me" ? { user: state.user } : endpoint === "auth-config" ? { emailMode: state.mode }
        : endpoint === "config" ? { ready: false, purposes: [] } : endpoint === "dashboard" ? { ready: false }
        : endpoint === "email/verify" ? { user: (state.user = { ...state.user, emailTestVerified: true, emailVerificationMode: "local-test" }) }
        : endpoint === "password/reset" ? { reset: true } : {};
      return route.fulfill({ status: endpoint.endsWith("/request") ? 202 : 200, json: { data } });
    }
    // Exercise wallet.js and its real markup/styles independently of the catalogue and backend.
    if (["/mobile/app.js", "/shared/api.js"].includes(pathname)) return route.fulfill({ contentType: "text/javascript", body: "" });
    const file = path.join(root, pathname === "/mobile/" ? "mobile/index.html" : pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: fs.readFileSync(file) });
  });
  await page.goto("http://wallet.test/mobile/");
  await page.waitForFunction(() => !document.querySelector("#emailModeNote").textContent.includes("正在读取"));
  await page.evaluate(() => {
    document.querySelector("#view-home").hidden = true;
    document.querySelector("#view-account").hidden = false;
  });
  return { page, state, context, count: endpoint => state.calls.filter(call => call.endpoint === endpoint).length };
}

async function refresh(page) {
  await page.evaluate(() => window.ReliefWallet.refresh());
}

async function openRecovery(page) {
  await page.locator("#accountAuth").click();
  await page.locator("#forgotPassword").click();
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", headless: true });
  try {
    const { page, state, context, count } = await fixture(browser, { ...user });
    assert.match(await page.locator("#accountIdentity").innerText(), /邮箱未验证/);
    assert.match(await page.locator("#emailModeNote").innerText(), /本地测试邮箱/);
    await page.locator("#emailCode").fill("draft-code");
    await refresh(page);
    assert.equal(await page.locator("#emailCode").inputValue(), "draft-code");
    assert.equal(await page.locator("#emailCode").evaluate(el => el === document.activeElement), true);

    const sent = deferred(), release = deferred();
    state.handlers["email/request"] = async route => {
      sent.resolve(); await release.promise;
      await route.fulfill({ status: 202, json: { data: { code: "NEVER-DISPLAY-THIS-CODE" } } });
    };
    await page.locator("#emailRequest").click(); await sent.promise;
    assert(await page.locator("#emailVerify").isDisabled());
    assert(await page.locator("#walletConnect").isDisabled());
    assert(await page.locator("#logoutBtn").isDisabled());
    await page.evaluate(() => document.querySelector("#emailRequest").dispatchEvent(new Event("click")));
    assert.equal(count("email/request"), 1);
    release.resolve();
    await page.waitForFunction(() => document.querySelector("#emailResult").textContent.includes("已受理"));
    assert(!(await page.locator("body").innerText()).includes("NEVER-DISPLAY-THIS-CODE"));
    assert.equal(await page.locator("#emailCode").inputValue(), "draft-code");
    assert.deepEqual(state.calls.find(call => call.endpoint === "email/request").body, {});

    state.handlers["email/verify"] = route => route.fulfill({ status: 400, json: { error: { code: "INVALID_CODE", message: "验证码无效或已过期" } } });
    await page.locator("#emailVerify").click();
    await page.waitForFunction(() => document.querySelector("#emailResult").classList.contains("error"));
    assert.match(await page.locator("#emailResult").innerText(), /验证码无效或已过期/);
    assert.equal(await page.locator("#emailCode").inputValue(), "draft-code");
    delete state.handlers["email/verify"];
    await page.locator("#emailCode").fill("test-code"); await page.locator("#emailVerify").click();
    await page.waitForFunction(() => document.querySelector("#accountIdentity").textContent.includes("测试邮箱已验证"));
    assert.equal(await page.evaluate(() => window.userEvents.some(user => user && user.emailTestVerified === true && user.emailVerified === false)), true);
    assert(await page.locator("#emailRequest").isDisabled());
    assert.equal(await page.locator("#emailCode").inputValue(), "");
    assert.deepEqual(state.calls.filter(call => call.endpoint === "email/verify").at(-1).body, { code: "test-code" });
    assert.deepEqual(state.errors, []);
    await context.close();

    const recovery = await fixture(browser);
    await openRecovery(recovery.page);
    await recovery.page.locator("#resetEmail").fill(user.email);
    await recovery.page.locator("#resetCode").fill("reset-code");
    await recovery.page.locator("#resetPassword").fill("Valid-password-123");
    await refresh(recovery.page);
    assert.equal(await recovery.page.locator("#resetPassword").evaluate(el => el === document.activeElement), true);
    assert.equal(await recovery.page.locator("#resetPassword").inputValue(), "Valid-password-123");
    for (const width of [320, 390, 768, 1440]) {
      await recovery.page.setViewportSize({ width, height: 844 });
      assert.equal(await recovery.page.evaluate(() => {
        const dialog = document.querySelector("#loginDialog");
        return dialog.scrollWidth > dialog.clientWidth || document.documentElement.scrollWidth > innerWidth;
      }), false, `Recovery overflow at ${width}px`);
    }
    const passwordSent = deferred(), passwordRelease = deferred();
    recovery.state.handlers["password/request"] = async route => {
      passwordSent.resolve(); await passwordRelease.promise;
      await route.fulfill({ status: 202, json: { data: { exists: false, code: "PRIVATE-INBOX-CODE" } } });
    };
    await recovery.page.locator("#passwordRequest").click(); await passwordSent.promise;
    await recovery.page.evaluate(() => document.querySelector("#passwordResetForm").dispatchEvent(new Event("submit", { cancelable: true })));
    assert.equal(recovery.count("password/reset"), 0);
    assert(await recovery.page.locator("#passwordBack").isDisabled());
    passwordRelease.resolve();
    await recovery.page.waitForFunction(() => document.querySelector("#passwordResult").textContent.includes("如果该邮箱"));
    assert(!(await recovery.page.locator("body").innerText()).includes("PRIVATE-INBOX-CODE"));
    assert.deepEqual(recovery.state.calls.find(call => call.endpoint === "password/request").body, { email: user.email });
    for (const password of ["short", "a".repeat(129)]) {
      await recovery.page.locator("#resetPassword").evaluate((el, value) => { el.value = value; }, password);
      await recovery.page.evaluate(() => document.querySelector("#passwordResetForm").dispatchEvent(new Event("submit", { cancelable: true })));
      assert.equal(recovery.count("password/reset"), 0);
    }
    await recovery.page.locator("#resetPassword").fill("Valid-password-123");
    await recovery.page.locator("#passwordReset").click();
    await recovery.page.waitForFunction(() => document.querySelector("#authResult").textContent.includes("密码已重置"));
    assert(await recovery.page.locator("#authPanel").isVisible());
    assert.equal(await recovery.page.locator('#authForm [name="email"]').inputValue(), user.email);
    assert.equal(await recovery.page.locator('#authForm [name="password"]').inputValue(), "");
    assert.equal(await recovery.page.locator("#resetPassword").inputValue(), "");
    assert.equal(recovery.count("login"), 0);
    assert.deepEqual(recovery.state.calls.find(call => call.endpoint === "password/reset").body, { email: user.email, code: "reset-code", password: "Valid-password-123" });
    assert.deepEqual(recovery.state.errors, []);
    await recovery.context.close();

    for (const mode of ["disabled", "unexpected"]) {
      const disabled = await fixture(browser, null, mode);
      await openRecovery(disabled.page);
      assert(await disabled.page.locator("#passwordRequest").isDisabled());
      await disabled.page.evaluate(() => document.querySelector("#passwordRequest").dispatchEvent(new Event("click")));
      assert.equal(disabled.count("password/request"), 0);
      disabled.state.user = { ...user }; await refresh(disabled.page);
      assert(await disabled.page.locator("#emailRequest").isDisabled());
      await disabled.context.close();
    }

    const stale = await fixture(browser, { ...user });
    await stale.page.evaluate(() => { document.querySelector("#view-home").hidden = false; });
    await stale.page.locator("#walletConnect").click();
    await stale.page.waitForFunction(() => !document.querySelector("#walletConnect").disabled);
    const verifying = deferred(), verifyRelease = deferred();
    stale.state.handlers["email/verify"] = async route => {
      verifying.resolve(); await verifyRelease.promise;
      await route.fulfill({ json: { data: { user: { ...user, emailTestVerified: true } } } });
    };
    await stale.page.locator("#emailCode").fill("stale-code");
    await stale.page.locator("#emailVerify").click(); await verifying.promise;
    await stale.page.evaluate(() => window.changeTestChain()); verifyRelease.resolve();
    await stale.page.waitForFunction(() => document.querySelector("#emailResult").textContent.includes("已变化"));
    assert.match(await stale.page.locator("#accountIdentity").innerText(), /邮箱未验证/);
    assert.equal(await stale.page.evaluate(() => window.userEvents.some(user => user && user.emailTestVerified)), false);
    stale.state.user = { ...user, id: "different-user", email: "other@example.com" }; await refresh(stale.page);
    assert.equal(await stale.page.locator("#emailCode").inputValue(), "");
    assert.equal(await stale.page.locator("#emailResult").innerText(), "");
    stale.state.handlers["email/verify"] = route => route.fulfill({ json: { data: { user: { ...user, emailTestVerified: true } } } });
    await stale.page.locator("#emailCode").fill("wrong-user-code");
    await stale.page.locator("#emailVerify").click();
    await stale.page.waitForFunction(() => document.querySelector("#emailResult").textContent.includes("返回数据不完整"));
    assert.match(await stale.page.locator("#accountIdentity").innerText(), /other@example.com/);
    assert.equal(await stale.page.evaluate(() => window.userEvents.some(user => user && user.emailTestVerified)), false);
    stale.state.handlers["auth-config"] = route => route.fulfill({ status: 503, json: { error: { message: "邮箱配置暂不可用" } } });
    await refresh(stale.page);
    assert(await stale.page.locator("#emailRequest").isDisabled());
    assert.match(await stale.page.locator("#emailModeNote").innerText(), /邮箱配置暂不可用/);
    assert.deepEqual(stale.state.errors, []);
    await stale.context.close();

    const donor = "0x" + "12".repeat(20), pool = "0x" + "34".repeat(20), donationId = "0x" + "78".repeat(32);
    const policy = await fixture(browser, { ...user, wallet: donor });
    const readyConfig = { ready: true, chainId: 10143, chainHex: "0x279f", contractAddress: pool, operationBlockReason: "V2 + Gas policy pending", purposes: [] };
    const donation = { id: donationId, amountMon: "1", unallocatedMon: "1", status: "CONFIRMED", purpose: 0 };
    const transaction = { from: donor, to: pool, chainId: "0x279f", data: "0x1234", value: "0x0" };
    policy.state.handlers.config = route => route.fulfill({ json: { data: readyConfig } });
    policy.state.handlers.dashboard = route => route.fulfill({ json: { data: { ready: true, chainId: 10143, contractAddress: pool, totals: { donatedMon: "1" } } } });
    policy.state.handlers.me = route => route.fulfill({ json: { data: { user: policy.state.user, donations: [donation], totals: { donatedMon: "1" } } } });
    policy.state.handlers["donations/refund"] = route => route.fulfill({ json: { data: { transaction } } });
    policy.state.handlers["donations/prepare"] = route => route.fulfill({ json: { data: { id: "0x" + "90".repeat(32), transaction: { ...transaction, value: "0xde0b6b3a7640000" } } } });
    await refresh(policy.page);
    await policy.page.evaluate(() => { document.querySelector("#view-home").hidden = false; });
    await policy.page.locator("#walletConnect").click();
    await policy.page.waitForFunction(() => !document.querySelector("#walletConnect").disabled);
    assert.equal(await policy.page.locator('#donateFields [name="amountMon"]').isDisabled(), false, "Undefined flag remains compatible");
    await policy.page.locator('#donateForm [name="amountMon"]').fill("1");
    await policy.page.locator("#donateSubmit").click();
    await policy.page.waitForFunction(() => !document.querySelector("#donationSend").disabled);
    readyConfig.newOperationsEnabled = false;
    await policy.page.evaluate(() => document.querySelector("#donationSend").dispatchEvent(new Event("click")));
    await policy.page.waitForFunction(() => document.querySelector("#donateResult").textContent.includes("V2 + Gas policy pending"));
    assert.equal(await policy.page.evaluate(() => window.walletTransactions.length), 0, "Recheck policy before broadcasting new funds");
    await refresh(policy.page);
    assert(await policy.page.locator('#donateFields [name="amountMon"]').isDisabled());
    assert(await policy.page.locator("#donationSend").isDisabled());
    assert.equal(await policy.page.locator("#donationAvailability").innerText(), readyConfig.operationBlockReason);
    assert.equal(await policy.page.locator("#walletSyncStatus").innerText(), "已同步", "Policy does not mask chain sync");
    const prepares = policy.count("donations/prepare"), queries = policy.count("me");
    await policy.page.evaluate(() => document.querySelector("#donateForm").dispatchEvent(new Event("submit", { cancelable: true })));
    assert.equal(policy.count("donations/prepare"), prepares, "Disabled new donations never prepare");
    await policy.page.locator("#accountRetry").click();
    await policy.page.waitForFunction(() => document.querySelector("#accountEscrow").textContent === "1 MON");
    await refresh(policy.page);
    assert(policy.count("me") > queries, "Account queries remain available");
    assert.match(await policy.page.locator("#donationList").innerText(), /1 MON/);
    await policy.page.locator("#donationCancel").click();
    await policy.page.locator('[data-donation-action="refund"]').click();
    await policy.page.waitForFunction(() => !document.querySelector("#donationSend").disabled);
    assert.equal(policy.count("donations/refund"), 1, "Existing funds can prepare a refund");
    assert(await policy.page.locator('#donateFields [name="amountMon"]').isDisabled(), "Refund preview does not enable new donations");
    await policy.page.locator("#donationSend").click();
    await policy.page.waitForFunction(() => document.querySelector("#donateResult").textContent.includes("合约调用已发送"));
    assert.deepEqual(await policy.page.evaluate(() => window.walletTransactions), [transaction], "Refund still reaches wallet with policy disabled");
    readyConfig.newOperationsEnabled = true; await refresh(policy.page);
    assert.equal(await policy.page.locator('#donateFields [name="amountMon"]').isDisabled(), false);
    assert.deepEqual(policy.state.errors, []);
    await policy.context.close();
    console.log("wallet email UI: verification, recovery, busy/stale guards, drafts/focus, layouts, and donation policy with refunds/queries passed");
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
