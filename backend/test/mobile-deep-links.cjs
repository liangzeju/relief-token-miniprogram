"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-deep-links-"));
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = "http://localhost:" + port;
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "test", PUBLIC_BASE_URL: base,
    RELIEF_ENABLE_LEGACY_DEMO: "false", RELIEF_ENABLE_WALLET_PROTOTYPE: "false", MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const name of ["NODE_OPTIONS", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK"]) delete env[name];
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let browser, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Startup timeout: " + stderr)), 15000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error("Backend exit " + code + ": " + stderr)); });
      child.stdout.on("data", chunk => { if (String(chunk).includes("backend listening")) { clearTimeout(timeout); resolve(); } });
    });
    const overview = (await (await fetch(base + "/v1/public/overview")).json()).data;
    const article = overview.disasterUpdates[0], task = overview.tasks[0], resource = overview.marketplace[0];
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));

    await page.goto(base + "/mobile/#article/" + encodeURIComponent(article.id));
    await page.locator("#detailDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#detailTitle").innerText(), article.title);
    await page.reload();
    await page.locator("#detailDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#detailTitle").innerText(), article.title, "Article deep link survives reload");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => location.hash === "#home" && !document.querySelector("#detailDialog").open);

    await page.goto(base + "/mobile/#task/" + encodeURIComponent(task.id));
    await page.locator("#detailDialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#detailContent").innerText(), new RegExp(task.id));
    await page.reload();
    assert.equal(await page.locator("#detailDialog").isVisible(), true, "Task deep link survives reload");

    await page.goto(base + "/mobile/#market");
    await page.locator("#marketSearch").fill(resource.name);
    await page.locator(`[data-item="${resource.id}"]`).click();
    await page.waitForFunction(id => location.hash === "#resource/" + encodeURIComponent(id), resource.id);
    assert.equal(await page.locator("#detailTitle").innerText(), resource.name);
    await page.goBack();
    await page.waitForFunction(() => location.hash === "#market" && !document.querySelector("#detailDialog").open);
    assert.equal(await page.locator("#marketSearch").inputValue(), resource.name, "Browser back preserves in-page search");

    await page.goto(base + "/mobile/#resource/REMOVED-RESOURCE");
    await page.locator("#detailDialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#detailContent").innerText(), /下架、撤回或链接无效/);
    await page.reload();
    assert.match(await page.locator("#detailContent").innerText(), /下架、撤回或链接无效/);
    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log("mobile deep links: article/task/resource reload, history, missing content and 320px layout PASS");
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("relief-deep-links-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
