"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { id } = require("ethers");
const { fixture } = require("./helpers/funding-read-fixture.cjs");

(async () => {
  const f = await fixture(); let browser;
  try {
    const donor = await f.user("BrowserDonor"), recorded = f.prepare(donor, "browser-recorded");
    for (let n = 0; n < 27; n++) f.prepare(donor, `browser-prepared-${n}`, { purpose: 2 });
    f.received(recorded);
    f.append("TaskRegistered", { taskId: id("browser-task"), purpose: 1, projectId: id("browser-project") });
    f.append("DonationAllocated", { taskId: id("browser-task"), donationId: recorded.permit.donationId, amountWei: "50000000000000000000" });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(f.base + "/admin/#wallet-donations");
    await page.locator("#waToken").fill(f.token); await page.locator("#waLogin button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#fr-page").textContent.includes("28"));
    assert.equal(await page.locator("#fr-list tbody tr").count(), 25);
    assert.ok((await page.locator("#fr-summary").innerText()).includes("100.000000000000000001"));
    await page.locator("#fr-next").click(); await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 3);
    await page.locator("#fr-prev").click(); await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 25);
    await page.locator("#fr-status-filter").selectOption("RECORDED");
    await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 1);
    await page.locator("#fr-list a[href^='#wallet-donation/']").click();
    await page.waitForFunction(() => document.querySelector("#fr-detail")?.textContent.includes("browserdonor@example.test"));
    assert.equal(await page.locator("#fr-activity tbody tr").count(), 2);
    assert.ok((await page.locator("#fr-detail").innerText()).includes("50.000000000000000000"));
    await page.reload(); await page.waitForFunction(() => document.querySelector("#fr-activity tbody")?.children.length === 2);
    const output = path.resolve(__dirname, "../../../outputs/funding-read-browser"); fs.mkdirSync(output, { recursive: true });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator("#wallet-donations").scrollIntoViewIfNeeded();
      const layout = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth,
        root: document.querySelector("#wallet-donations").getBoundingClientRect().toJSON() }));
      assert.ok(layout.body <= width + 1, JSON.stringify(layout)); assert.ok(layout.root.width > 0);
      await page.screenshot({ path: path.join(output, `detail-${width}.png`), fullPage: false });
    }
    await page.locator("#fr-back").click();
    await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 25);
    await page.locator("#fr-status-filter").selectOption("RECORDED");
    await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 1);
    assert.equal(await page.locator("#fr-status-filter").inputValue(), "RECORDED");
    await page.evaluate(hash => { location.hash = hash; }, "#wallet-donation/" + id("missing"));
    await page.waitForFunction(() => document.querySelector("#fr-status").textContent.includes("未找到"));
    assert.equal(await page.locator("#fr-detail").innerText(), "");
    await page.evaluate(() => { location.hash = "#wallet-donations"; });
    await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 1);
    await page.route("**/v1/funding/admin/donations?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { message: "Injected storage failure" } }) }));
    await page.locator("#fr-refresh").click(); await page.waitForFunction(() => document.querySelector("#fr-status").textContent.includes("Injected"));
    assert.equal(await page.locator("#fr-list").innerText(), ""); assert.equal(await page.locator("#fr-summary").innerText(), "");
    await page.unroute("**/v1/funding/admin/donations?*");
    await page.locator("#fr-refresh").click(); await page.waitForFunction(() => document.querySelector("#fr-list tbody")?.children.length === 1);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), delayed = new Promise(resolve => { release = resolve; });
    await page.route("**/v1/funding/admin/donations?*", async route => {
      const response = await route.fetch(); entered(); await delayed;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.locator("#fr-refresh").click(); await started;
    await page.locator("#waLogout").click(); await page.waitForFunction(() => document.querySelector("#fr-private").hidden);
    release(); await page.unrouteAll({ behavior: "wait" });
    assert.equal(await page.locator("#fr-detail").innerText(), ""); assert.equal(await page.locator("#fr-list").innerText(), "");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "PASS", actualBackend: true, noPublicChain: true, viewports: [320, 390, 768, 1440], screenshots: output }));
  } finally { await browser?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
