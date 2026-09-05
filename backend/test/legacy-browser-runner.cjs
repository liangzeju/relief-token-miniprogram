"use strict";
// Preserve the original demo regression in an isolated, explicitly opted-in server.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-legacy-browser-"));
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://localhost:${port}`, token = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, PORT: String(port), PUBLIC_BASE_URL: base, TEST_BASE_URL: base, DATA_DIR: dataDir,
    RELIEF_ADMIN_TOKEN: token, TEST_ADMIN_TOKEN: token, RELIEF_ENABLE_LEGACY_DEMO: "true", NODE_ENV: "test",
    MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const name of ["MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "NODE_OPTIONS"]) delete env[name];
  const child = spawn(process.execPath, [path.join(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let runner;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Legacy test server startup timed out")), 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Legacy test server exited ${code}`)); });
      child.stdout.on("data", data => { if (String(data).includes("backend listening")) { clearTimeout(timer); resolve(); } });
    });
    for (const file of ["browser.cjs", "workflow.cjs"]) {
      runner = spawn(process.execPath, [path.join(__dirname, file)], { env, windowsHide: true, stdio: "inherit" });
      const [code] = await once(runner, "exit");
      if (code !== 0) throw new Error(`${file} failed with code ${code}`);
    }
  } finally {
    if (runner && runner.exitCode === null && runner.signalCode === null) { const stopped = once(runner, "exit"); runner.kill(); await stopped; }
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("relief-legacy-browser-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
