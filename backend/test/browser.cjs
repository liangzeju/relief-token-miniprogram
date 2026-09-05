const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const base = process.env.TEST_BASE_URL || "http://localhost:18787";
const output = process.env.TEST_OUTPUT_DIR ? path.resolve(process.env.TEST_OUTPUT_DIR) : path.resolve(__dirname, "../../test-output");
fs.mkdirSync(output, { recursive: true });

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + "/mobile/");
    await page.waitForFunction(() => document.querySelector("#walletSyncStatus").textContent === "未部署");
    const configResponse = await page.request.get(base + "/v1/wallet/config");
    assert.equal(configResponse.status(), 200);
    const config = (await configResponse.json()).data;
    assert.equal(config.ready, false);
    assert.equal(config.contractAddress, null, "Run this regression with a fresh, undeployed DATA_DIR");
    for (const id of ["poolMonValue", "escrowMonValue", "availableMonValue", "participantValue"]) {
      assert.equal(await page.locator("#" + id).innerText(), "0", `${id} must exclude demo funds`);
    }
    assert.equal(await page.locator('#donateFields [name="amountMon"]').isDisabled(), true);
    const account = (await (await page.request.get(base + "/v1/wallet/me")).json()).data;
    assert.equal(account.user, null);
    await page.waitForFunction(() => document.querySelector("#connection").dataset.state === "online");
    assert((await page.locator("#homeTaskList article").count()) > 0, "Home task previews must remain available");
    assert((await page.locator("#articleList article").count()) > 0, "News must remain available");
    assert((await page.locator("#articleList a[target=_blank]").count()) > 0, "News must retain source links");
    assert.equal(await page.locator("#poolMonValue").innerText(), "0", "Catalogue refresh must not overwrite the wallet pool");
    await page.screenshot({ path: path.join(output, "mobile-home.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Home overflows mobile viewport");
    await page.locator('.bottom-nav a[href="#market"]').click();
    await page.locator("#marketList article").first().waitFor();
    assert.equal(await page.locator("#marketList article").count(), 12);
    const images = await page.locator("#marketList img").evaluateAll(async nodes => {
      nodes.forEach(img => { img.loading = "eager"; });
      await Promise.all(nodes.map(img => img.decode().catch(() => {})));
      return nodes.map(img => ({ loaded: img.complete && img.naturalWidth > 0, src: img.src }));
    });
    assert(images.length >= 12 && images.every(img => img.loaded), "Catalogue image failed to load");
    await page.screenshot({ path: path.join(output, "mobile-market.png"), fullPage: true });
    await page.locator("#marketSearch").fill("不存在的物资");
    assert.equal(await page.locator("#marketList article").count(), 0);
    await page.locator("#marketSearch").fill("饮用水");
    assert.equal(await page.locator("#marketList article").count(), 1);
    await page.reload();
    await page.locator("#marketList article").first().waitFor();
    assert.equal(await page.locator("#view-market").isVisible(), true, "Hash route not preserved");
    await page.locator("#marketSearch").fill("");
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.screenshot({ path: path.join(output, "desktop-market.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Market overflows ${width}px`);
    }
    const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    admin.on("pageerror", error => errors.push(error.message));
    await admin.goto(base + "/admin/#market-orders");
    assert.ok(process.env.TEST_ADMIN_TOKEN, "Set TEST_ADMIN_TOKEN for the isolated browser test server");
    await admin.locator("#waToken").fill(process.env.TEST_ADMIN_TOKEN);
    await admin.locator('#waLogin button[type="submit"]').click();
    await admin.waitForFunction(() => document.querySelector("#connectionStatus").textContent.includes("已同步"));
    assert.equal(await admin.locator("#marketRows .resource-card").count(), 12);
    await admin.locator("#market-orders").scrollIntoViewIfNeeded();
    await admin.screenshot({ path: path.join(output, "admin-orders.png") });
    assert.deepEqual(errors, []);
    console.log("Browser layout/navigation/images PASS", output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
