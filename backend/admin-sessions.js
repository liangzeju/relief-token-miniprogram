"use strict";

const crypto = require("node:crypto");
const COOKIE = "relief_admin_session";
const TTL = 8 * 60 * 60 * 1000;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function createAdminSessions({ origin, verifyToken, send, readBody, clock = Date.now }) {
  const site = new URL(origin);
  const sessions = new Map();
  const attempts = new Map();
  const empty = () => ({ userId: null, organizationId: null, roles: [] });
  function prune(map) {
    for (const [key, value] of map) if (value.expiresAt <= clock()) map.delete(key);
  }
  function key(req) {
    const values = String(req.headers.cookie || "").split(";").map(v => v.trim()).filter(v => v.startsWith(COOKIE + "="));
    if (values.length !== 1) return null;
    const value = values[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? digest(value) : null;
  }
  function session(req) {
    if (req.headers["x-relief-actor"] !== "admin") return null;
    const id = key(req), value = sessions.get(id);
    if (value && value.expiresAt > clock()) return value;
    if (id) sessions.delete(id);
    return null;
  }
  function cookie(res, token, age) {
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/v1/; HttpOnly; SameSite=Strict; Max-Age=${age}${site.protocol === "https:" ? "; Secure" : ""}`);
  }
  function limit(req) {
    prune(attempts);
    const ip = req.socket.remoteAddress || "unknown";
    let value = attempts.get(ip);
    if (!value) {
      if (attempts.size >= 1000) return false;
      value = { count: 0, expiresAt: clock() + 15 * 60 * 1000 };
      attempts.set(ip, value);
    }
    return ++value.count <= 20;
  }
  async function handle(req, res, p) {
    if (!["/v1/admin/session", "/v1/admin/logout"].includes(p)) return false;
    res.setHeader("Cache-Control", "no-store");
    const error = (status, code, message) => send(res, status, { data: null, error: { code, message } });
    if (req.headers["x-relief-actor"] !== "admin") { error(401, "ADMIN_AUTH_REQUIRED", "请在管理端验证身份"); return true; }
    if (p === "/v1/admin/session" && req.method === "GET") {
      send(res, 200, { data: { authenticated: !!session(req) } }); return true;
    }
    if (req.method !== "POST") { error(405, "METHOD_NOT_ALLOWED", "请求方式不支持"); return true; }
    if (req.headers.origin !== undefined && req.headers.origin !== origin) { error(403, "ORIGIN_FORBIDDEN", "请求来源不允许"); return true; }
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(req.headers["content-type"] || "")) { error(415, "JSON_REQUIRED", "请求必须为 JSON"); return true; }
    try {
      if (p === "/v1/admin/session" && !limit(req)) { error(429, "RATE_LIMITED", "验证过于频繁，请稍后重试"); return true; }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) { error(400, "INVALID_INPUT", "请求内容无效"); return true; }
      if (p === "/v1/admin/logout") {
        sessions.delete(key(req)); cookie(res, "", 0);
        send(res, 200, { data: { authenticated: false } }); return true;
      }
      if (typeof body.token !== "string" || body.token.length > 512 || !verifyToken({ headers: { "x-admin-token": body.token } })) {
        error(401, "INVALID_ADMIN_TOKEN", "管理员访问令牌无效"); return true;
      }
      prune(sessions);
      if (sessions.size >= 1000 && !sessions.has(key(req))) { error(503, "AUTH_BUSY", "管理会话已满，请稍后重试"); return true; }
      sessions.delete(key(req));
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(digest(token), { userId: "platform-bootstrap-admin", organizationId: "org-platform", roles: ["platform_admin"], expiresAt: clock() + TTL });
      cookie(res, token, TTL / 1000);
      send(res, 200, { data: { authenticated: true } });
    } catch (_) { if (!res.headersSent) error(400, "INVALID_JSON", "无法读取请求内容"); }
    return true;
  }
  return {
    handle,
    authorized: req => !!session(req),
    actor(req) { const value = session(req); return value ? { userId: value.userId, organizationId: value.organizationId, roles: [...value.roles] } : empty(); }
  };
}

module.exports = { createAdminSessions };
