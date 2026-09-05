"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const { createAdminSessions } = require("../admin-sessions");
const adminContext = { "X-Relief-Actor": "admin" };
const cookieValue = res => res.headers.get("set-cookie").split(";")[0];

test("admin session expiry, rotation, strict cookies and request boundaries", async t => {
  let clock = 1000;
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = createAdminSessions({ origin: "https://relief.test", clock: () => clock,
    verifyToken: req => req.headers["x-admin-token"] === token,
    send(res, status, payload) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); },
    readBody: async req => { let data = ""; for await (const chunk of req) data += chunk; return JSON.parse(data); }
  });
  const server = http.createServer((req, res) => void sessions.handle(req, res, req.url));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (headers = {}, body = { token }) => fetch(base + "/v1/admin/session", { method: "POST", headers: { ...adminContext, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let response = await login(); assert.equal(response.status, 200);
  const first = cookieValue(response);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.match(response.headers.get("set-cookie"), /Path=\/v1\//);
  assert.equal(response.headers.get("cache-control"), "no-store");
  response = await login({ Cookie: first }); const second = cookieValue(response);
  assert.notEqual(first, second);
  const state = async (cookie, context = adminContext) => (await (await fetch(base + "/v1/admin/session", { headers: { ...context, Cookie: cookie } })).json());
  assert.equal((await state(first)).data.authenticated, false);
  assert.equal((await state(second)).data.authenticated, true);
  assert.equal((await state(second, {})).error.code, "ADMIN_AUTH_REQUIRED");
  assert.equal((await state(`${second}; ${second}`)).data.authenticated, false);
  assert.equal((await login({ Origin: "https://evil.test" })).status, 403);
  assert.equal((await login({ "Content-Type": "text/plain" })).status, 415);
  clock += 8 * 60 * 60 * 1000;
  assert.equal((await state(second)).data.authenticated, false);
  for (let i = 0; i < 20; i++) assert.equal((await login({}, { token: "wrong" })).status, 401);
  assert.equal((await login()).status, 429);
});

test("real backend keeps admin and donor identities separate in one cookie jar", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relief-auth-linkage-"));
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ tasks: [{ id: "TASK-NULL", title: "Private unowned task", visibility: "PRIVATE", organizationId: null, reporterUserId: null }], donations: [], contracts: [], deliveries: [], redemptions: [], traces: [], chainTransactions: [], auditEvents: [], responses: [], awards: [], idempotency: {} }));
  const token = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, PORT: "0", DATA_DIR: dataDir, PUBLIC_BASE_URL: "http://localhost",
    RELIEF_ADMIN_TOKEN: token, RELIEF_ENABLE_LEGACY_DEMO: "false", NODE_ENV: "test",
    MONAD_RPC_URL: "http://127.0.0.1:1", MONAD_WALLET_RPC_URL: "http://127.0.0.1:1" };
  for (const name of ["MONAD_POOL_ADDRESS", "MONAD_START_BLOCK", "NODE_OPTIONS"]) delete env[name];
  const child = spawn(process.execPath, [path.join(__dirname, "../server.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("relief-auth-linkage-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timeout")), 15000);
    let output = "", stderr = "";
    child.stderr.on("data", part => { stderr += part; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on("data", part => { output += part; const match = output.match(/listening on http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  const request = (url, headers = {}, body) => fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request("/v1/overview", { Authorization: "Bearer demo-platform-admin" })).status, 401);
  const registration = await request("/v1/wallet/register", {}, { name: "Private Donor", email: "linkage@example.com", password: "Password-12345" });
  assert.equal(registration.status, 201);
  const donorCookie = cookieValue(registration), donorId = (await registration.json()).data.user.id;
  assert.equal((await request("/v1/tasks/TASK-NULL", { Cookie: donorCookie })).status, 403, "Two null organizations never confer scope");
  assert.equal((await request("/v1/admin/session", { Cookie: donorCookie }, { token })).status, 401);
  const login = await request("/v1/admin/session", { ...adminContext, Cookie: donorCookie }, { token });
  assert.equal(login.status, 200);
  const adminCookie = cookieValue(login), both = `${donorCookie}; ${adminCookie}`;
  assert.notEqual(donorCookie.split("=")[0], adminCookie.split("=")[0]);
  assert.equal((await (await request("/v1/wallet/me", { Cookie: both })).json()).data.user.id, donorId);
  assert.equal((await request("/v1/overview", { Cookie: both })).status, 403, "Ambient admin cookie never elevates mobile");
  const overview = await request("/v1/overview", { ...adminContext, Cookie: both });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).data.capabilities.businessWritesEnabled, false);
  assert.equal((await request("/v1/wallet/admin/overview", { ...adminContext, Cookie: both })).status, 200);
  const walletConfig = (await (await request("/v1/wallet/config")).json()).data;
  assert.equal(walletConfig.newOperationsEnabled, false);
  const blockedDeploy = await request("/v1/wallet/admin/deploy-prepare", { ...adminContext, Cookie: both }, { owner: "0x" + "11".repeat(20) });
  assert.equal(blockedDeploy.status, 503);
  assert.equal((await blockedDeploy.json()).error.code, "WORKFLOW_NOT_READY");
  assert.equal((await request("/v1/wallet/admin/overview", { Cookie: both })).status, 403);
  assert.equal((await request("/v1/market-orders", { Cookie: both }, { itemId: "MAT-WATER", taskId: "TASK-001", quantity: 1 })).status, 503);
  assert.equal((await request("/v1/demo/reset", { ...adminContext, Cookie: both }, {})).status, 503);
  assert.equal((await request("/v1/admin/logout", { ...adminContext, Cookie: both }, {})).status, 200);
  assert.equal((await request("/v1/overview", { ...adminContext, Cookie: both })).status, 401);
  assert.equal((await (await request("/v1/wallet/me", { Cookie: both })).json()).data.user.id, donorId);
  const again = await request("/v1/admin/session", adminContext, { token });
  const fresh = `${donorCookie}; ${cookieValue(again)}`;
  assert.equal((await request("/v1/wallet/logout", { Cookie: fresh }, {})).status, 200);
  assert.equal((await request("/v1/overview", { ...adminContext, Cookie: fresh })).status, 200, "Donor logout leaves admin intact");
  assert.equal((await (await request("/v1/wallet/me", { Cookie: fresh })).json()).data.user, null);
});
