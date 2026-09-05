"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { Wallet, formatEther } = require("ethers");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-catalog-browser-"));
  const output = path.resolve(__dirname, "../../test-output/live-catalog"); fs.mkdirSync(output, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening"); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = "http://localhost:" + port;
  const env = { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DATA_DIR: directory, NODE_ENV: "test", RELIEF_ADMIN_TOKEN: token, RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false", MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const key of ["NODE_OPTIONS", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "MONAD_PROCUREMENT_POOL_ADDRESS"]) delete env[key];
  let child, browser, stderr = "";
  try {
    child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Startup timeout " + stderr)), 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error("Backend exited " + code + ": " + stderr)); });
      child.stdout.on("data", chunk => { if (String(chunk).includes("backend listening")) { clearTimeout(timer); resolve(); } });
    });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const admin = await browser.newContext(), headers = { "X-Relief-Actor": "admin" };
    async function data(response, status = 200) { const json = await response.json(); assert.equal(response.status(), status, JSON.stringify(json)); return json.data; }
    await data(await admin.request.post(base + "/v1/admin/session", { headers, data: { token } }));
    async function role(name, organizationId) {
      const context = await browser.newContext(), wallet = Wallet.createRandom(), email = name + "@example.com";
      const user = (await data(await context.request.post(base + "/v1/wallet/register", { data: { name, email, password: "Catalog-test-password-123" } }), 201)).user;
      const challenge = await data(await context.request.post(base + "/v1/wallet/challenge", { data: { address: wallet.address } }));
      await data(await context.request.post(base + "/v1/wallet/verify", { data: { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) } }));
      const invite = await data(await admin.request.post(base + "/v1/platform/operators/invitations", { headers, data: { email, organizationId, role: name } }), 201);
      await data(await context.request.post(base + "/v1/platform/operators/claim", { data: { code: invite.code } }));
      return { context, wallet, user };
    }
    const supplier = await role("supplier", "supplier-catalog"), dispatcher = await role("dispatcher", "platform"), buyer = await role("contract_approver", "platform");
    let version = 0;
    async function quote(id, unitPriceWei, options = {}) {
      await data(await supplier.context.request.post(base + "/v1/platform/quotes", { headers: { "Idempotency-Key": id }, data: { id, resourceId: "MAT-WATER", unitPriceWei, availableQuantity: 10, validUntil: Math.floor(Date.now() / 1000) + 3600, etaHours: 2, expectedVersion: version++, ...options } }), 201);
    }
    const price = "12000000000000000001", huge = "900719925474099312345678901234567890";
    await quote("quote-first", price); await quote("quote-second", "13000000000000000000"); await quote("quote-huge", huge);
    const viewer = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await viewer.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + "/mobile/#market");
    await page.waitForFunction(expected => document.querySelector('#marketList [data-quote-summary="MAT-WATER"]')?.textContent.includes(expected), formatEther(price));
    const catalog = await data(await viewer.request.get(base + "/v1/marketplace"));
    assert.ok(catalog.length > 0); assert.equal(await page.locator("#marketList .product").count(), catalog.length);
    assert.ok((await page.locator('#marketList [data-quote-summary="MAT-WATER"]').innerText()).includes("起"));
    assert.ok((await page.locator('#marketList [data-quote-summary="MAT-WATER"]').innerText()).includes("10"));
    await page.locator('[data-item="MAT-WATER"]').click();
    await page.locator('[data-quote-id="quote-huge"]').waitFor();
    assert.ok((await page.locator('[data-quote-id="quote-huge"] .quote-price').innerText()).includes(formatEther(huge)));
    assert.equal(await page.locator("#orderForm").count(), 0);
    assert.equal(await page.locator("#resourceQuotes [data-quote-id]").count(), 3);
    await page.evaluate(() => { window.__quoteRow = document.querySelector('[data-quote-id="quote-first"]'); });
    await data(await dispatcher.context.request.post(base + "/v1/platform/reservations", { headers: { "Idempotency-Key": "reserve-partial" }, data: { id: "partial", quoteId: "quote-first", taskId: "TASK-001", quantity: 4, buyerWallet: buyer.wallet.address, expectedVersion: version++ } }), 201);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-quote-id="quote-first"] .detail-meta div')].some(row => row.querySelector("dt").textContent === "报价可供量" && row.querySelector("dd").textContent.startsWith("6 ")));
    assert.equal(await page.evaluate(() => window.__quoteRow === document.querySelector('[data-quote-id="quote-first"]')), true);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "page overflow " + width);
      assert.equal(await page.locator("#detailDialog").evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false, "dialog overflow " + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, "mobile-quotes.png"), fullPage: true });
    await page.locator('#detailDialog [data-close]').click();
    await page.locator('.bottom-nav [href="#home"]').click();
    await page.waitForFunction(expected => document.querySelector('#resourceList [data-quote-summary="MAT-WATER"]')?.textContent.includes(expected), formatEther(price));
    await page.locator('.bottom-nav [href="#market"]').click();
    await page.locator("#marketSearch").fill("饮用水");
    assert.equal(await page.locator("#marketList .product").count(), 1);
    await page.locator('[data-item="MAT-WATER"]').click();
    await page.route("**/v1/platform/catalog", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Injected unavailable" } }) }));
    await page.waitForFunction(() => document.querySelector("#resourceQuotes .quote-status").textContent.includes("报价不可用"));
    assert.equal(await page.locator("#resourceQuotes [data-quote-id]").count(), 0);
    assert.ok((await page.locator("#resourceQuotes .quote-summary").innerText()).includes("参考价"));
    await page.unroute("**/v1/platform/catalog");
    await page.locator('[data-quote-id="quote-first"]').waitFor();
    await quote("quote-expiring", "1000000000000000000", { validUntil: Math.floor(Date.now() / 1000) + 15 });
    await page.locator('[data-quote-id="quote-expiring"]').waitFor();
    await page.locator('[data-quote-id="quote-expiring"]').waitFor({ state: "detached", timeout: 25000 });
    assert.ok((await page.locator("#resourceQuotes .quote-summary").innerText()).includes(formatEther(price)));
    await data(await admin.request.post(base + `/v1/platform/operators/${supplier.user.id}/revoke`, { headers, data: {} }));
    await page.waitForFunction(() => document.querySelector("#resourceQuotes .quote-summary").textContent.includes("暂无有效供方报价"));
    assert.equal(await page.locator("#resourceQuotes [data-quote-id]").count(), 0);
    assert.deepEqual(await data(await viewer.request.get(base + "/v1/platform/catalog")), []);
    await page.locator('#detailDialog [data-close]').click();
    assert.equal(await page.locator("#marketSearch").inputValue(), "饮用水");
    assert.equal(await page.locator("#marketList .product").count(), 1);
    assert.equal((await data(await viewer.request.get(base + "/v1/wallet/dashboard"))).totals.donatedMon, "0.0");
    assert.deepEqual(errors, []);
    process.stdout.write("PASS live catalog: public exact MON quotes, home/market/detail linkage, partial reservations, stable detail nodes, filtering, failure recovery, expiry, revoked supplier removal and mobile/desktop layout. No payments.\n");
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) { const end = once(child, "exit"); child.kill(); await end; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-catalog-browser-")); fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
