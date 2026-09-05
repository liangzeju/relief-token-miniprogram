"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { getAddress } = require("ethers");

const TTL = 24 * 60 * 60 * 1000;
const ROLES = new Set([
  "supplier", "dispatcher", "contract_approver", "acceptance", "finance",
  "reviewer", "official_verifier", "reporter", "auditor"
]);
// These SQL literals are fixed module constants, never caller input.
const ROLE_SQL = [...ROLES].map(role => `'${role}'`).join(", ");
const ASSIGNMENT_COLUMNS = `id, invitation_id AS invitationId, user_id AS userId,
  email, wallet, organization_id AS organizationId, role, status,
  assigned_at AS assignedAt, revoked_at AS revokedAt, revoked_by AS revokedBy`;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function object(value, field) {
  if (!value || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw fail("INVALID_INPUT", `${field} must be an object.`);
  }
  return value;
}

// Bounds apply before trimming: ids/actors 128, organizations 160, emails 254.
function text(value, field, maximum) {
  if (typeof value !== "string" || value.length > maximum ||
      !value.trim() || /[<>\x00-\x1f\x7f]/.test(value)) {
    throw fail("INVALID_INPUT", `${field} is invalid or too long.`);
  }
  return value.trim();
}

function emailAddress(value) {
  const email = text(value, "email", 254).toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0].length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0]) ||
      parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..") ||
      !parts[1].includes(".") ||
      parts[1].split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw fail("INVALID_INPUT", "email is invalid.");
  }
  return email;
}

function walletAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) ||
      /^0x0{40}$/.test(value)) {
    throw fail("INVALID_WALLET", "An existing nonzero Ethereum wallet is required.");
  }
  try {
    return getAddress(value);
  } catch (cause) {
    throw Object.assign(fail("INVALID_WALLET", "Wallet checksum is invalid."), { cause });
  }
}

function hashCode(code) {
  if (typeof code !== "string" || !/^[0-9a-fA-F]{64}$/.test(code)) {
    throw fail("INVALID_CODE", "Invitation code must encode 32 bytes as hex.");
  }
  return createHash("sha256").update(Buffer.from(code, "hex")).digest("hex");
}

function privateFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(file, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Registry must be a regular private file.");
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    // Permissions are best effort on filesystems without POSIX chmod support.
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
  }
}

// Upstream must supply an authenticated user from accounts (wallet already
// signature-verified), and enforce management authorization for issue/list/revoke.
// This registry does not establish identity, organization authenticity or KYC.
function createOperatorRegistry(options) {
  const { file, clock = Date.now } = object(options, "options");
  if (typeof file !== "string" || !file.trim() || file.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(file) || file === ":memory:") {
    throw fail("INVALID_INPUT", "file must be a persistent SQLite file path.");
  }
  if (typeof clock !== "function") throw fail("INVALID_INPUT", "clock must be a function.");
  const filename = path.resolve(file);
  privateFile(filename);
  const db = new DatabaseSync(filename);
  let closed = false;

  function assertOpen() {
    if (closed) throw fail("REGISTRY_CLOSED", "Operator registry is closed.");
  }

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw fail("INVALID_CLOCK", "clock must return nonnegative safe integer milliseconds.");
    }
    return value;
  }

  function transaction(action) {
    assertOpen();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Registry operation and rollback failed.");
      }
      throw error;
    }
  }

  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS operator_invitations (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash) = 64),
        email TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN (${ROLE_SQL})),
        issued_by TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
        claimed_at INTEGER,
        claimed_by TEXT,
        CHECK((claimed_at IS NULL) = (claimed_by IS NULL))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operator_assignments (
        id TEXT PRIMARY KEY,
        invitation_id TEXT NOT NULL UNIQUE REFERENCES operator_invitations(id),
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        wallet TEXT NOT NULL COLLATE NOCASE,
        organization_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN (${ROLE_SQL})),
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        assigned_at INTEGER NOT NULL,
        revoked_at INTEGER,
        revoked_by TEXT,
        CHECK((status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
          OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS operator_active_user
        ON operator_assignments(user_id) WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS operator_active_wallet
        ON operator_assignments(wallet) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS operator_audit (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('issue', 'claim', 'revoke')),
        actor_id TEXT NOT NULL,
        user_id TEXT,
        invitation_id TEXT NOT NULL REFERENCES operator_invitations(id),
        assignment_id TEXT REFERENCES operator_assignments(id),
        occurred_at INTEGER NOT NULL
      ) STRICT;
    `));
  } catch (error) {
    try { db.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], "Registry initialization and close failed.");
    }
    throw error;
  }

  function audit(action, actorId, userId, invitationId, assignmentId, time) {
    db.prepare(`INSERT INTO operator_audit
      (id, action, actor_id, user_id, invitation_id, assignment_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), action, actorId, userId, invitationId, assignmentId, time
    );
  }

  function assignment(id) {
    const row = db.prepare(`SELECT ${ASSIGNMENT_COLUMNS} FROM operator_assignments WHERE id = ?`).get(id);
    return row ? { ...row } : null;
  }

  function issue(input) {
    assertOpen();
    object(input, "invitation");
    const email = emailAddress(input.email);
    const organizationId = text(input.organizationId, "organizationId", 160);
    const issuedBy = text(input.issuedBy, "issuedBy", 128);
    if (!ROLES.has(input.role)) throw fail("INVALID_ROLE", "A single supported business role is required.");
    const role = input.role;
    return transaction(() => {
      const time = now();
      if (time > Number.MAX_SAFE_INTEGER - TTL) throw fail("INVALID_CLOCK", "Invitation expiry overflows.");
      const id = randomUUID();
      const code = randomBytes(32).toString("hex");
      const expiresAt = time + TTL;
      db.prepare(`INSERT INTO operator_invitations
        (id, code_hash, email, organization_id, role, issued_by, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, hashCode(code), email, organizationId, role, issuedBy, time, expiresAt
      );
      audit("issue", issuedBy, null, id, null, time);
      return { id, code, email, organizationId, role, expiresAt };
    });
  }

  function claim(input) {
    assertOpen();
    object(input, "claim");
    const codeHash = hashCode(input.code);
    const user = object(input.user, "user");
    const userId = text(user.id, "user.id", 128);
    const email = emailAddress(user.email);
    const wallet = walletAddress(user.wallet);
    return transaction(() => {
      // Read the clock after acquiring the write lock, including any busy wait.
      const time = now();
      const invitation = db.prepare(`SELECT id, email, organization_id, role, expires_at, claimed_at
        FROM operator_invitations WHERE code_hash = ?`).get(codeHash);
      if (!invitation || invitation.claimed_at !== null || invitation.expires_at <= time) {
        throw fail("INVITATION_UNAVAILABLE", "Invitation is unknown, expired or already claimed.");
      }
      if (email !== invitation.email) throw fail("EMAIL_MISMATCH", "Invitation email does not match user.");
      if (db.prepare(`SELECT id FROM operator_assignments
        WHERE status = 'active' AND (user_id = ? OR wallet = ?) LIMIT 1`).get(userId, wallet)) {
        throw fail("ASSIGNMENT_CONFLICT", "User or wallet already has an active assignment.");
      }
      db.prepare(`UPDATE operator_invitations SET claimed_at = ?, claimed_by = ?
        WHERE id = ? AND claimed_at IS NULL`).run(time, userId, invitation.id);
      const id = randomUUID();
      db.prepare(`INSERT INTO operator_assignments
        (id, invitation_id, user_id, email, wallet, organization_id, role, status, assigned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(
        id, invitation.id, userId, email, wallet, invitation.organization_id, invitation.role, time
      );
      audit("claim", userId, userId, invitation.id, id, time);
      return assignment(id);
    });
  }

  function lookup(userId) {
    assertOpen();
    const id = text(userId, "userId", 128);
    const row = db.prepare(`SELECT ${ASSIGNMENT_COLUMNS} FROM operator_assignments
      WHERE user_id = ? AND status = 'active'`).get(id);
    return row ? { ...row } : null;
  }

  function list() {
    assertOpen();
    return db.prepare(`SELECT ${ASSIGNMENT_COLUMNS} FROM operator_assignments ORDER BY rowid`).all()
      .map(row => ({ ...row }));
  }

  function revoke(input) {
    assertOpen();
    object(input, "revocation");
    const userId = text(input.userId, "userId", 128);
    const revokedBy = text(input.revokedBy, "revokedBy", 128);
    return transaction(() => {
      const row = db.prepare(`SELECT ${ASSIGNMENT_COLUMNS} FROM operator_assignments
        WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`).get(userId);
      if (!row) return null;
      if (row.status === "revoked") return { ...row };
      const time = now();
      db.prepare(`UPDATE operator_assignments SET status = 'revoked', revoked_at = ?, revoked_by = ?
        WHERE id = ? AND status = 'active'`).run(time, revokedBy, row.id);
      audit("revoke", revokedBy, userId, row.invitationId, row.id, time);
      return assignment(row.id);
    });
  }

  function close() {
    if (!closed) {
      db.close();
      closed = true;
    }
  }

  return { issue, claim, lookup, list, revoke, close };
}

module.exports = { createOperatorRegistry };
