"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { getAddress, verifyMessage } = require("ethers");
const { createLocalMailbox, mailMode } = require("./local-mailbox");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL = 8 * 60 * 60 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const CAPACITY = 10000;
const COOKIE = "relief_session";
const ROUTES = new Set(["register", "login", "logout", "challenge", "verify", "email/request", "email/verify", "password/request", "password/reset"].map(name => `/v1/wallet/${name}`));
const GET_ROUTES = new Set(["/v1/wallet/auth-config", "/v1/wallet/admin/test-mailbox"]);

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function plainText(value, field, maximum, optional = false) {
  if (optional && value === undefined) return "";
  if (typeof value !== "string") throw fail(400, "INVALID_INPUT", `${field} must be text.`);
  const trimmed = value.trim();
  if ((!optional && !trimmed) || trimmed.length > maximum || /[<>\x00-\x1f\x7f]/.test(trimmed)) {
    throw fail(400, "INVALID_INPUT", `${field} is invalid or too long.`);
  }
  return trimmed;
}

function emailAddress(value) {
  const email = plainText(value, "email", 254).toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0].length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0]) ||
      parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..") ||
      !parts[1].includes(".") || parts[1].split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw fail(400, "INVALID_INPUT", "email is invalid.");
  }
  return email;
}

function passwordText(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) {
    throw fail(400, "INVALID_INPUT", "password must contain 10 to 128 characters.");
  }
  return value;
}

function walletAddress(value) {
  try {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error();
    return getAddress(value);
  } catch (_) {
    throw fail(400, "INVALID_ADDRESS", "A valid Ethereum address is required.");
  }
}

function profile(record, emailMode) {
  if (!record) return null;
  return {
    id: record.id, name: record.name, email: record.email, organization: record.organization,
    wallet: record.wallet, registeredAt: record.registeredAt, emailVerified: false,
    emailTestVerified: record.emailTestVerified === true,
    emailTestVerifiedAt: record.emailTestVerifiedAt ?? null, emailVerificationMode: emailMode
  };
}

function createAccounts({ dataDir, origin, chainId, send, readBody, isAdminSession = () => false }) {
  if (typeof send !== "function" || typeof readBody !== "function") throw new TypeError("send and readBody are required.");
  if (typeof isAdminSession !== "function") throw new TypeError("isAdminSession must be a function.");
  const site = new URL(origin);
  if (!["http:", "https:"].includes(site.protocol) || site.origin !== origin) throw new TypeError("origin must be an HTTP(S) origin.");
  const emailMode = mailMode(site);
  const mailbox = emailMode === "local-test" ? createLocalMailbox() : null;
  const publicProfile = record => profile(record, emailMode);
  if (!/^[1-9][0-9]*$/.test(String(chainId)) || (typeof chainId === "number" && !Number.isSafeInteger(chainId))) {
    throw new TypeError("chainId must be a positive integer.");
  }
  const directory = path.resolve(dataDir);
  const accountsPath = path.join(directory, "accounts.json");
  const adminTokenPath = path.join(directory, "admin-access-token.txt");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  let adminToken = process.env.RELIEF_ADMIN_TOKEN;
  if (typeof adminToken !== "string" || adminToken.length < 32) {
    try {
      const descriptor = fs.openSync(adminTokenPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${crypto.randomBytes(32).toString("hex")}\n`);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = fs.lstatSync(adminTokenPath);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Admin token must be a regular private file.");
    fs.chmodSync(adminTokenPath, 0o600);
    adminToken = fs.readFileSync(adminTokenPath, "utf8").trim();
    if (adminToken.length < 32 || /\s/.test(adminToken)) throw new Error("Admin token file is invalid.");
  }
  const adminDigest = digest(adminToken);
  adminToken = undefined;

  let users = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    if (stored.version !== 1 || !Array.isArray(stored.users)) throw new Error("Invalid account store.");
    const emails = new Set();
    const wallets = new Set();
    for (const record of stored.users) {
      if (!record || typeof record.id !== "string" || !/^[0-9a-f-]{36}$/.test(record.id) || users.has(record.id) ||
          record.name !== plainText(record.name, "name", 120) || record.email !== emailAddress(record.email) ||
          record.organization !== plainText(record.organization, "organization", 160, true) ||
          record.emailVerified !== false || typeof record.registeredAt !== "string" || !Number.isFinite(Date.parse(record.registeredAt)) ||
          (record.emailTestVerified !== undefined && typeof record.emailTestVerified !== "boolean") ||
          (record.emailTestVerifiedAt !== undefined && record.emailTestVerifiedAt !== null &&
            (typeof record.emailTestVerifiedAt !== "string" || !Number.isFinite(Date.parse(record.emailTestVerifiedAt)) ||
              new Date(record.emailTestVerifiedAt).toISOString() !== record.emailTestVerifiedAt)) ||
          ((record.emailTestVerified === true) !== (typeof record.emailTestVerifiedAt === "string")) ||
          (record.emailVerificationMode !== undefined && !["local-test", "disabled"].includes(record.emailVerificationMode)) ||
          typeof record.passwordSalt !== "string" || !/^[0-9a-f]{32}$/.test(record.passwordSalt) ||
          typeof record.passwordHash !== "string" || !/^[0-9a-f]{128}$/.test(record.passwordHash) ||
          (record.wallet !== null && record.wallet !== walletAddress(record.wallet)) ||
          emails.has(record.email) || (record.wallet && wallets.has(record.wallet))) {
        throw new Error("Invalid account store.");
      }
      emails.add(record.email);
      if (record.wallet) wallets.add(record.wallet);
      users.set(record.id, { ...publicProfile(record), passwordSalt: record.passwordSalt, passwordHash: record.passwordHash });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot load accounts.json.", { cause: error });
  }

  const sessions = new Map();
  const challenges = new Map();
  const rateLimits = new Map();
  const dummySalt = crypto.randomBytes(16).toString("hex");
  const dummyHash = crypto.randomBytes(64);
  let hashing = 0;
  let mutationTail = Promise.resolve();

  function serial(action) {
    const operation = mutationTail.then(action);
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function persist(nextUsers) {
    const temporary = `${accountsPath}.${crypto.randomBytes(16).toString("hex")}.tmp`;
    let file;
    try {
      file = await fs.promises.open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify({ version: 1, users: [...nextUsers.values()] }, null, 2));
      await file.sync();
      await file.close();
      file = null;
      await fs.promises.rename(temporary, accountsPath);
    } catch (_) {
      throw fail(500, "STORAGE_ERROR", "Account changes could not be saved.");
    } finally {
      if (file) await file.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
    }
    users = nextUsers;
  }

  function prune(map) {
    const now = Date.now();
    for (const [key, item] of map) if (item.expiresAt <= now) map.delete(key);
  }

  function limit(req, route) {
    prune(rateLimits);
    const key = `${route}:${req.socket.remoteAddress || "unknown"}`;
    let bucket = rateLimits.get(key);
    if (!bucket) {
      if (rateLimits.size >= CAPACITY) throw fail(429, "RATE_LIMITED", "Too many requests. Try again later.");
      bucket = { count: 0, expiresAt: Date.now() + 15 * 60 * 1000 };
      rateLimits.set(key, bucket);
    }
    const maximum = route === "register" ? 10 : route === "login" ? 20 : 30;
    if (++bucket.count > maximum) throw fail(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }

  async function passwordHash(password, salt) {
    if (hashing >= 4) throw fail(503, "AUTH_BUSY", "Authentication is busy. Try again later.");
    hashing++;
    try {
      return await scrypt(password, Buffer.from(salt, "hex"), 64, SCRYPT);
    } finally {
      hashing--;
    }
  }

  function cookieHash(req) {
    const raw = req.headers.cookie;
    if (typeof raw !== "string") return null;
    const values = raw.split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(COOKIE.length + 1);
    return /^[0-9a-f]{64}$/.test(token) ? digest(token).toString("hex") : null;
  }

  function user(req) {
    const key = cookieHash(req);
    const session = key && sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return publicProfile(users.get(session.userId));
  }

  function requireUser(req) {
    const current = user(req);
    if (!current) throw fail(401, "AUTH_REQUIRED", "Sign in to continue.");
    return current;
  }

  function cookie(res, token, maxAge) {
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${site.protocol === "https:" ? "; Secure" : ""}`);
  }

  function sessionCapacity(req) {
    prune(sessions);
    if (sessions.size >= CAPACITY && !sessions.has(cookieHash(req))) throw fail(503, "AUTH_BUSY", "Authentication is busy. Try again later.");
  }

  function startSession(req, res, id) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.delete(cookieHash(req));
    sessions.set(digest(token).toString("hex"), { userId: id, expiresAt: Date.now() + SESSION_TTL });
    cookie(res, token, SESSION_TTL / 1000);
  }

  function assertOrigin(req) {
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      throw fail(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed.");
    }
  }

  function isAdminToken(req) {
    const token = req.headers["x-admin-token"];
    return typeof token === "string" && token.length >= 32 && crypto.timingSafeEqual(digest(token), adminDigest);
  }

  function isAdmin(req) {
    return isAdminToken(req) || isAdminSession(req) === true;
  }

  function checkEmailCode(req, purpose, record, email, code) {
    const result = mailbox.check(purpose, email, record?.id, code, req.socket?.remoteAddress || "unknown");
    if (result.limited) throw fail(429, "RATE_LIMITED", "Too many requests. Try again later.");
    if (!result.valid) throw fail(400, "INVALID_CODE", "Code is invalid or expired.");
    return result;
  }

  async function handle(req, res, p) {
    if (!(req.method === "POST" && ROUTES.has(p)) && !(req.method === "GET" && GET_ROUTES.has(p))) return false;
    if (res.headersSent || res.writableEnded) return true;
    try {
      res.setHeader("Cache-Control", "no-store");
      assertOrigin(req);
      if (req.method === "GET") {
        if (p === "/v1/wallet/auth-config") {
          send(res, 200, { data: { emailMode } });
        } else {
          if (!isAdmin(req)) throw fail(403, "ADMIN_REQUIRED", "Admin access is required.");
          if (!mailbox) throw fail(403, "EMAIL_DISABLED", "Local test email is disabled.");
          send(res, 200, { data: { mode: "local-test", messages: mailbox.list() } });
        }
        return true;
      }
      const contentType = req.headers["content-type"];
      if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
        throw fail(415, "JSON_REQUIRED", "Content-Type must be application/json.");
      }
      const route = p.slice("/v1/wallet/".length);
      if (["register", "login", "challenge"].includes(route)) limit(req, route);
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        throw fail(error.status === 413 ? 413 : 400, "INVALID_JSON", "Request body must be valid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "INVALID_INPUT", "A JSON object is required.");

      if (["email/request", "email/verify", "password/request", "password/reset"].includes(route)) {
        await serial(async () => {
          const current = route.startsWith("email/") ? requireUser(req) : null;
          const email = current ? current.email : emailAddress(body.email);
          const record = current ? users.get(current.id) : [...users.values()].find(item => item.email === email);
          const purpose = current ? "email-verification" : "password-reset";
          if (route.endsWith("/request")) {
            if (mailbox) mailbox.issue(purpose, email, record?.id, req.socket?.remoteAddress || "unknown");
            send(res, 202, { data: { accepted: true } });
            return;
          }
          if (!mailbox) throw fail(403, "EMAIL_DISABLED", "Local test email is disabled.");
          const password = route === "password/reset" ? passwordText(body.password) : null;
          const proof = checkEmailCode(req, purpose, record, email, body.code);
          let updated;
          if (route === "email/verify") {
            updated = { ...record, emailTestVerified: true, emailTestVerifiedAt: new Date(Date.now()).toISOString(), emailVerificationMode: emailMode };
          } else {
            const passwordSalt = crypto.randomBytes(16).toString("hex");
            const hash = (await passwordHash(password, passwordSalt)).toString("hex");
            if (proof.expiresAt <= Date.now()) throw fail(400, "INVALID_CODE", "Code is invalid or expired.");
            updated = { ...record, passwordSalt, passwordHash: hash };
          }
          const next = new Map(users);
          next.set(updated.id, updated);
          await persist(next);
          if (route === "password/reset") {
            // Revoke only after the replacement credentials have been persisted.
            for (const [key, session] of sessions) if (session.userId === updated.id) sessions.delete(key);
            for (const [key, challenge] of challenges) if (challenge.userId === updated.id) challenges.delete(key);
            mailbox.revoke(updated.id);
            cookie(res, "", 0);
            send(res, 200, { data: { reset: true } });
          } else {
            send(res, 200, { data: { user: publicProfile(updated) } });
          }
        });
      } else if (route === "register") {
        const name = plainText(body.name, "name", 120);
        const email = emailAddress(body.email);
        const organization = plainText(body.organization, "organization", 160, true);
        const password = passwordText(body.password);
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = (await passwordHash(password, salt)).toString("hex");
        await serial(async () => {
          if ([...users.values()].some(record => record.email === email)) throw fail(409, "EMAIL_IN_USE", "An account already uses this email.");
          sessionCapacity(req);
          const record = {
            id: crypto.randomUUID(), name, email, organization, wallet: null,
            registeredAt: new Date().toISOString(), emailVerified: false,
            emailTestVerified: false, emailTestVerifiedAt: null, emailVerificationMode: emailMode,
            passwordSalt: salt, passwordHash: hash
          };
          const next = new Map(users);
          next.set(record.id, record);
          await persist(next);
          startSession(req, res, record.id);
          send(res, 201, { data: { user: publicProfile(record) } });
        });
      } else if (route === "login") {
        const email = emailAddress(body.email);
        const password = passwordText(body.password);
        const record = [...users.values()].find(item => item.email === email);
        const computed = await passwordHash(password, record ? record.passwordSalt : dummySalt);
        const matches = crypto.timingSafeEqual(computed, record ? Buffer.from(record.passwordHash, "hex") : dummyHash);
        if (!matches || !record) throw fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
        await serial(() => {
          const latest = users.get(record.id);
          if (!latest || latest.passwordHash !== record.passwordHash || latest.passwordSalt !== record.passwordSalt) {
            throw fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
          }
          sessionCapacity(req);
          startSession(req, res, record.id);
          send(res, 200, { data: { user: publicProfile(latest) } });
        });
      } else if (route === "logout") {
        sessions.delete(cookieHash(req));
        cookie(res, "", 0);
        send(res, 200, { data: { loggedOut: true } });
      } else if (route === "challenge") {
        const current = requireUser(req);
        const address = walletAddress(body.address);
        if ([...users.values()].some(record => record.wallet === address && record.id !== current.id)) {
          throw fail(409, "WALLET_IN_USE", "This wallet is already bound to another account.");
        }
        prune(challenges);
        // Keep only the latest outstanding challenge for each account.
        for (const [key, item] of challenges) if (item.userId === current.id) challenges.delete(key);
        if (challenges.size >= CAPACITY) throw fail(429, "RATE_LIMITED", "Too many requests. Try again later.");
        const nonce = crypto.randomBytes(32).toString("hex");
        const expiresAt = Date.now() + CHALLENGE_TTL;
        const message = [
          "Relief Wallet account binding", `Origin: ${origin}`, `Account ID: ${current.id}`,
          `Address: ${address}`, `Chain ID: ${chainId}`, `Nonce: ${nonce}`,
          `Expires At: ${new Date(expiresAt).toISOString()}`
        ].join("\n");
        challenges.set(nonce, { userId: current.id, address, message, expiresAt });
        send(res, 200, { data: { nonce, message } });
      } else if (route === "verify") {
        const current = requireUser(req);
        if (typeof body.nonce !== "string" || !/^[0-9a-f]{64}$/.test(body.nonce)) throw fail(400, "INVALID_CHALLENGE", "Challenge is invalid or expired.");
        const challenge = challenges.get(body.nonce);
        if (!challenge || challenge.expiresAt <= Date.now()) {
          challenges.delete(body.nonce);
          throw fail(400, "INVALID_CHALLENGE", "Challenge is invalid or expired.");
        }
        if (challenge.userId !== current.id) throw fail(403, "CHALLENGE_OWNER_MISMATCH", "Challenge belongs to a different account.");
        // Consume before signature verification or asynchronous storage to prevent concurrent replay.
        challenges.delete(body.nonce);
        let recovered;
        try {
          if (typeof body.signature !== "string" || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(body.signature)) throw new Error();
          recovered = verifyMessage(challenge.message, body.signature);
        } catch (_) {
          throw fail(400, "INVALID_SIGNATURE", "Wallet signature is invalid.");
        }
        if (recovered !== challenge.address) throw fail(400, "INVALID_SIGNATURE", "Wallet signature does not match the requested address.");
        await serial(async () => {
          if (requireUser(req).id !== challenge.userId) throw fail(403, "CHALLENGE_OWNER_MISMATCH", "Challenge belongs to a different account.");
          if (challenge.expiresAt <= Date.now()) throw fail(400, "INVALID_CHALLENGE", "Challenge is invalid or expired.");
          if ([...users.values()].some(record => record.wallet === challenge.address && record.id !== current.id)) {
            throw fail(409, "WALLET_IN_USE", "This wallet is already bound to another account.");
          }
          const record = { ...users.get(current.id), wallet: challenge.address };
          const next = new Map(users);
          next.set(record.id, record);
          await persist(next);
          send(res, 200, { data: { user: publicProfile(record) } });
        });
      }
    } catch (error) {
      if (!res.headersSent && !res.writableEnded) {
        const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 && typeof error.code === "string";
        try {
          send(res, known ? error.status : 500, {
            data: null, error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "Account request failed." }
          });
        } catch (_) {
          if (!res.writableEnded) res.destroy();
        }
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
    return true;
  }

  return {
    handle, user, requireUser, assertOrigin, adminTokenPath,
    actor(req) {
      const current = user(req);
      return current ? { userId: current.id, organizationId: null, roles: ["donor"] } : null;
    },
    snapshot(id) { return publicProfile(users.get(id)); },
    getByWallet(address) {
      let normalized;
      try { normalized = walletAddress(address); } catch (_) { return null; }
      return publicProfile([...users.values()].find(record => record.wallet === normalized));
    },
    isAdmin, isAdminToken
  };
}

module.exports = { createAccounts };
