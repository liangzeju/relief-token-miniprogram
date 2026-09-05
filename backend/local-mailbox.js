"use strict";

const crypto = require("node:crypto");

const TTL = 10 * 60 * 1000;
const WINDOW = 15 * 60 * 1000;
const COOLDOWN = 60 * 1000;
const CAPACITY = 1000;
const BUCKET_CAPACITY = 10000;

function mailMode(site, env = process.env) {
  if (env.NODE_ENV === "production") return "disabled";
  if (env.RELIEF_MAIL_MODE !== undefined) return env.RELIEF_MAIL_MODE === "local-test" ? "local-test" : "disabled";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  return local && [undefined, "development", "test"].includes(env.NODE_ENV) ? "local-test" : "disabled";
}

function createLocalMailbox() {
  const secret = crypto.randomBytes(32);
  const challenges = new Map();
  const messages = new Map();
  const buckets = new Map();
  const cooldowns = new Map();
  const keyFor = (purpose, email, userId) => JSON.stringify([purpose, email, userId]);
  const hash = (key, code) => crypto.createHmac("sha256", secret).update(JSON.stringify([key, code])).digest();

  function remove(key) {
    const challenge = challenges.get(key);
    if (challenge) messages.delete(challenge.id);
    challenges.delete(key);
  }

  function prune() {
    const now = Date.now();
    for (const [key, item] of challenges) if (item.expiresAt <= now) remove(key);
    for (const map of [buckets, cooldowns]) {
      for (const [key, item] of map) if (item.expiresAt <= now) map.delete(key);
    }
  }

  function take(key, maximum) {
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= BUCKET_CAPACITY) return false;
      bucket = { count: 0, expiresAt: Date.now() + WINDOW };
      buckets.set(key, bucket);
    }
    if (bucket.count >= maximum) return false;
    bucket.count++;
    return true;
  }

  function allow(action, purpose, email, userId, ip) {
    prune();
    // Never trust forwarded headers. Unknown emails consume the same email/IP budgets.
    const sending = action === "send";
    if (!take(JSON.stringify([action, "ip", ip]), sending ? 30 : 60)) return false;
    if (!take(JSON.stringify([action, purpose, "email", email]), sending ? 5 : 30)) return false;
    return !userId || take(JSON.stringify([action, purpose, "user", userId]), sending ? 5 : 30);
  }

  return {
    issue(purpose, email, userId, ip) {
      if (!allow("send", purpose, email, userId, ip)) return;
      const cooldownKey = JSON.stringify([purpose, email]);
      if (cooldowns.has(cooldownKey) || cooldowns.size >= BUCKET_CAPACITY) return;
      cooldowns.set(cooldownKey, { expiresAt: Date.now() + COOLDOWN });
      if (!userId) return;
      const key = keyFor(purpose, email, userId);
      const previous = messages.get(challenges.get(key)?.id)?.code;
      let code;
      do { code = crypto.randomInt(0, 1000000).toString().padStart(6, "0"); } while (code === previous);
      remove(key);
      if (challenges.size >= CAPACITY) remove(challenges.keys().next().value);
      const createdAt = Date.now();
      const expiresAt = createdAt + TTL;
      const id = crypto.randomUUID();
      challenges.set(key, { id, userId, hash: hash(key, code), attempts: 0, expiresAt });
      messages.set(id, { id, to: email, purpose, code, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() });
    },
    check(purpose, email, userId, code, ip) {
      if (!allow("check", purpose, email, userId, ip)) return { limited: true };
      const key = keyFor(purpose, email, userId);
      const challenge = challenges.get(key);
      if (!challenge) return {};
      challenge.attempts++;
      const valid = typeof code === "string" && /^[0-9]{6}$/.test(code) && crypto.timingSafeEqual(hash(key, code), challenge.hash);
      if (!valid) {
        if (challenge.attempts >= 5) remove(key);
        return {};
      }
      // Consume before async hashing/persistence. Failed storage requires a fresh code.
      remove(key);
      return { valid: true, expiresAt: challenge.expiresAt };
    },
    revoke(userId) {
      for (const [key, item] of challenges) if (item.userId === userId) remove(key);
    },
    list() {
      prune();
      return [...messages.values()].reverse().map(message => ({ ...message }));
    }
  };
}

module.exports = { createLocalMailbox, mailMode };
