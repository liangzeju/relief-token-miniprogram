"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-auth-browser-"));
  const output = path.resolve(__dirname, "../../test-output/auth-linkage");
  fs.mkdirSync(output, { recursive: true });
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://localhost:${port}`, token = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DATA_DIR: dataDir,
    RELIEF_ADMIN_TOKEN: token, RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false",
    RELIEF_MAIL_MODE: "local-test", NODE_ENV: "test", MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const name of ["MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "NODE_OPTIONS"]) delete env[name];
  let child, browser, stderr = "";
  try {
    child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout: " + stderr)), 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error("Server exit " + code + ": " + stderr)); });
      child.stdout.on("data", chunk => { if (String(chunk).includes("backend listening")) { clearTimeout(timer); resolve(); } });
    });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await context.newPage(), admin = await context.newPage(), errors = [];
    for (const page of [mobile, admin]) page.on("pageerror", error => errors.push(error.message));
    await admin.setViewportSize({ width: 1440, height: 1000 });
    await mobile.goto(base + "/mobile/#account");
    await admin.goto(base + "/admin/#wallet-admin");
    await admin.waitForFunction(() => document.querySelector("#connectionStatus").textContent.includes("请先验证"));
    await mobile.locator("#loginOpenBtn").click();
    await mobile.locator("#authRegisterTab").click();
    const email = "browser-" + crypto.randomUUID() + "@example.com";
    await mobile.locator('#authForm [name="name"]').fill("账户联动测试");
    await mobile.locator('#authForm [name="email"]').fill(email);
    await mobile.locator('#authForm [name="password"]').fill("Password-before-123");
    await mobile.locator("#authSubmit").click();
    await mobile.locator("#loginDialog").waitFor({ state: "hidden" });
    await mobile.waitForFunction(() => document.querySelector("#accountName").textContent === "账户联动测试");
    await admin.locator("#waToken").fill(token);
    await admin.locator('#waLogin button[type="submit"]').click();
    await admin.waitForFunction(() => document.querySelector("#waAuth").textContent === "已验证");
    await admin.waitForFunction(() => document.querySelector("#connectionStatus").textContent.includes("已同步"));
    assert.equal(await admin.locator("#waDeploy").isDisabled(), true);
    assert.equal(await admin.locator("#runNextBtn").isDisabled(), true);
    assert.equal((await mobile.request.get(base + "/v1/overview")).status(), 403);
    await mobile.locator("#emailRequest").click();
    await mobile.waitForFunction(() => document.querySelector("#emailResult").textContent.length > 0);
    const mailbox = async () => {
      const response = await admin.request.get(base + "/v1/wallet/admin/test-mailbox", { headers: { "X-Relief-Actor": "admin" } });
      assert.equal(response.status(), 200); return (await response.json()).data.messages;
    };
    const verification = (await mailbox()).find(mail => mail.to === email && mail.purpose === "email-verification");
    assert.ok(verification);
    assert.equal((await mobile.request.get(base + "/v1/wallet/admin/test-mailbox")).status(), 403);
    await admin.locator("#waTestMailbox summary").click();
    await admin.locator("#waMailRefresh").click();
    await admin.waitForFunction(address => document.querySelector("#waMailRows").textContent.includes(address), email);
    await mobile.locator("#emailCode").fill(verification.code);
    await mobile.locator("#emailVerify").click();
    await mobile.waitForFunction(() => document.querySelector("#accountIdentity").textContent.includes("测试邮箱已验证"));
    const user = (await (await mobile.request.get(base + "/v1/wallet/me")).json()).data.user;
    assert.equal(user.emailVerified, false); assert.equal(user.emailTestVerified, true);
    await mobile.reload();
    await mobile.waitForFunction(() => document.querySelector("#accountIdentity").textContent.includes("测试邮箱已验证"));
    await admin.reload();
    await admin.waitForFunction(() => document.querySelector("#waAuth").textContent === "已验证");
    await admin.waitForFunction(() => document.querySelector("#connectionStatus").textContent.includes("已同步"));
    await mobile.screenshot({ path: path.join(output, "mobile-verified.png"), fullPage: true });
    for (const width of [320, 390, 768]) {
      await mobile.setViewportSize({ width, height: 844 });
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`);
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.locator('.bottom-nav a[href="#market"]').click();
    await mobile.locator('[data-item="MAT-WATER"]').click();
    await mobile.waitForFunction(() => location.hash === "#resource/MAT-WATER" && document.querySelector("#detailDialog").open && document.querySelector("#detailContent").textContent.includes("采购主体"));
    assert.equal(await mobile.locator("#orderForm").count(), 0);
    assert.match(await mobile.locator("#detailContent").innerText(), /采购主体/);
    await mobile.screenshot({ path: path.join(output, "mobile-catalog.png"), fullPage: true });
    await mobile.locator('#detailDialog [data-close]').click();
    await mobile.locator('.bottom-nav a[href="#account"]').click();
    await mobile.locator("#logoutBtn").click();
    await mobile.waitForFunction(() => document.querySelector("#accountName").textContent === "未登录");
    assert.equal((await admin.request.get(base + "/v1/overview", { headers: { "X-Relief-Actor": "admin" } })).status(), 200);
    await mobile.locator("#loginOpenBtn").click();
    await mobile.locator("#forgotPassword").click();
    await mobile.locator("#resetEmail").fill(email);
    await mobile.locator("#passwordRequest").click();
    await mobile.waitForFunction(() => document.querySelector("#passwordResult").textContent.length > 0);
    const reset = (await mailbox()).find(mail => mail.to === email && mail.purpose === "password-reset");
    assert.ok(reset);
    await mobile.locator("#resetCode").fill(reset.code);
    await mobile.locator("#resetPassword").fill("Password-after-456");
    await mobile.screenshot({ path: path.join(output, "mobile-reset.png"), fullPage: true });
    await mobile.locator("#passwordReset").click();
    await mobile.locator("#authPanel").waitFor({ state: "visible" });
    assert.equal((await (await mobile.request.get(base + "/v1/wallet/me")).json()).data.user, null);
    await mobile.locator('#authForm [name="email"]').fill(email);
    await mobile.locator('#authForm [name="password"]').fill("Password-after-456");
    await mobile.locator("#authSubmit").click();
    await mobile.locator("#loginDialog").waitFor({ state: "hidden" });
    await mobile.waitForFunction(() => document.querySelector("#accountName").textContent === "账户联动测试");
    await admin.screenshot({ path: path.join(output, "admin-session.png"), fullPage: true });
    await admin.locator("#waLogout").click();
    await admin.waitForFunction(() => document.querySelector("#connectionStatus").textContent.includes("请先验证"));
    assert.equal(await admin.locator("#donationRows tr").count(), 0);
    assert.equal(await admin.locator("#waMailRows tr").count(), 0);
    assert.equal((await (await mobile.request.get(base + "/v1/wallet/me")).json()).data.user.id, user.id);
    assert.deepEqual(errors, []);
    console.log("PASS: same-context admin/donor isolation, test-email verification, password recovery, session reload/logout, catalogue ownership and responsive checks");
    console.log("Screenshots: " + output);
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("relief-auth-browser-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
