"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-storage-http-"));
  const children = [];
  t.after(async () => {
    for (const child of children) await stop(child);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("relief-storage-http-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    async start(legacy = false, expectFailure = false) {
      const env = { ...process.env, PORT: "0", DATA_DIR: directory, NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost",
        RELIEF_ENABLE_LEGACY_DEMO: String(legacy), RELIEF_ENABLE_WALLET_PROTOTYPE: "false",
        RELIEF_ADMIN_TOKEN: crypto.randomBytes(32).toString("hex"), MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
      for (const name of ["NODE_OPTIONS", "MONAD_POOL_ADDRESS", "MONAD_START_BLOCK"]) delete env[name];
      const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      return new Promise((resolve, reject) => {
        let stdout = "", stderr = "";
        const timer = setTimeout(() => reject(new Error("Backend startup timed out: " + stderr)), 15000);
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => {
          clearTimeout(timer);
          if (expectFailure && code !== 0 && !stdout.includes("backend listening")) resolve({ child, stderr });
          else reject(new Error("Unexpected backend exit " + code + ": " + stderr));
        });
        child.stdout.on("data", chunk => {
          stdout += chunk;
          const match = stdout.match(/listening on http:\/\/localhost:(\d+)/);
          if (!match) return;
          clearTimeout(timer);
          if (expectFailure) reject(new Error("Corrupt state must not start a serving backend"));
          else resolve({ child, base: "http://127.0.0.1:" + match[1] });
        });
      });
    }
  };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(); await exited;
}
async function post(base, url, data, key = crypto.randomUUID()) {
  const response = await fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer demo-platform-admin", "Idempotency-Key": key }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
}
async function get(base, url, admin = false) {
  const response = await fetch(base + url, { headers: admin ? { Authorization: "Bearer demo-platform-admin" } : {} });
  return { status: response.status, body: await response.json() };
}

test("fresh non-demo backend never seeds financial balances", async t => {
  const f = fixture(t), { base } = await f.start();
  const overview = await get(base, "/v1/public/overview");
  assert.equal(overview.status, 200);
  for (const key of ["depositedMon", "availableMon", "escrowMon", "settledMon"]) assert.equal(overview.body.data.dashboard[key], 0);
  assert.equal(overview.body.data.contracts.length, 0);
  assert.ok(overview.body.data.marketplace.length > 0, "Reference catalogue remains available");
  assert.equal((await get(base, "/v1/health")).body.storage, "ready");
});

for (const [name, source] of [["invalid JSON", "{broken"], ["invalid root", "null"], ["incomplete schema", '{"tasks":[]}']]) {
  test(name + " fails startup without replacing the source", async t => {
    const f = fixture(t), file = path.join(f.directory, "state.json");
    fs.writeFileSync(file, source);
    const result = await f.start(false, true);
    assert.match(result.stderr, /STATE_INVALID|STATE_READ_FAILED/);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  });
}

test("failed commits roll back memory and idempotency, stop writes, and recover after restart", async t => {
  const f = fixture(t);
  let server = await f.start(true);
  assert.equal((await post(server.base, "/v1/demo/reset", {})).status, 200);
  const file = path.join(f.directory, "state.json"), previous = fs.readFileSync(file, "utf8");
  const before = JSON.parse(previous);
  fs.mkdirSync(file + ".tmp");
  const key = crypto.randomUUID();
  const task = { title: "Persistence regression", monTarget: 50, monRaised: 0, participants: 0, participantTarget: 2 };
  const failed = await post(server.base, "/v1/tasks", task, key);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "STATE_WRITE_FAILED");
  assert.equal(fs.readFileSync(file, "utf8"), previous);
  const after = await get(server.base, "/v1/overview", true);
  assert.equal(after.body.data.capabilities.businessWritesEnabled, false);
  assert.equal(after.body.data.capabilities.storage, "write-failed");
  assert.deepEqual(after.body.data.tasks, before.tasks);
  assert.deepEqual((await get(server.base, "/v1/audit-events", true)).body.data, before.auditEvents);
  const health = await get(server.base, "/v1/health");
  assert.equal(health.status, 503); assert.equal(health.body.storage, "write-failed");
  fs.rmdirSync(file + ".tmp");
  assert.equal((await post(server.base, "/v1/tasks", task, key)).status, 503, "No silent unlock after transient I/O failure");
  await stop(server.child);
  server = await f.start(true);
  assert.equal((await get(server.base, "/v1/health")).status, 200);
  const retried = await post(server.base, "/v1/tasks", task, key);
  assert.equal(retried.status, 201, "Failed attempt must not reserve an idempotency result");
  assert.equal((await post(server.base, "/v1/tasks", task, key)).body.data.id, retried.body.data.id);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.tasks.filter(item => item.title === task.title).length, 1);
});
