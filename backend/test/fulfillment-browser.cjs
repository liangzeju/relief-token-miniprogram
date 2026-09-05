"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { fixture, evidencePng } = require("./helpers/fulfillment-fixture.cjs");

async function main() {
  const f = await fixture(); let browser;
  const output = path.resolve(__dirname, "../../test-output/fulfillment"); fs.mkdirSync(output, { recursive: true });
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const errors = [];
    async function pageFor(person, hash = "fulfillment", prepare) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addCookies(person.cookie.split("; ").map(cookie => {
        const index = cookie.indexOf("="); return { name: cookie.slice(0, index), value: cookie.slice(index + 1), url: f.base, httpOnly: true, sameSite: "Strict" };
      }));
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      if (prepare) await prepare(page);
      await page.goto(f.base + "/operations/" + (person.admin ? "?mode=admin" : "") + "#" + hash);
      await page.locator("#workspace").waitFor({ state: "visible" });
      return page;
    }
    const supplier = await pageFor(f.supplier);
    assert.equal(await supplier.locator('#deliveryForm [name="contractId"] option[value="C-F"]').count(), 0);
    assert.ok((await supplier.locator("#deliveryAvailability").innerText()).length);
    f.seedLock();
    await supplier.locator("#refresh").click();
    await supplier.locator('#deliveryForm [name="contractId"] option[value="C-F"]').waitFor({ state: "attached" });
    await supplier.locator('#deliveryForm [name="contractId"]').selectOption("C-F");
    await supplier.locator('#deliveryForm [name="quantity"]').fill("4");
    const statement = '交付四箱饮用水，封条待验收。<img src=x onerror="window.badEvidence=true">';
    await supplier.locator('#deliveryForm [name="statement"]').fill(statement);
    await supplier.locator("#deliveryFiles").setInputFiles([
      { name: "delivery-photo.png", mimeType: "image/png", buffer: evidencePng },
      { name: "delivery-label.png", mimeType: "image/png", buffer: evidencePng }
    ]);
    const response = supplier.waitForResponse(r => r.url().endsWith("/v1/platform/procurement"));
    await supplier.locator("#refresh").click(); await response;
    assert.equal(await supplier.locator('#deliveryForm [name="quantity"]').inputValue(), "4");
    assert.equal(await supplier.locator('#deliveryForm [name="statement"]').inputValue(), statement);
    const uploadRequests = []; let lostUploadResponse = false;
    await supplier.route("**/v1/platform/contracts/C-F/evidence", async route => {
      const input = route.request().postDataJSON(); uploadRequests.push({ id: input.id, filename: input.filename, key: route.request().headers()["idempotency-key"] });
      const response = await route.fetch();
      if (input.filename === "delivery-label.png" && !lostUploadResponse) { lostUploadResponse = true; await route.abort("failed"); }
      else await route.fulfill({ response });
    });
    await supplier.locator('#deliveryForm button[type="submit"]').click();
    await supplier.waitForFunction(() => {
      const result = document.querySelector("#deliveryForm .form-result"), button = document.querySelector('#deliveryForm button[type="submit"]');
      return !button.disabled && result.textContent && result.textContent !== "正在提交" && result.dataset.success === "false";
    });
    assert.equal((await f.read()).batches.length, 0, "a partial upload cannot create a delivery");
    assert.equal(await supplier.locator('#deliveryForm [name="statement"]').inputValue(), statement);
    assert.equal(await supplier.locator("#deliveryFiles").evaluate(input => input.files.length), 2);
    await supplier.locator('#deliveryForm button[type="submit"]').click();
    try { await supplier.waitForFunction(() => document.querySelector("#deliveryForm .form-result")?.dataset.success === "true"); }
    catch (error) {
      console.error("Upload retry diagnostics", JSON.stringify({ requests: uploadRequests, result: await supplier.locator("#deliveryForm .form-result").innerText(), version: (await f.read()).version }));
      throw error;
    }
    const batch = (await f.read()).batches[0]; assert.ok(batch);
    assert.equal(new Set(uploadRequests.map(item => item.id)).size, 2);
    const labelRequests = uploadRequests.filter(item => item.filename === "delivery-label.png");
    assert.equal(labelRequests.length, 2); assert.equal(labelRequests[0].id, labelRequests[1].id); assert.equal(labelRequests[0].key, labelRequests[1].key);
    const attached = f.data(await f.request(f.supplier, "/v1/platform/contracts/C-F/attestations"));
    assert.equal(attached[0].evidence.length, 2);
    const attestationUrl = "**/v1/platform/contracts/C-F/attestations";
    const acceptance = await pageFor(f.acceptance, "batch/" + batch.id, page => page.route(attestationUrl,
      route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Evidence unavailable" } }) })));
    await acceptance.waitForFunction(() => document.querySelector("#batchAttestations")?.textContent.includes("暂不可用"));
    assert.equal(await acceptance.locator("#acceptanceForm").isVisible(), false);
    await acceptance.unroute(attestationUrl);
    await acceptance.route(attestationUrl, async route => {
      const response = await route.fetch(), body = await response.json();
      body.data[0].statement = "Changed text without changing its digest";
      await route.fulfill({ response, json: body });
    });
    await acceptance.locator("#refresh").click();
    await acceptance.waitForFunction(() => document.querySelector("#batchAttestations")?.textContent.includes("摘要"));
    assert.equal(await acceptance.locator("#acceptanceForm").isVisible(), false);
    await acceptance.unroute(attestationUrl);
    await acceptance.locator("#refresh").click();
    await acceptance.locator("#acceptanceForm").waitFor({ state: "visible" });
    await acceptance.waitForFunction(text => document.querySelector("#batchAttestations")?.textContent.includes(text), statement);
    assert.equal(await acceptance.locator("#batchAttestations img").count(), 0);
    assert.equal(await acceptance.evaluate(() => window.badEvidence), undefined);
    const evidenceDownloadUrl = "**/v1/platform/evidence/*/content";
    const blockedDownloads = [];
    const trackDownload = download => blockedDownloads.push(download);
    acceptance.on("download", trackDownload);
    await acceptance.route(evidenceDownloadUrl, route => route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from("modified bytes") }));
    await acceptance.locator('[data-testid="evidence-download"]').first().click();
    await acceptance.waitForFunction(() => document.querySelector("#evidenceDownloadStatus")?.textContent.includes("已阻止下载"));
    assert.equal(blockedDownloads.length, 0);
    acceptance.off("download", trackDownload);
    await acceptance.unroute(evidenceDownloadUrl);
    const downloaded = acceptance.waitForEvent("download");
    await acceptance.locator('[data-testid="evidence-download"]').first().click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), "delivery-photo.png");
    assert.deepEqual(fs.readFileSync(await download.path()), evidencePng);
    await acceptance.locator('#acceptanceForm [name="outcome"]').selectOption("PARTIAL");
    await acceptance.locator('#acceptanceForm [name="acceptedQuantity"]').fill("1");
    await acceptance.locator('#acceptanceForm [name="statement"]').fill("逐箱检查后，一箱符合封口标准，另外三箱拒收。");
    await acceptance.locator("#acceptanceFiles").setInputFiles({ name: "acceptance-photo.png", mimeType: "image/png", buffer: evidencePng });
    await acceptance.locator('#acceptanceForm button[type="submit"]').click();
    await acceptance.waitForFunction(() => document.querySelector("#acceptanceForm .form-result")?.dataset.success === "true");
    const finance = await pageFor(f.finance, "batch/" + batch.id);
    await finance.locator("#payableForm").waitFor({ state: "visible" });
    assert.match(await finance.locator("#payableAmount").innerText(), /12\.000000000000000001/);
    assert.equal(await finance.locator("#acceptanceForm").isVisible(), false);
    await finance.locator('#payableForm button[type="submit"]').click();
    await finance.waitForFunction(() => document.querySelector("#payableForm .form-result")?.dataset.success === "true");
    const snapshot = await f.read(); assert.equal(snapshot.payables.length, 1); assert.equal(snapshot.payables[0].amountWei, "12000000000000000001");
    assert.equal(snapshot.payments.length, 0);
    await finance.reload(); await finance.locator("#batchDetail").waitFor({ state: "visible" });
    await finance.waitForFunction(() => document.querySelector("#batchDetail")?.textContent.includes("12.000000000000000001"));
    assert.equal(await finance.locator("#payableForm").isVisible(), false);
    for (const width of [320, 390, 768, 1440]) {
      await finance.setViewportSize({ width, height: 950 });
      assert.ok(await finance.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "batch page overflows " + width);
    }
    await finance.screenshot({ path: path.join(output, "finance-batch-desktop.png"), fullPage: true });
    await finance.setViewportSize({ width: 390, height: 844 });
    await finance.locator("#batchAttestations").scrollIntoViewIfNeeded();
    await finance.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await finance.screenshot({ path: path.join(output, "finance-evidence-mobile.png") });
    await finance.evaluate(() => scrollTo(0, 0));
    await finance.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await finance.screenshot({ path: path.join(output, "finance-batch-mobile.png"), fullPage: true });
    const admin = await pageFor(f.admin, "batch/" + batch.id);
    await admin.locator("#batchDetail").waitFor({ state: "visible" });
    for (const id of ["deliveryForm", "acceptanceForm", "payableForm"]) assert.equal(await admin.locator("#" + id).isVisible(), false);
    const adminDownload = admin.waitForEvent("download");
    await admin.locator('[data-testid="evidence-download"]').first().click();
    assert.deepEqual(fs.readFileSync(await (await adminDownload).path()), evidencePng);
    const outsider = await pageFor(f.outsider, "batch/" + batch.id);
    await outsider.waitForFunction(() => document.querySelector("#batchDetail")?.textContent.includes("无权") || document.querySelector("#batchDetail")?.textContent.includes("不存在"));
    assert.ok(!(await outsider.locator("#batchAttestations").innerText()).includes(statement));
    f.data(await f.request(f.admin, `/v1/platform/operators/${f.finance.user.id}/revoke`, {}));
    await finance.locator("#refresh").click(); await finance.locator("#gate").waitFor({ state: "visible" });
    assert.equal(await finance.locator("#batchDetail").innerText(), "");
    assert.equal(await finance.locator("#batchAttestations").innerText(), "");
    assert.deepEqual(errors, []);
    console.log("PASS fulfillment browser: registered roles, lock gate, delivery draft refresh, partial acceptance, exact payable, escaped statements, deep-link reload, admin read-only, object scope, revoke cleanup, 320/390/768/1440 layouts. Trusted lock fixture only; no chain transaction or payment.");
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
