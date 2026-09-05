"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require("playwright");
const ganache = require("ganache");
const { Wallet, getBytes } = require("ethers");

async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-wallet-browser-"));
  const output = path.resolve(__dirname, "../../test-output/wallet");
  fs.mkdirSync(output, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const chain = ganache.server({ chain: { chainId: 10143, hardfork: "merge" }, wallet: { totalAccounts: 5, defaultBalance: 1000 }, logging: { quiet: true } });
  let backend, browser;
  let stderr = "";
  try {
    await chain.listen(0, "127.0.0.1");
    const rpcUrl = `http://127.0.0.1:${chain.address().port}`;
    const port = await freePort(); const base = `http://localhost:${port}`;
    const env = { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, DATA_DIR: dataDir, RELIEF_ADMIN_TOKEN: token, MONAD_RPC_URL: rpcUrl, MONAD_WALLET_RPC_URL: rpcUrl, MONAD_CONFIRMATIONS: "2", RELIEF_ENABLE_WALLET_PROTOTYPE: "true" };
    delete env.MONAD_POOL_ADDRESS; delete env.MONAD_START_BLOCK;
    backend = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    backend.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server timeout ${stderr}`)), 15000);
      backend.once("error", reject); backend.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exit ${code}: ${stderr}`)); });
      backend.stdout.on("data", chunk => { if (String(chunk).includes("backend listening")) { clearTimeout(timer); resolve(); } });
    });
    const keys = Object.entries(chain.provider.getInitialAccounts());
    const [ownerAddress, ownerInfo] = keys[0], [donorAddress, donorInfo] = keys[1], recipient = keys[2][0];
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const errors = [];
    const transactions = [];
    async function walletContext(address, privateKey, viewport) {
      const context = await browser.newContext({ viewport });
      const signer = new Wallet(privateKey);
      await context.exposeBinding("__testWalletRequest", async (_, payload) => {
        if (["eth_requestAccounts", "eth_accounts"].includes(payload.method)) return [address];
        if (payload.method === "personal_sign") return signer.signMessage(getBytes(payload.params[0]));
        if (payload.method === "wallet_switchEthereumChain") { assert.equal(payload.params[0].chainId, "0x279f"); return null; }
        if (payload.method === "eth_sendTransaction") {
          assert.equal(payload.params[0].from.toLowerCase(), address);
          assert.equal(Number(payload.params[0].chainId), 10143);
          const transaction = { ...payload.params[0] };
          transaction.gas = await chain.provider.request({ method: "eth_estimateGas", params: [transaction] });
          const hash = await chain.provider.request({ method: "eth_sendTransaction", params: [transaction] });
          transactions.push(hash);
          await chain.provider.request({ method: "evm_mine", params: [] });
          return hash;
        }
        return chain.provider.request(payload);
      });
      await context.addInitScript(() => {
        const listeners = new Map();
        window.ethereum = { isMetaMask: true, request: payload => window.__testWalletRequest(payload), on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); }, removeListener: (event, fn) => { listeners.set(event, (listeners.get(event) || []).filter(item => item !== fn)); } };
        window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { rdns: "io.metamask", uuid: "test-provider", name: "MetaMask" }, provider: window.ethereum } })));
      });
      context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      return context;
    }
    const adminContext = await walletContext(ownerAddress, ownerInfo.secretKey, { width: 1440, height: 1000 });
    const donorContext = await walletContext(donorAddress, donorInfo.secretKey, { width: 390, height: 844 });
    const admin = await adminContext.newPage(), mobile = await donorContext.newPage();
    await mobile.goto(base + "/mobile/");
    await mobile.waitForFunction(() => document.querySelector("#walletSyncStatus")?.textContent === "未部署");
    assert.equal(await mobile.locator("#poolMonValue").innerText(), "0");
    assert(await mobile.locator('#donateFields input[name="amountMon"]').isDisabled());
    await mobile.screenshot({ path: path.join(output, "home-undeployed.png"), fullPage: true });
    await admin.goto(base + "/admin/#wallet-admin");
    await admin.locator("#waToken").fill(token);
    await admin.locator('#waLogin button[type="submit"]').click();
    await admin.waitForFunction(() => document.querySelector("#waAuth").textContent === "已验证");
    await admin.locator("#waConnect").click();
    await admin.waitForFunction(() => !document.querySelector("#waDeploy").disabled);
    await admin.locator("#waDeploy").click();
    await admin.waitForFunction(() => document.querySelector("#waState").dataset.ready === "true", null, { timeout: 45000 });
    async function configureTask(id, purpose, amount) {
      await admin.locator("#waTaskSetup").evaluate(node => { node.open = true; });
      await admin.locator("#waBusinessTask").selectOption(id);
      await admin.locator("#waPurpose").selectOption(String(purpose));
      await admin.locator("#waTarget").fill(amount);
      await admin.locator("#waRecipient").fill(recipient);
      await admin.locator("#waSaveTask").click();
      await admin.waitForFunction(taskId => document.querySelector("#waTaskRows").textContent.includes(taskId), id, { timeout: 30000 });
    }
    await configureTask("TASK-001", 1, "0.03");
    await configureTask("TASK-002", 2, "1");
    await mobile.locator("#loginOpenBtn").click();
    await mobile.locator("#authRegisterTab").click();
    await mobile.locator('#authForm [name="name"]').fill("钱包联调捐赠人");
    await mobile.locator('#authForm [name="email"]').fill("wallet-browser@example.com");
    await mobile.locator('#authForm [name="password"]').fill("Test-only-passphrase-42");
    await mobile.locator('#authForm [name="organization"]').fill("联调公益组织");
    await mobile.locator("#authSubmit").click();
    await mobile.waitForFunction(() => !document.querySelector("#loginDialog").open);
    await mobile.locator("#walletConnect").click();
    await mobile.waitForFunction(() => !document.querySelector("#walletBind").disabled);
    await mobile.locator("#walletBind").click();
    await mobile.waitForFunction(() => document.querySelector("#walletBind").hidden);
    await mobile.locator('.bottom-nav a[href="#account"]').click();
    await mobile.waitForFunction(() => !document.querySelector("#donateFields").disabled, null, { timeout: 30000 });
    async function donate(amount, purpose) {
      await mobile.locator('#donateForm [name="amountMon"]').fill(amount);
      await mobile.locator("#donationPurpose").selectOption(String(purpose));
      await mobile.locator("#donateSubmit").click();
      await mobile.locator("#donationPreview").waitFor({ state: "visible" });
      const count = transactions.length;
      await mobile.locator("#donationSend").click();
      await mobile.waitForFunction(() => document.querySelector("#donationPreview").hidden, null, { timeout: 30000 });
      assert.equal(transactions.length, count + 1, "Only one transaction per confirmation");
    }
    await donate("0.05", 1);
    await mobile.waitForFunction(() => document.querySelector("#accountEscrow").textContent === "0.05 MON", null, { timeout: 30000 });
    await admin.waitForFunction(() => document.querySelector("#waDonated").textContent === "0.05", null, { timeout: 30000 });
    assert.equal(await admin.locator("#waBalance").innerText(), "0.05");
    assert.equal(await admin.locator("#waAllocated").innerText(), "0.03");
    const privateRows = await admin.locator("#waDonationRows").innerText();
    assert(privateRows.includes("wallet-browser@example.com") && privateRows.includes("钱包联调捐赠人") && privateRows.includes("联调公益组织"));
    assert(privateRows.includes("0.03 MON") && privateRows.includes("0.02 MON"));
    const publicData = await (await fetch(base + "/v1/wallet/dashboard")).text();
    assert(!publicData.includes("wallet-browser@example.com") && !publicData.includes("钱包联调捐赠人"));
    const beforeReload = transactions.length;
    await mobile.reload();
    await mobile.waitForFunction(() => document.querySelector("#accountEscrow").textContent === "0.05 MON");
    assert.equal(transactions.length, beforeReload, "Reload never broadcasts another donation");
    await mobile.locator('.bottom-nav a[href="#home"]').click();
    await mobile.locator("#walletConnect").click();
    await mobile.waitForFunction(() => document.querySelector("#walletNetwork").textContent === "Monad Testnet");
    for (const width of [320, 390, 768, 1440]) {
      await mobile.setViewportSize({ width, height: 900 });
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Home overflow ${width}`);
      await mobile.evaluate(() => window.scrollTo(0, 0));
      await mobile.screenshot({ path: path.join(output, `home-${width}.png`) });
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.locator('.bottom-nav a[href="#account"]').click();
    await mobile.locator('[data-donation-action="refund"]').click();
    await mobile.locator("#donationPreview").waitFor({ state: "visible" });
    await mobile.locator("#donationSend").click();
    await mobile.waitForFunction(() => document.querySelector("#accountAvailable").textContent === "0 MON", null, { timeout: 30000 });
    await admin.waitForFunction(() => document.querySelector("#waBalance").textContent === "0.03", null, { timeout: 30000 });
    assert.equal(await admin.locator("#waDonated").innerText(), "0.05", "Refund does not erase historical donation");
    await mobile.screenshot({ path: path.join(output, "my-donation-refunded.png"), fullPage: true });
    await admin.locator("#wallet-donations").scrollIntoViewIfNeeded();
    await admin.screenshot({ path: path.join(output, "admin-donation.png") });
    for (const width of [390, 768, 1440]) {
      await admin.setViewportSize({ width, height: 1000 });
      assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Admin overflow ${width}`);
    }
    await mobile.locator('.bottom-nav a[href="#market"]').click();
    await mobile.locator("#marketList article").first().waitFor();
    assert.equal(await mobile.locator("#marketList article").count(), 12);
    const images = await mobile.locator("#marketList img").evaluateAll(async nodes => { nodes.forEach(img => { img.loading = "eager"; }); await Promise.all(nodes.map(img => img.decode().catch(() => {}))); return nodes.map(img => img.complete && img.naturalWidth > 0); });
    assert(images.every(Boolean), "Marketplace assets remain loaded");
    const plain = await browser.newPage({ viewport: { width: 390, height: 844 } });
    plain.on("pageerror", error => errors.push(error.message));
    await plain.goto(base + "/mobile/");
    await plain.locator("#walletConnect").click();
    await plain.waitForFunction(() => document.querySelector("#walletNotice").textContent.includes("Chrome/Edge"));
    assert.equal(await plain.locator("#walletInstall").isVisible(), true);
    let releaseResponse, sawPrivateRequest;
    const heldResponse = new Promise(resolve => { releaseResponse = resolve; });
    const intercepted = new Promise(resolve => { sawPrivateRequest = resolve; });
    await admin.route("**/v1/wallet/admin/overview", async route => {
      const response = await route.fetch(); sawPrivateRequest(); await heldResponse; await route.fulfill({ response });
    });
    await admin.locator("#waRefresh").click();
    await intercepted;
    await admin.locator("#waLogout").click();
    const lateResponse = admin.waitForResponse(response => response.url().endsWith("/v1/wallet/admin/overview"));
    releaseResponse(); await lateResponse;
    await admin.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(!(await admin.locator("#waDonationRows").innerText()).includes("wallet-browser@example.com"));
    assert.deepEqual(errors, []);
    console.log("Wallet browser: deploy -> configure -> register -> bind -> donate -> both dashboards -> refund -> no provider PASS");
    console.log("Screenshots:", output);
  } catch (error) {
    if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
      console.error(page.url(), await page.locator("#waMessage, #waState, #authResult, #walletNotice, #donateResult").allTextContents());
      await page.screenshot({ path: path.join(output, `failure-${browser.contexts().indexOf(context)}.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (backend && backend.exitCode === null) { const done = once(backend, "exit"); backend.kill(); await done; }
    await chain.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
