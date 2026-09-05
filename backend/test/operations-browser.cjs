"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { Wallet } = require("ethers");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-operations-browser-"));
  const output = path.resolve(__dirname, "../../test-output/operations"); fs.mkdirSync(output, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = "http://localhost:" + port;
  const env = { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DATA_DIR: directory, NODE_ENV: "test",
    RELIEF_ADMIN_TOKEN: token, RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false", RELIEF_MAIL_MODE: "local-test",
    MONAD_PROCUREMENT_POOL_ADDRESS: "0x" + "12".repeat(20), MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const name of ["NODE_OPTIONS", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK"]) delete env[name];
  let child, browser, stderr = "";
  try {
    child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", part => { stderr += part; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Startup timeout " + stderr)), 15000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error("Backend exit " + code + ": " + stderr)); });
      child.stdout.on("data", part => { if (String(part).includes("backend listening")) { clearTimeout(timeout); resolve(); } });
    });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const adminHeaders = { "X-Relief-Actor": "admin" };
    async function data(response, status = 200) { const json = await response.json(); assert.equal(response.status(), status, JSON.stringify(json)); return json.data; }
    await data(await admin.request.post(base + "/v1/admin/session", { headers: adminHeaders, data: { token } }));
    const errors = [];
    const managerPage = await admin.newPage(); managerPage.on("pageerror", error => errors.push(error.message));
    await managerPage.goto(base + "/admin/#operators-admin");
    await managerPage.locator("#op-admin-private").waitFor({ state: "visible" });
    async function actor(role, organizationId) {
      const wallet = Wallet.createRandom(), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const email = role + "@example.com";
      const user = (await data(await context.request.post(base + "/v1/wallet/register", { data: { name: role, email, password: "Password-browser-12345" } }), 201)).user;
      const challenge = await data(await context.request.post(base + "/v1/wallet/challenge", { data: { address: wallet.address } }));
      await data(await context.request.post(base + "/v1/wallet/verify", { data: { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) } }));
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      if (role === "supplier") {
        await managerPage.locator("#op-admin-email").fill(email);
        await managerPage.locator("#op-admin-org").fill(organizationId);
        await managerPage.locator("#op-admin-role").selectOption(role);
        await managerPage.locator("#op-admin-invite").click();
        await managerPage.locator("#op-admin-code-list code").waitFor();
        const code = await managerPage.locator("#op-admin-code-list code").innerText();
        await page.goto(base + "/mobile/#account");
        await page.locator("#op-mobile-code").fill(code);
        await page.locator("#op-mobile-claim").click();
        await page.locator("#op-mobile-details").waitFor({ state: "visible" });
        assert.ok((await page.locator("#op-mobile-details").innerText()).includes(organizationId));
        for (const width of [320, 390, 768]) {
          await page.setViewportSize({ width, height: 844 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "role page overflow " + width);
        }
        await page.screenshot({ path: path.join(output, "mobile-operator.png"), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
      } else {
        const invitation = await data(await admin.request.post(base + "/v1/platform/operators/invitations", { headers: adminHeaders, data: { email, organizationId, role } }), 201);
        await data(await context.request.post(base + "/v1/platform/operators/claim", { data: { code: invitation.code } }));
      }
      let wrongWallet = false, signed = 0;
      await page.exposeFunction("testWalletRequest", async ({ method, params }) => {
        if (method === "eth_requestAccounts") return [wrongWallet ? Wallet.createRandom().address : wallet.address];
        if (method === "eth_chainId") return "0x279f";
        if (method === "eth_signTypedData_v4") {
          signed++; const typed = JSON.parse(params[1]); const { EIP712Domain, ...types } = typed.types;
          return wallet.signTypedData(typed.domain, types, typed.message);
        }
        throw new Error("Unexpected wallet method " + method);
      });
      await page.addInitScript(() => { window.ethereum = { isMetaMask: true, request: request => window.testWalletRequest(request) }; });
      await page.goto(base + "/operations/");
      await page.locator("#workspace").waitFor({ state: "visible" });
      return { context, page, wallet, user, setWrong(value) { wrongWallet = value; }, get signed() { return signed; } };
    }
    const supplier = await actor("supplier", "supplier-org"), dispatcher = await actor("dispatcher", "platform-org"), buyer = await actor("contract_approver", "platform-org");
    const adminPage = await admin.newPage(); adminPage.on("pageerror", error => errors.push(error.message));
    await adminPage.goto(base + "/operations/?mode=admin"); await adminPage.locator("#workspace").waitFor({ state: "visible" });
    assert.equal(await adminPage.locator("#quoteForm").isVisible(), false);
    assert.equal(await adminPage.locator("#reservationForm").isVisible(), false);
    const guest = await browser.newContext(), guestPage = await guest.newPage();
    await guestPage.goto(base + "/operations/"); await guestPage.locator("#gate").waitFor({ state: "visible" });
    assert.equal(await guestPage.locator("#workspace").isVisible(), false);
    const deadline = minutes => { const date = new Date(Date.now() + minutes * 60000); date.setSeconds(0, 0); const pad = x => String(x).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
    await supplier.page.locator('#quoteForm [name="resourceId"]').selectOption("MAT-WATER");
    await supplier.page.locator('#quoteForm [name="unitPriceMon"]').fill("12");
    await supplier.page.locator('#quoteForm [name="availableQuantity"]').fill("10");
    await supplier.page.locator('#quoteForm [name="etaHours"]').fill("2");
    await supplier.page.locator('#quoteForm [name="validUntil"]').fill(deadline(120));
    // Lose the response after the server commits, then retry the same UI intent.
    await supplier.page.route("**/v1/platform/quotes", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
    await supplier.page.locator('#quoteForm button[type="submit"]').click();
    await supplier.page.waitForFunction(() => { const node = document.querySelector("#quoteForm .form-result"); return node.textContent && node.textContent !== "正在提交"; });
    await supplier.page.locator('#quoteForm button[type="submit"]').click();
    await supplier.page.waitForFunction(() => document.querySelector("#quoteForm .form-result").dataset.success === "true");
    let snapshot = await data(await supplier.context.request.get(base + "/v1/platform/procurement"));
    assert.equal(snapshot.quotes.length, 1, "UI response loss must not duplicate quote");
    const quoteId = snapshot.quotes[0].id;
    await supplier.page.locator("#quoteList img").scrollIntoViewIfNeeded();
    await supplier.page.waitForFunction(() => { const image = document.querySelector("#quoteList img"); return image?.complete && image.naturalWidth > 0; });
    assert.equal(await supplier.page.locator("#quoteList img").evaluate(image => image.complete && image.naturalWidth > 0), true);
    await supplier.page.screenshot({ path: path.join(output, "supplier-quote.png"), fullPage: true });
    await dispatcher.page.locator("#refresh").click();
    await dispatcher.page.waitForFunction(id => !!document.querySelector(`[data-reserve="${id}"]`), quoteId);
    await dispatcher.page.locator(`[data-reserve="${quoteId}"]`).click();
    await dispatcher.page.locator('#reservationForm [name="taskId"]').selectOption("TASK-001");
    await dispatcher.page.locator('#reservationForm [name="buyerWallet"]').selectOption(buyer.wallet.address);
    await dispatcher.page.locator('#reservationForm [name="quantity"]').fill("10");
    await dispatcher.page.locator('#reservationForm button[type="submit"]').click();
    await dispatcher.page.waitForFunction(() => document.querySelector("#reservationForm .form-result").dataset.success === "true");
    snapshot = await data(await dispatcher.context.request.get(base + "/v1/platform/procurement"));
    const reservationId = snapshot.reservations[0].id;
    assert.equal(snapshot.quotes[0].availableQuantity, 0);
    await buyer.page.goto(base + "/operations/#contracts"); await buyer.page.locator("#contractForm").waitFor({ state: "visible" });
    await buyer.page.locator('#contractForm [name="reservationId"]').selectOption(reservationId);
    await buyer.page.locator('#contractForm [name="expiresAt"]').fill(deadline(60));
    const termsText = "饮用水10箱，每箱12 MON。交付至指定安置点；按实际验收批次结算。<script>window.bad=1</script>";
    await buyer.page.locator('#contractForm [name="termsText"]').fill(termsText);
    await buyer.page.locator('#contractForm [name="acceptanceText"]').fill("逐箱核对数量、封装、有效期和签收材料；缺损批次进入争议复核。");
    await buyer.page.locator('#contractForm button[type="submit"]').click();
    await buyer.page.waitForURL(/#contract\//); await buyer.page.locator("#signatureForm").waitFor({ state: "visible" });
    assert.ok((await buyer.page.locator("#contractDetail").innerText()).includes(termsText));
    assert.equal(await buyer.page.evaluate(() => window.bad), undefined);
    assert.ok((await buyer.page.locator("#contractDetail").innerText()).includes("120.0"));
    const contractUrl = buyer.page.url();
    await buyer.page.reload(); await buyer.page.locator("#signatureForm").waitFor({ state: "visible" });
    buyer.setWrong(true);
    await buyer.page.locator('#signatureForm [name="reviewed"]').check();
    await buyer.page.locator('#signatureForm button[type="submit"]').click();
    await buyer.page.waitForFunction(() => document.querySelector("#signatureForm .form-result").textContent.includes("当前钱包不是"));
    assert.equal(buyer.signed, 0);
    buyer.setWrong(false); await buyer.page.locator('#signatureForm button[type="submit"]').click();
    await buyer.page.waitForFunction(() => document.querySelector("#contractDetail").textContent.includes("待另一方签署"));
    assert.equal(await buyer.page.locator("#signatureForm").isVisible(), false, "already signed buyer must not sign again");
    await supplier.page.goto(contractUrl); await supplier.page.locator("#signatureForm").waitFor({ state: "visible" });
    for (const width of [320, 390, 768, 1440]) {
      await supplier.page.setViewportSize({ width, height: 900 });
      assert.equal(await supplier.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "overflow at " + width);
    }
    await supplier.page.setViewportSize({ width: 390, height: 844 });
    await supplier.page.screenshot({ path: path.join(output, "mobile-contract.png"), fullPage: true });
    await supplier.page.locator('#signatureForm [name="reviewed"]').check();
    await supplier.page.locator('#signatureForm button[type="submit"]').click();
    await supplier.page.waitForFunction(() => document.querySelector("#contractDetail").textContent.includes("双签完成，待链上锁款"));
    snapshot = await data(await buyer.context.request.get(base + "/v1/platform/procurement"));
    assert.equal(snapshot.contracts[0].status, "FUNDS_RESERVABLE"); assert.equal(snapshot.escrows.length, 0); assert.equal(snapshot.payments.length, 0);
    assert.equal(supplier.signed, 1); assert.equal(buyer.signed, 1);
    await adminPage.goto(base + "/operations/?mode=admin#contracts"); await adminPage.locator("#contractRows a").waitFor();
    await adminPage.locator("#refresh").click();
    await adminPage.waitForFunction(() => document.querySelector("#contractRows").textContent.includes("供方已签"));
    assert.ok((await adminPage.locator("#contractRows").innerText()).includes("采购已签"));
    await adminPage.locator("#contractRows a").click();
    await adminPage.waitForFunction(() => document.querySelector("#contractDetail").textContent.includes("双签完成"));
    assert.equal(await adminPage.locator("#signatureForm").isVisible(), false);
    await adminPage.screenshot({ path: path.join(output, "admin-contract.png"), fullPage: true });
    await managerPage.locator("#op-admin-refresh").click();
    const revoke = managerPage.locator(`#op-admin-list [data-user-id="${supplier.user.id}"] .op-admin-revoke`);
    await revoke.waitFor(); managerPage.once("dialog", dialog => dialog.accept()); await revoke.click();
    await managerPage.waitForFunction(() => document.querySelector("#op-admin-result").textContent.includes("岗位已撤销"));
    await supplier.page.locator("#refresh").click(); await supplier.page.locator("#gate").waitFor({ state: "visible" });
    assert.equal(await supplier.page.locator("#contractDetail").innerText(), "");
    await managerPage.locator("#waLogout").click();
    assert.equal(await managerPage.locator("#op-admin-code-list code").count(), 0);
    assert.deepEqual(errors, []);
    process.stdout.write("PASS operations browser: real HTTP roles, lost-response retry, reservation, readable contract, genuine EIP712 double signatures, admin read-only, revoked privacy, 320/390/768/1440px. No RPC transfer or public-chain proof.\n");
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("relief-operations-browser-")); fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
