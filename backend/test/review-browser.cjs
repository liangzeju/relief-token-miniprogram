"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { fixture, evidencePng } = require("./helpers/fulfillment-fixture.cjs");

async function main() {
  const f = await fixture(); let browser;
  const output = path.resolve(__dirname, "../../test-output/review"); fs.mkdirSync(output, { recursive: true });
  try {
    f.seedLock();
    const reviewer = await f.role("reviewer", "independent-org", "independent");
    const second = await f.role("reviewer", "second-org", "second-reviewer");
    const reviewerBinding = f.data(await f.request(reviewer, "/v1/platform/operators/me"));
    const secondBinding = f.data(await f.request(second, "/v1/platform/operators/me"));
    for (const id of ["B-REVIEW", "B-PRIVATE-SIBLING"]) {
      const delivery = await f.upload(f.supplier, id, "deliverBatch");
      f.data(await f.mutate(f.supplier, "/v1/platform/deliveries", { id, contractId: "C-F", quantity: 3, statement: "Delivery record " + id, evidenceIds: [delivery.id] }), 201);
      const acceptance = await f.upload(f.acceptance, id, "acceptBatch");
      f.data(await f.mutate(f.acceptance, `/v1/platform/batches/${id}/acceptance`, { outcome: "DISPUTED", acceptedQuantity: 0, statement: "Disputed original " + id, evidenceIds: [acceptance.id] }), 201);
    }
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const errors = [];
    async function pageFor(person, hash = "batch/B-REVIEW") {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addCookies(person.cookie.split("; ").map(cookie => {
        const index = cookie.indexOf("="); return { name: cookie.slice(0, index), value: cookie.slice(index + 1), url: f.base, httpOnly: true, sameSite: "Strict" };
      }));
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      await page.goto(f.base + "/operations/" + (person.admin ? "?mode=admin" : "") + "#" + hash);
      await page.locator("#workspace").waitFor({ state: "visible" }); return page;
    }
    const admin = await pageFor(f.admin);
    await admin.locator("#reviewAssignmentForm").waitFor({ state: "visible" });
    assert.equal(await admin.locator("#reviewForm").isVisible(), false);
    await admin.locator('#reviewAssignmentForm [name="assignmentId"]').selectOption(reviewerBinding.id);
    await admin.locator('#reviewAssignmentForm [name="reason"]').fill("Request independent site review");
    let lost = false; const assignmentRequests = [];
    await admin.route("**/v1/platform/batches/B-REVIEW/reviewer-assignment", async route => {
      assignmentRequests.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
      const response = await route.fetch();
      if (!lost) { lost = true; await route.abort("failed"); } else await route.fulfill({ response });
    });
    await admin.locator('#reviewAssignmentForm button[type="submit"]').click();
    await admin.waitForFunction(() => {
      const form = document.querySelector("#reviewAssignmentForm");
      return !form.querySelector("button").disabled && form.querySelector(".form-result").dataset.success === "false" && form.querySelector(".form-result").textContent !== "正在提交";
    });
    await admin.locator("#refresh").click();
    await admin.locator('[data-testid="review-assignment"]').waitFor();
    await admin.locator('#reviewAssignmentForm button[type="submit"]').click();
    await admin.waitForFunction(() => document.querySelector("#reviewAssignmentForm .form-result").dataset.success === "true");
    assert.equal(assignmentRequests.length, 2); assert.equal(assignmentRequests[0].key, assignmentRequests[1].key);
    assert.equal(assignmentRequests[0].body.id, assignmentRequests[1].body.id);
    assert.equal((await f.read()).batches.find(item => item.id === "B-REVIEW").reviewAssignments.length, 1);
    const page = await pageFor(reviewer);
    await page.locator("#reviewForm").waitFor({ state: "visible" });
    assert.equal(await page.locator("#reviewAssignmentForm").isVisible(), false);
    assert.ok(!(await page.locator("#workspace").textContent()).includes("B-PRIVATE-SIBLING"));
    assert.equal(await page.locator('[data-testid="batch-attestation"]').count(), 2);
    await page.locator('#reviewForm [name="acceptedQuantity"]').fill("1");
    await page.locator('#reviewForm [name="statement"]').fill("Stale draft from previous assignment");
    await page.locator("#reviewFiles").setInputFiles({ name: "stale.png", mimeType: "image/png", buffer: evidencePng });
    f.data(await f.mutate(f.admin, "/v1/platform/batches/B-REVIEW/reviewer-assignment", { id: randomUUID(), assignmentId: secondBinding.id, reason: "Independent case reassignment" }), 201);
    await page.locator("#refresh").click(); await page.locator("#gate").waitFor({ state: "visible" });
    assert.equal(await page.locator("#batchDetail").textContent(), "");
    assert.equal(await page.locator("#batchAttestations").textContent(), "");
    assert.equal(await page.locator("#reviewFiles").evaluate(input => input.files.length), 0);
    assert.equal(await page.locator('#reviewForm [name="statement"]').inputValue(), "");
    const current = await pageFor(second);
    await current.locator("#reviewForm").waitFor({ state: "visible" });
    assert.ok(!(await current.locator("#workspace").textContent()).includes("B-PRIVATE-SIBLING"));
    await current.locator('#reviewForm [name="acceptedQuantity"]').fill("1");
    await current.locator('#reviewForm [name="statement"]').fill("One case independently verified; two rejected.");
    await current.locator("#reviewFiles").setInputFiles({ name: "review-findings.png", mimeType: "image/png", buffer: evidencePng });
    await current.locator('#reviewForm button[type="submit"]').click();
    await current.waitForFunction(() => document.querySelector("#reviewForm .form-result").dataset.success === "true");
    await current.waitForFunction(() => document.querySelectorAll('[data-testid="batch-attestation"]').length === 3);
    assert.equal(await current.locator("#reviewForm").isVisible(), false);
    assert.ok((await current.locator('[data-testid="batch-acceptance"]').innerText()).includes("争议"));
    assert.ok((await current.locator('[data-testid="batch-review"]').innerText()).includes("部分通过"));
    const downloadEvent = current.waitForEvent("download");
    await current.locator('[data-testid="evidence-download"]').last().click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "review-findings.png");
    assert.deepEqual(fs.readFileSync(await download.path()), evidencePng);
    await current.reload(); await current.locator('[data-testid="batch-review"]').waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await current.setViewportSize({ width, height: 950 });
      assert.ok(await current.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "review overflows " + width);
    }
    await current.screenshot({ path: path.join(output, "review-desktop.png"), fullPage: true });
    await current.setViewportSize({ width: 390, height: 844 });
    await current.locator("#reviewAssignmentHistory").scrollIntoViewIfNeeded();
    await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await current.screenshot({ path: path.join(output, "review-mobile.png") });
    const finance = await pageFor(f.finance);
    await finance.locator("#payableForm").waitFor({ state: "visible" });
    assert.match(await finance.locator("#payableAmount").innerText(), /12\.000000000000000001/);
    await finance.locator('#payableForm button[type="submit"]').click();
    await finance.waitForFunction(() => document.querySelector("#payableForm .form-result").dataset.success === "true");
    assert.equal((await f.read()).payments.length, 0);
    f.data(await f.request(f.admin, `/v1/platform/operators/${second.user.id}/revoke`, {}));
    await current.locator("#refresh").click(); await current.locator("#gate").waitFor({ state: "visible" });
    assert.equal(await current.locator("#reviewAssignmentHistory").textContent(), "");
    assert.deepEqual(errors, []);
    process.stdout.write("PASS review browser: real HTTP assignment retry, case privacy, reassignment draft clearance, review originals, partial exact payable, no payment, revocation, four viewport widths. Lock facts are an isolated trusted fixture, not public-chain proof.\n");
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
