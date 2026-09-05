"use strict";

const crypto = require("node:crypto");
const { id, getAddress } = require("ethers");

function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function input(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "amountWei,projectId,purpose,requestId" ||
      typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId) ||
      !Number.isInteger(value.purpose) || value.purpose < 0 || value.purpose > 5 ||
      typeof value.projectId !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.projectId) ||
      typeof value.amountWei !== "string" || !/^[1-9][0-9]{0,77}$/.test(value.amountWei) || BigInt(value.amountWei) >= (1n << 256n)) {
    fail(400, "INVALID_DONATION_REQUEST");
  }
  return { requestId: value.requestId, purpose: value.purpose, projectId: value.projectId.toLowerCase(), amountWei: value.amountWei };
}
function boundProfile(accounts, req) {
  const profile = accounts.requireUser(req);
  try { if (!profile.wallet || getAddress(profile.wallet) === "0x" + "0".repeat(40)) throw new Error(); }
  catch (_) { fail(403, "WALLET_BINDING_REQUIRED"); }
  return structuredClone(profile);
}

// Private preparation adapter only. A record is not a signing authorization or
// proof of payment. No policy callback means no preparation; no default fee.
function createDonationIntentService({ accounts, store, resolveTerms = null }) {
  if (typeof accounts?.requireUser !== "function" || typeof accounts?.assertOrigin !== "function" ||
      typeof store?.prepare !== "function" || typeof store?.get !== "function" || typeof store?.listForUser !== "function" ||
      resolveTerms !== null && typeof resolveTerms !== "function") throw new TypeError("Invalid donation preparation dependencies.");

  function readExisting(donationId, current, request) {
    const existing = store.get(donationId);
    if (!existing) return null;
    if (existing.userId !== current.id || existing.wallet.toLowerCase() !== current.wallet.toLowerCase()) fail(409, "DONATION_WALLET_CHANGED");
    const permit = existing.permit;
    if (permit.purpose !== request.purpose || permit.projectId !== request.projectId || permit.amountWei !== request.amountWei) {
      fail(409, "DONATION_REQUEST_CONFLICT");
    }
    return existing;
  }

  async function prepare(req, body) {
    accounts.assertOrigin(req);
    const request = input(body), current = boundProfile(accounts, req);
    if (!resolveTerms) fail(503, "FUNDING_POLICY_NOT_CONFIGURED");
    const donationId = id(`ReliefDonationIntent:v1:${current.id}:${request.requestId}`);
    const previous = readExisting(donationId, current, request);
    if (previous) return previous;
    // Fee decisions come from trusted server policy, never from the request or
    // user-controlled identity fields. Recheck login and wallet after the await.
    const policy = await resolveTerms(structuredClone({ user: current, request }));
    const latest = boundProfile(accounts, req);
    if (JSON.stringify(latest) !== JSON.stringify(current)) fail(409, "ACCOUNT_CHANGED_DURING_PREPARATION");
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
        Object.keys(policy).sort().join(",") !== "authorizationEpoch,deadline,feePolicyHash,gasReservedWei,registrar") {
      fail(503, "FUNDING_POLICY_NOT_CONFIGURED");
    }
    const raced = readExisting(donationId, latest, request);
    if (raced) return raced;
    const nonce = BigInt("0x" + crypto.randomBytes(32).toString("hex")).toString();
    try {
      return store.prepare({ profile: latest, terms: { donationId, purpose: request.purpose,
        projectId: request.projectId, amountWei: request.amountWei, nonce, ...policy } });
    } catch (error) {
      // A second service process may have committed between the read and write.
      if (error.code === "DONATION_INTENT_CONFLICT") {
        const committed = readExisting(donationId, latest, request);
        if (committed) return committed;
      }
      throw error;
    }
  }

  return {
    prepare,
    getOwn(req, donationId) {
      const current = accounts.requireUser(req), record = store.get(donationId);
      if (!record || record.userId !== current.id) fail(404, "DONATION_INTENT_NOT_FOUND");
      return record;
    },
    listOwn(req) { return store.listForUser(accounts.requireUser(req).id); }
  };
}

module.exports = { createDonationIntentService };
