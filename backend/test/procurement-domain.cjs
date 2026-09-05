"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProcurementDomain, calculatePayableWei, buildTypedData } = require("../procurement-domain.js");

// Public API examples below are the interface contract. Amounts/chain IDs/nonces
// are bigint or canonical decimal strings; quantities are safe integer Numbers.
// Time is explicit Unix seconds. No test below starts a server or touches storage.
// These tiny signature fixtures are STUBS, not cryptographic signature validation.
const MON = 10n ** 18n;
const address = (digit) => `0x${digit.repeat(40)}`;
const digest = (digit) => `0x${digit.repeat(64)}`;
const BUYER = address("1");
const SUPPLIER = address("2");
const ESCROW = address("e");
const NOW = 1000;
const identity = (id, organizationId, wallet, role) => ({ id, organizationId, wallet, role });
const DELIVERY = identity("deliverer", "supplier-org", address("3"), "delivery");
const ACCEPTOR = identity("acceptor", "buyer-org", address("4"), "acceptance");
const REVIEWER = identity("reviewer", "review-org", address("5"), "reviewer");
const FINANCE = identity("finance", "buyer-org", address("6"), "finance");

function verifyTypedDataStub(_domain, _types, _value, signature) {
  return signature === "0xb1" ? BUYER : signature === "0xb2" ? SUPPLIER : address("f");
}

const options = (verify = verifyTypedDataStub) => ({ chainId: "10143", escrowContract: ESCROW, verifyTypedData: verify });
const quoteInput = (overrides = {}) => ({ id: "quote-1", resourceId: "water", supplierOrganizationId: "supplier-org",
  supplierWallet: SUPPLIER, unitPriceWei: 12n * MON, availableQuantity: 10, validUntil: 3000, etaHours: 24, ...overrides });
const reserveInput = (overrides = {}) => ({ id: "reserve-1", quoteId: "quote-1", taskId: "task-1", quantity: 10,
  buyerWallet: BUYER, buyerOrganizationId: "buyer-org", now: NOW, ...overrides });
const contractInput = (overrides = {}) => ({ id: "contract-1", reservationId: "reserve-1", acceptanceCriteriaHash: digest("a"),
  termsHash: digest("b"), nonce: "1", expiresAt: 2000, now: NOW, ...overrides });
const signInput = (party, overrides = {}) => ({ contractId: "contract-1", version: 1, party,
  signature: party === "buyer" ? "0xb1" : "0xb2", now: NOW, ...overrides });

function fixture({ quantity = 10, price = 12n * MON, signed = true, funded = true, verify = verifyTypedDataStub } = {}) {
  const domain = createProcurementDomain(undefined, options(verify));
  domain.addQuote(quoteInput({ availableQuantity: quantity, unitPriceWei: price }));
  domain.reserve(reserveInput({ quantity }));
  domain.createContract(contractInput());
  if (signed) {
    signBoth(domain);
    if (funded) fund(domain);
  }
  return domain;
}

function signBoth(domain, version = 1) {
  domain.signContract(signInput("buyer", { version }));
  domain.signContract(signInput("supplier", { version }));
}

function escrowConfirmation(domain, contractId = "contract-1", txHash = digest("9"), escrowBusinessId = `escrow-${contractId}`) {
  const contract = domain.getContract(contractId);
  const terms = contract.versions[contract.currentVersion - 1];
  return { contractId, version: terms.version, escrowBusinessId, txHash,
    receipt: { status: 1, transactionHash: txHash, chainId: terms.chainId, escrowContract: terms.escrowContract,
      value: calculatePayableWei(terms.unitPriceWei, terms.quantity), escrowBusinessId, contractId, contractVersion: terms.version } };
}

function fund(domain, contractId = "contract-1", txHash = digest("9")) {
  return domain.recordEscrowConfirmed(escrowConfirmation(domain, contractId, txHash));
}

function deliver(domain, id = "batch-1", quantity = 10, actor = DELIVERY) {
  return domain.deliverBatch({ id, contractId: "contract-1", quantity, actor });
}

function accept(domain, acceptedQuantity = 1, outcome = "PARTIAL", batchId = "batch-1", actor = ACCEPTOR) {
  return domain.acceptBatch({ batchId, acceptedQuantity, outcome, actor });
}

function pending(domain, batchId = "batch-1", paymentBusinessId = "payment-1", overrides = {}) {
  return domain.markPaymentPending({ batchId, paymentBusinessId, actor: FINANCE, onChainEscrowConfirmed: true, ...overrides });
}

function confirmation(payment, txHash = digest("c"), overrides = {}) {
  return { paymentBusinessId: payment.id, txHash, receipt: { status: 1, transactionHash: txHash,
    chainId: payment.chainId, contract: payment.contract, to: payment.to,
    value: payment.value, paymentBusinessId: payment.id, ...overrides } };
}

function failsWithoutMutation(domain, operation, code) {
  const before = domain.snapshot();
  const journal = domain.exportState();
  assert.throws(operation, (error) => error.code === code, `Expected ${code}`);
  assert.deepEqual(domain.snapshot(), before);
  assert.deepEqual(domain.exportState(), journal);
}

test("10 units at 12 MON, only 1 accepted: payable and paid value are exactly 12 MON", () => {
  const domain = fixture();
  assert.equal(deliver(domain).status, "DELIVERED");
  assert.equal(accept(domain).status, "PARTIAL");
  const payable = domain.derivePayable({ batchId: "batch-1" });
  assert.equal(payable.acceptedQuantity, 1);
  assert.equal(payable.amountWei, (12n * MON).toString());
  const saved = domain.exportState();
  assert.deepEqual(domain.derivePayable({ batchId: "batch-1" }), payable);
  assert.deepEqual(domain.exportState(), saved);
  const payment = pending(domain);
  assert.equal(payment.value, (12n * MON).toString());
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("c"), { value: 120n * MON })), "RECEIPT_MISMATCH");
  assert.equal(domain.confirmPayment(confirmation(payment)).status, "PAID");
  assert.equal(domain.snapshot().payables[0].status, "PAID");
});

test("multiple batches cumulatively reserve, deliver and pay only accepted units", () => {
  const domain = fixture();
  deliver(domain, "batch-a", 4);
  deliver(domain, "batch-b", 6);
  failsWithoutMutation(domain, () => deliver(domain, "batch-c", 1), "CONTRACT_QUANTITY_EXCEEDED");
  accept(domain, 4, "ACCEPTED", "batch-a");
  accept(domain, 2, "PARTIAL", "batch-b");
  const a = domain.derivePayable({ batchId: "batch-a" });
  const b = domain.derivePayable({ batchId: "batch-b" });
  assert.equal(BigInt(a.amountWei) + BigInt(b.amountWei), 72n * MON);
  assert.equal(domain.snapshot().payables.length, 2);
  domain.confirmPayment(confirmation(pending(domain, "batch-a", "pay-a"), digest("a")));
  domain.confirmPayment(confirmation(pending(domain, "batch-b", "pay-b"), digest("b")));
  assert.equal(domain.snapshot().payments.reduce((sum, payment) => sum + BigInt(payment.value), 0n), 72n * MON);
});

test("full multi-batch acceptance reaches, but cannot exceed, the contract ceiling", () => {
  const domain = fixture();
  for (const [id, quantity] of [["a", 3], ["b", 7]]) {
    deliver(domain, id, quantity);
    accept(domain, quantity, "ACCEPTED", id);
    domain.derivePayable({ batchId: id });
  }
  assert.equal(domain.snapshot().payables.reduce((sum, item) => sum + BigInt(item.amountWei), 0n), 120n * MON);
  failsWithoutMutation(domain, () => accept(domain, 7, "ACCEPTED", "b"), "BATCH_ALREADY_ASSESSED");
});

test("both signatures only make funds reservable; a saved escrow confirmation is required for delivery", () => {
  const domain = fixture({ signed: false });
  assert.equal(domain.getContract("contract-1").status, "DRAFT");
  failsWithoutMutation(domain, () => deliver(domain), "FUNDS_RESERVED_REQUIRED");
  assert.equal(domain.signContract(signInput("buyer")).status, "PARTIALLY_SIGNED");
  failsWithoutMutation(domain, () => deliver(domain), "FUNDS_RESERVED_REQUIRED");
  const signed = domain.signContract(signInput("supplier"));
  assert.equal(signed.status, "FUNDS_RESERVABLE");
  assert.equal(signed.signatures.buyer.signer, BUYER);
  assert.equal(signed.signatures.supplier.signature, "0xb2");
  const journal = domain.exportState();
  assert.deepEqual(domain.signContract(signInput("supplier")), signed);
  assert.deepEqual(domain.exportState(), journal);
  failsWithoutMutation(domain, () => deliver(domain), "FUNDS_RESERVED_REQUIRED");
  assert.equal(domain.snapshot().escrows.length, 0);
  const escrow = fund(domain);
  assert.equal(escrow.value, (120n * MON).toString());
  assert.equal(domain.getContract("contract-1").status, "FUNDS_RESERVED");
  assert.equal(deliver(domain).status, "DELIVERED");
  assert.equal(domain.getContract("contract-1").status, "IN_FULFILLMENT");
});

test("typed data binds all procurement terms, version, nonce, chain and escrow", () => {
  const domain = fixture({ signed: false });
  const typed = domain.getTypedData("contract-1");
  const version = domain.getContract("contract-1").versions[0];
  assert.deepEqual(typed, buildTypedData(version));
  assert.deepEqual(typed.domain, { name: "ReliefProcurement", version: "1", chainId: "10143", verifyingContract: ESCROW });
  for (const field of ["contractId", "version", "reservationId", "taskId", "quoteId", "resourceId", "quantity", "unitPriceWei",
    "buyerOrganizationId", "supplierOrganizationId", "buyerWallet", "supplierWallet", "acceptanceCriteriaHash", "termsHash", "nonce", "expiresAt"]) {
    assert.equal(typed.value[field], version[field]);
    assert.ok(typed.types.ProcurementContract.some(({ name }) => name === field));
  }
  typed.value.quantity = 999;
  assert.equal(domain.getTypedData("contract-1").value.quantity, 10);
});

test("signature callback stub must return matching recovered wallet, never boolean or Promise", () => {
  for (const result of [true, false, null, {}, Promise.resolve(BUYER)]) {
    function invalidVerifyTypedDataStub() { return result; }
    const domain = fixture({ signed: false, verify: invalidVerifyTypedDataStub });
    failsWithoutMutation(domain, () => domain.signContract(signInput("buyer")), "SIGNATURE_VERIFICATION_FAILED");
  }
  const domain = fixture({ signed: false });
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer", { signature: "0xb2" })), "SIGNER_MISMATCH");
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer", { signature: "0xff" })), "SIGNER_MISMATCH");
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer", { signature: "buyer" })), "INVALID_SIGNATURE");
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer", { party: "admin" })), "INVALID_PARTY");
});

test("absent or throwing verifier never enables signature authority", () => {
  const domain = createProcurementDomain(undefined, { chainId: "10143", escrowContract: ESCROW });
  domain.addQuote(quoteInput());
  domain.reserve(reserveInput());
  domain.createContract(contractInput());
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer")), "VERIFIER_REQUIRED");
  function throwingVerifyTypedDataStub() { throw new Error("stub verifier failure"); }
  const failing = fixture({ signed: false, verify: throwingVerifyTypedDataStub });
  failsWithoutMutation(failing, () => failing.signContract(signInput("buyer")), "SIGNATURE_VERIFICATION_FAILED");
});

test("signature callback receives isolated copies and cannot reenter mutations", () => {
  let domain;
  function mutatingVerifyTypedDataStub(_typedDomain, _types, value) {
    value.quantity = 1000;
    assert.throws(() => domain.reserve(reserveInput({ id: "attack" })), { code: "REENTRANT_OPERATION" });
    return BUYER;
  }
  domain = fixture({ signed: false, verify: mutatingVerifyTypedDataStub });
  domain.signContract(signInput("buyer"));
  assert.equal(domain.getContract("contract-1").versions[0].quantity, 10);
  assert.equal(domain.snapshot().reservations.length, 1);
});

test("expiry is exclusive at the deadline; an unsigned or half-signed expired version cannot complete", () => {
  const domain = fixture({ signed: false });
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer", { now: 2000 })), "EXPIRED");
  domain.signContract(signInput("buyer", { now: 1999 }));
  failsWithoutMutation(domain, () => domain.signContract(signInput("supplier", { now: 2001 })), "EXPIRED");
  assert.equal(domain.getContract("contract-1").status, "PARTIALLY_SIGNED");
});

test("revision resets effective signatures, preserves version/signature history, and rejects stale signatures/nonces", () => {
  const domain = fixture({ funded: false });
  const original = domain.getContract("contract-1");
  const revised = domain.reviseContract({ contractId: "contract-1", termsHash: digest("c"), nonce: "2", expiresAt: 2200, now: NOW });
  assert.equal(revised.currentVersion, 2);
  assert.equal(revised.status, "DRAFT");
  assert.deepEqual(revised.signatures, {});
  assert.deepEqual(revised.versions[0], original.versions[0]);
  assert.deepEqual(revised.signatureHistory, original.signatureHistory);
  assert.equal(revised.versions[1].termsHash, digest("c"));
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer")), "VERSION_MISMATCH");
  failsWithoutMutation(domain, () => deliver(domain), "FUNDS_RESERVED_REQUIRED");
  failsWithoutMutation(domain, () => domain.reviseContract({ contractId: "contract-1", nonce: "1", expiresAt: 2300, now: NOW }), "NONCE_REUSED");
  signBoth(domain, 2);
  fund(domain);
  deliver(domain);
  failsWithoutMutation(domain, () => domain.reviseContract({ contractId: "contract-1", nonce: "3", expiresAt: 2300, now: NOW }), "FULFILLMENT_ALREADY_STARTED");
});

test("quote/quantity/price/supplier changes use a new reservation and release old availability atomically", () => {
  const domain = fixture({ funded: false });
  domain.addQuote(quoteInput({ id: "quote-2", supplierWallet: address("7"), supplierOrganizationId: "supplier-2", unitPriceWei: "7", availableQuantity: 5 }));
  domain.reserve(reserveInput({ id: "reserve-2", quoteId: "quote-2", quantity: 5 }));
  const revised = domain.reviseContract({ contractId: "contract-1", reservationId: "reserve-2", nonce: "2", expiresAt: 2100, now: NOW });
  assert.equal(revised.versions[1].quantity, 5);
  assert.equal(revised.versions[1].unitPriceWei, "7");
  assert.equal(revised.versions[1].supplierWallet, address("7"));
  assert.equal(domain.getQuote("quote-1").availableQuantity, 10);
  assert.equal(domain.getQuote("quote-2").availableQuantity, 0);
  assert.equal(domain.snapshot().reservations[0].status, "RELEASED");
  assert.equal(revised.versions[0].quantity, 10);
  assert.deepEqual(revised.signatures, {});
  failsWithoutMutation(domain, () => domain.createContract(contractInput({ id: "another", nonce: "3" })), "RESERVATION_UNAVAILABLE");
});

test("reservation ownership and task cannot be swapped during revision", () => {
  for (const change of [{ buyerWallet: address("8") }, { buyerOrganizationId: "other-org" }, { taskId: "task-other" }]) {
    const domain = fixture({ funded: false });
    domain.addQuote(quoteInput({ id: "quote-2" }));
    domain.reserve(reserveInput({ id: "reserve-2", quoteId: "quote-2", ...change }));
    failsWithoutMutation(domain, () => domain.reviseContract({ contractId: "contract-1", reservationId: "reserve-2", nonce: "2", expiresAt: 2200, now: NOW }), "RESERVATION_OWNER_MISMATCH");
  }
});

test("expired quotes and overselling are rejected, including aggregate reservations", () => {
  const domain = createProcurementDomain();
  domain.addQuote(quoteInput());
  failsWithoutMutation(domain, () => domain.reserve(reserveInput({ now: 3000 })), "EXPIRED");
  failsWithoutMutation(domain, () => domain.reserve(reserveInput({ quantity: 11 })), "INSUFFICIENT_AVAILABILITY");
  domain.reserve(reserveInput({ quantity: 6 }));
  assert.equal(domain.getQuote("quote-1").availableQuantity, 4);
  failsWithoutMutation(domain, () => domain.reserve(reserveInput({ id: "reserve-2", quantity: 5 })), "INSUFFICIENT_AVAILABILITY");
  domain.reserve(reserveInput({ id: "reserve-2", quantity: 4 }));
  assert.equal(domain.getQuote("quote-1").availableQuantity, 0);
  failsWithoutMutation(domain, () => domain.reserve(reserveInput({ id: "reserve-3", quantity: 1 })), "INSUFFICIENT_AVAILABILITY");
  failsWithoutMutation(domain, () => domain.addQuote(quoteInput()), "DUPLICATE_ID");
});

test("contract creation rejects expired quote/deadline, deadline beyond quote and reused reservation", () => {
  const domain = createProcurementDomain(undefined, options());
  domain.addQuote(quoteInput());
  domain.reserve(reserveInput());
  failsWithoutMutation(domain, () => domain.createContract(contractInput({ now: 3000, expiresAt: 4000 })), "EXPIRED");
  failsWithoutMutation(domain, () => domain.createContract(contractInput({ expiresAt: NOW })), "EXPIRED");
  failsWithoutMutation(domain, () => domain.createContract(contractInput({ expiresAt: 3001 })), "EXPIRY_EXCEEDS_QUOTE");
  domain.createContract(contractInput());
  failsWithoutMutation(domain, () => domain.createContract(contractInput({ id: "contract-2", nonce: "2" })), "RESERVATION_UNAVAILABLE");
});

test("rejected, disputed and unassessed deliveries produce no payable or payment", () => {
  for (const outcome of [null, "REJECTED", "DISPUTED"]) {
    const domain = fixture();
    deliver(domain);
    if (outcome) accept(domain, 0, outcome);
    failsWithoutMutation(domain, () => domain.derivePayable({ batchId: "batch-1" }), "BATCH_NOT_PAYABLE");
    failsWithoutMutation(domain, () => pending(domain), "BATCH_NOT_PAYABLE");
    assert.equal(domain.snapshot().payables.length, 0);
    assert.equal(domain.snapshot().payments.length, 0);
  }
});

test("acceptance outcome and quantity agree; failed assessments leave delivery unchanged", () => {
  const domain = fixture();
  deliver(domain);
  for (const [outcome, quantity, code] of [
    ["ACCEPTED", 1, "OUTCOME_QUANTITY_MISMATCH"], ["PARTIAL", 0, "OUTCOME_QUANTITY_MISMATCH"],
    ["PARTIAL", 10, "OUTCOME_QUANTITY_MISMATCH"], ["REJECTED", 1, "OUTCOME_QUANTITY_MISMATCH"],
    ["DISPUTED", 1, "OUTCOME_QUANTITY_MISMATCH"], ["OTHER", 0, "INVALID_OUTCOME"],
    ["ACCEPTED", 11, "ACCEPTED_QUANTITY_EXCEEDED"], ["PARTIAL", 1.5, "INVALID_NUMBER"],
    ["PARTIAL", -1, "INVALID_ACCEPTED_QUANTITY"], ["PARTIAL", "1", "INVALID_ACCEPTED_QUANTITY"]
  ]) failsWithoutMutation(domain, () => accept(domain, quantity, outcome), code);
});

test("reviewer must be independent by actor ID, wallet and buyer/supplier organization", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain, 0, "DISPUTED");
  const conflicts = [
    { wallet: BUYER }, { wallet: SUPPLIER }, { organizationId: "buyer-org" }, { organizationId: "supplier-org" },
    { id: DELIVERY.id }, { wallet: DELIVERY.wallet }, { id: ACCEPTOR.id }, { wallet: ACCEPTOR.wallet }
  ];
  for (const conflict of conflicts) {
    failsWithoutMutation(domain, () => domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: 1, actor: { ...REVIEWER, ...conflict } }), "REVIEWER_NOT_INDEPENDENT");
  }
  failsWithoutMutation(domain, () => domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: 1, actor: { ...REVIEWER, role: "finance" } }), "ACTOR_ROLE_REQUIRED");
  failsWithoutMutation(domain, () => domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: 11, actor: REVIEWER }), "ACCEPTED_QUANTITY_EXCEEDED");
  const resolved = domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: 1, actor: REVIEWER });
  assert.equal(resolved.status, "PARTIAL");
  assert.equal(resolved.acceptance.outcome, "DISPUTED");
  assert.equal(resolved.review.acceptedQuantity, 1);
  assert.equal(domain.derivePayable({ batchId: "batch-1" }).amountWei, (12n * MON).toString());
  failsWithoutMutation(domain, () => domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: 10, actor: REVIEWER }), "BATCH_NOT_DISPUTED");
});

test("independent review can reject entirely or accept the exact full delivered quantity", () => {
  for (const quantity of [0, 10]) {
    const domain = fixture();
    deliver(domain);
    accept(domain, 0, "DISPUTED");
    const batch = domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: quantity, actor: REVIEWER });
    assert.equal(batch.status, quantity === 0 ? "REJECTED" : "ACCEPTED");
    if (quantity === 0) failsWithoutMutation(domain, () => pending(domain), "BATCH_NOT_PAYABLE");
    else assert.equal(pending(domain).value, (120n * MON).toString());
  }
});

test("supplier and delivery actor cannot perform original acceptance", () => {
  const domain = fixture();
  deliver(domain);
  for (const conflict of [{ wallet: SUPPLIER }, { organizationId: "supplier-org" }, { id: DELIVERY.id }, { wallet: DELIVERY.wallet }]) {
    failsWithoutMutation(domain, () => accept(domain, 1, "PARTIAL", "batch-1", { ...ACCEPTOR, ...conflict }), "SEPARATION_OF_DUTIES");
  }
});

test("payment requires explicit escrow confirmation and finance role, excluding supplier/acceptor/reviewer", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain, 0, "DISPUTED");
  domain.resolveDispute({ batchId: "batch-1", acceptedQuantity: 1, actor: REVIEWER });
  for (const flag of [false, "true", 1, null]) {
    failsWithoutMutation(domain, () => pending(domain, "batch-1", "payment-1", { onChainEscrowConfirmed: flag }), "ESCROW_NOT_CONFIRMED");
  }
  failsWithoutMutation(domain, () => domain.markPaymentPending({ batchId: "batch-1", paymentBusinessId: "payment-1", actor: FINANCE }), "ESCROW_NOT_CONFIRMED");
  failsWithoutMutation(domain, () => pending(domain, "batch-1", "payment-1", { actor: { ...FINANCE, role: "buyer" } }), "ACTOR_ROLE_REQUIRED");
  for (const conflict of [{ wallet: SUPPLIER }, { organizationId: "supplier-org" }, { id: ACCEPTOR.id },
    { wallet: ACCEPTOR.wallet }, { id: REVIEWER.id }, { wallet: REVIEWER.wallet }]) {
    failsWithoutMutation(domain, () => pending(domain, "batch-1", "payment-1", { actor: { ...FINANCE, ...conflict } }), "SEPARATION_OF_DUTIES");
  }
  assert.equal(pending(domain).status, "PAYMENT_PENDING");
});

test("finance segregation spans batches and cannot be bypassed by changing the order of actions", () => {
  const domain = fixture();
  deliver(domain, "a", 3);
  deliver(domain, "b", 3);
  deliver(domain, "c", 4);
  accept(domain, 3, "ACCEPTED", "a");
  accept(domain, 0, "DISPUTED", "c");
  pending(domain, "a", "pay-a");
  failsWithoutMutation(domain, () => accept(domain, 3, "ACCEPTED", "b", { ...FINANCE, role: "acceptance" }), "SEPARATION_OF_DUTIES");
  failsWithoutMutation(domain, () => domain.resolveDispute({ batchId: "c", acceptedQuantity: 1,
    actor: { ...REVIEWER, id: FINANCE.id } }), "SEPARATION_OF_DUTIES");
  accept(domain, 3, "ACCEPTED", "b", { ...ACCEPTOR, id: "another-acceptor", wallet: address("8") });
  failsWithoutMutation(domain, () => pending(domain, "b", "pay-b", { actor: { ...FINANCE, id: ACCEPTOR.id } }), "SEPARATION_OF_DUTIES");
});

test("receipt must match status, chain, escrow contract, beneficiary, exact value, hash and business ID", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain);
  const payment = pending(domain);
  for (const wrong of [{ status: 0 }, { status: "1" }, { status: 1n }]) {
    failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("c"), wrong)), "RECEIPT_FAILED");
  }
  for (const wrong of [{ chainId: "1" }, { contract: address("a") }, { to: BUYER }, { value: "0" },
    { value: (120n * MON).toString() }, { value: (12n * MON - 1n).toString() },
    { transactionHash: digest("d") }, { paymentBusinessId: "other-payment" }]) {
    failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("c"), wrong)), "RECEIPT_MISMATCH");
  }
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, "0x1234")), "INVALID_TX_HASH");
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("0"))), "INVALID_TX_HASH");
  failsWithoutMutation(domain, () => domain.confirmPayment({ ...confirmation(payment), paymentBusinessId: "unknown" }), "NOT_FOUND");
  assert.equal(domain.getPayment(payment.id).status, "PAYMENT_PENDING");
  assert.equal(domain.confirmPayment(confirmation(payment)).status, "PAID");
});

test("pending and confirmed retries are idempotent; alternate payment IDs and hashes cannot repay a batch", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain);
  const payment = pending(domain);
  const firstJournal = domain.exportState();
  assert.deepEqual(pending(domain), payment);
  assert.deepEqual(domain.exportState(), firstJournal);
  failsWithoutMutation(domain, () => pending(domain, "batch-1", "payment-2"), "PAYMENT_ALREADY_EXISTS");
  failsWithoutMutation(domain, () => pending(domain, "batch-1", "payment-1", { actor: { ...FINANCE, id: "different" } }), "PAYMENT_ALREADY_EXISTS");
  const request = confirmation(payment);
  const paid = domain.confirmPayment(request);
  const paidJournal = domain.exportState();
  assert.deepEqual(domain.confirmPayment(request), paid);
  assert.deepEqual(domain.exportState(), paidJournal);
  assert.deepEqual(pending(domain), paid);
  assert.equal(domain.derivePayable({ batchId: "batch-1" }).status, "PAID");
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("d"))), "PAYMENT_ALREADY_PAID");
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("c"), { value: "1" })), "RECEIPT_MISMATCH");
  assert.equal(domain.snapshot().payments.length, 1);
});

test("txHash and paymentBusinessId are globally unique across batches", () => {
  const domain = fixture();
  deliver(domain, "a", 5);
  deliver(domain, "b", 5);
  accept(domain, 5, "ACCEPTED", "a");
  accept(domain, 5, "ACCEPTED", "b");
  const a = pending(domain, "a", "pay-a");
  domain.confirmPayment(confirmation(a, digest("a")));
  failsWithoutMutation(domain, () => pending(domain, "b", "pay-a"), "DUPLICATE_ID");
  const b = pending(domain, "b", "pay-b");
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(b, `0x${"A".repeat(64)}`)), "TX_HASH_REUSED");
  assert.equal(domain.confirmPayment(confirmation(b, digest("b"))).status, "PAID");
});

test("cannot confirm an uncreated payment even with a plausible receipt", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain);
  failsWithoutMutation(domain, () => domain.confirmPayment({ paymentBusinessId: "payment-1", txHash: digest("a"), receipt: {} }), "NOT_FOUND");
});

test("large wei never uses floating point, including totals and confirmation", () => {
  const price = (1n << 200n) + 1234567890123456789n;
  const domain = fixture({ price });
  deliver(domain);
  accept(domain, 3);
  assert.equal(calculatePayableWei(price, 3), (price * 3n).toString());
  assert.equal(domain.derivePayable({ batchId: "batch-1" }).amountWei, (price * 3n).toString());
  const payment = pending(domain);
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, digest("a"), { value: price * 3n + 1n })), "RECEIPT_MISMATCH");
  assert.equal(domain.confirmPayment(confirmation(payment, digest("a"), { value: price * 3n })).value, (price * 3n).toString());
});

test("wei helper validates decimal representation, quantity and uint256 bounds", () => {
  for (const invalid of [12, 1.2, "01", "1.0", "1e18", "-1", " 1", "+1", "0x12", "", null, true, -1n, "0", 0n, 1n << 256n]) {
    assert.throws(() => calculatePayableWei(invalid, 1), { code: "INVALID_UNIT_PRICE_WEI" });
  }
  for (const invalid of [-1, 1.1, "1", 1n, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => calculatePayableWei("1", invalid), { code: "INVALID_ACCEPTED_QUANTITY" });
  }
  assert.equal(calculatePayableWei("1", 0), "0");
  assert.equal(calculatePayableWei("1", Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.throws(() => calculatePayableWei(1n << 255n, 2), { code: "INVALID_WEI" });
});

test("quote/reservation input validation rejects malformed identities, prices, quantities and times", () => {
  const domain = createProcurementDomain();
  for (const [change, code] of [
    [{ id: " " }, "INVALID_ID"], [{ resourceId: "" }, "INVALID_RESOURCE_ID"],
    [{ supplierOrganizationId: "" }, "INVALID_SUPPLIER_ORGANIZATION_ID"],
    [{ supplierWallet: address("0") }, "INVALID_WALLET"], [{ supplierWallet: "bad" }, "INVALID_WALLET"],
    [{ unitPriceWei: 12 }, "INVALID_UNIT_PRICE_WEI"], [{ availableQuantity: 0 }, "INVALID_AVAILABLE_QUANTITY"],
    [{ availableQuantity: "10" }, "INVALID_AVAILABLE_QUANTITY"], [{ availableQuantity: -1 }, "INVALID_AVAILABLE_QUANTITY"],
    [{ availableQuantity: 1.5 }, "INVALID_NUMBER"], [{ validUntil: 0 }, "INVALID_VALID_UNTIL"],
    [{ etaHours: -1 }, "INVALID_ETA_HOURS"], [{ unexpected: true }, "UNKNOWN_FIELD"]
  ]) failsWithoutMutation(domain, () => domain.addQuote(quoteInput(change)), code);
  domain.addQuote(quoteInput());
  for (const [change, code] of [
    [{ quantity: 0 }, "INVALID_QUANTITY"], [{ quantity: -1 }, "INVALID_QUANTITY"], [{ quantity: "1" }, "INVALID_QUANTITY"],
    [{ quantity: 1n }, "INVALID_QUANTITY"], [{ quantity: Number.MAX_SAFE_INTEGER + 1 }, "INVALID_NUMBER"],
    [{ now: -1 }, "INVALID_NOW"], [{ taskId: "" }, "INVALID_TASK_ID"],
    [{ buyerWallet: SUPPLIER }, "BUYER_IS_SUPPLIER"], [{ buyerOrganizationId: "supplier-org" }, "BUYER_IS_SUPPLIER"]
  ]) failsWithoutMutation(domain, () => domain.reserve(reserveInput(change)), code);
});

test("contract and delivery inputs fail closed, without consuming reservation or delivery capacity", () => {
  const domain = createProcurementDomain(undefined, options());
  domain.addQuote(quoteInput());
  domain.reserve(reserveInput());
  for (const [change, code] of [
    [{ acceptanceCriteriaHash: "hash" }, "INVALID_ACCEPTANCE_CRITERIA_HASH"],
    [{ termsHash: digest("0") }, "INVALID_TERMS_HASH"], [{ nonce: 1 }, "INVALID_NONCE"],
    [{ nonce: "01" }, "INVALID_NONCE"], [{ expiresAt: "2000" }, "INVALID_EXPIRES_AT"],
    [{ quantity: 100 }, "UNKNOWN_FIELD"]
  ]) failsWithoutMutation(domain, () => domain.createContract(contractInput(change)), code);
  domain.createContract(contractInput());
  signBoth(domain);
  fund(domain);
  for (const quantity of [0, -1, "1", 1n]) failsWithoutMutation(domain, () => deliver(domain, "bad", quantity), "INVALID_QUANTITY");
  failsWithoutMutation(domain, () => deliver(domain, "bad", 1, { ...DELIVERY, role: "finance" }), "ACTOR_ROLE_REQUIRED");
  deliver(domain, "batch-1", 1);
  failsWithoutMutation(domain, () => deliver(domain, "batch-1", 1), "DUPLICATE_ID");
});

test("read models, inputs and exported journals cannot mutate the private state", () => {
  const domain = createProcurementDomain(undefined, options());
  const quote = quoteInput();
  const result = domain.addQuote(quote);
  quote.availableQuantity = 100;
  result.availableQuantity = 100;
  domain.getQuote("quote-1").availableQuantity = 100;
  domain.snapshot().quotes[0].availableQuantity = 100;
  domain.exportState().commands[0].input.availableQuantity = 100;
  assert.equal(domain.getQuote("quote-1").availableQuantity, 10);
  domain.reserve(reserveInput());
  assert.equal(domain.getQuote("quote-1").availableQuantity, 0);
});

test("initial state is a validated replay journal; signatures are reverified and derived snapshots are not trusted", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain);
  const payment = pending(domain);
  domain.confirmPayment(confirmation(payment));
  const exported = JSON.parse(JSON.stringify(domain.exportState()));
  const restored = createProcurementDomain(exported, options());
  assert.deepEqual(restored.snapshot(), domain.snapshot());
  assert.deepEqual(restored.exportState(), domain.exportState());
  assert.deepEqual(restored.confirmPayment(confirmation(payment)), domain.getPayment(payment.id));
  assert.throws(() => createProcurementDomain(exported, { chainId: "10143", escrowContract: ESCROW }), { code: "VERIFIER_REQUIRED" });
  function wrongVerifyTypedDataStub() { return address("f"); }
  assert.throws(() => createProcurementDomain(exported, options(wrongVerifyTypedDataStub)), { code: "SIGNER_MISMATCH" });
  assert.throws(() => createProcurementDomain(domain.snapshot(), options()), { code: "UNKNOWN_FIELD" });
  assert.throws(() => createProcurementDomain({ schemaVersion: 2, commands: [] }), { code: "INVALID_INITIAL_STATE" });
  assert.throws(() => createProcurementDomain({ schemaVersion: 1, commands: [{ method: "__proto__", input: {} }] }), { code: "UNKNOWN_COMMAND" });
  const tampered = structuredClone(exported);
  tampered.commands.find(({ method }) => method === "acceptBatch").input.acceptedQuantity = 11;
  assert.throws(() => createProcurementDomain(tampered, options()), { code: "ACCEPTED_QUANTITY_EXCEEDED" });
});

test("invalid options, executable input, getters and circular data are rejected", () => {
  assert.throws(() => createProcurementDomain(undefined, { verifyTypedData: true }), { code: "INVALID_VERIFIER" });
  assert.throws(() => createProcurementDomain(undefined, { chainId: 10143 }), { code: "INVALID_CHAIN_ID" });
  assert.throws(() => createProcurementDomain(undefined, { escrowContract: "0x" }), { code: "INVALID_ESCROW_CONTRACT" });
  const domain = createProcurementDomain();
  for (const value of [null, [], new Date(), () => {}, undefined]) assert.throws(() => domain.addQuote(value));
  const circular = quoteInput();
  circular.self = circular;
  assert.throws(() => domain.addQuote(circular), { code: "INVALID_DATA" });
  let getterCalled = false;
  const getter = quoteInput();
  Object.defineProperty(getter, "unitPriceWei", { enumerable: true, get() { getterCalled = true; return "1"; } });
  assert.throws(() => domain.addQuote(getter), { code: "INVALID_DATA" });
  assert.equal(getterCalled, false);
  domain.addQuote(quoteInput({ id: "__proto__" }));
  assert.equal(domain.getQuote("__proto__").id, "__proto__");
});

test("real ethers typed-data recovery rejects a genuine signature from a previous version", async () => {
  // This separate compatibility test uses actual local cryptography, not the stubs.
  const { Wallet, verifyTypedData } = require("ethers");
  const buyer = new Wallet(`0x${"11".repeat(32)}`);
  const supplier = new Wallet(`0x${"22".repeat(32)}`);
  const domain = createProcurementDomain(undefined, { ...options(), verifyTypedData });
  domain.addQuote(quoteInput({ supplierWallet: supplier.address }));
  domain.reserve(reserveInput({ buyerWallet: buyer.address }));
  domain.createContract(contractInput());
  const first = domain.getTypedData("contract-1");
  const buyerSignature = await buyer.signTypedData(first.domain, first.types, first.value);
  const supplierSignature = await supplier.signTypedData(first.domain, first.types, first.value);
  domain.signContract(signInput("buyer", { signature: buyerSignature }));
  domain.signContract(signInput("supplier", { signature: supplierSignature }));
  domain.reviseContract({ contractId: "contract-1", termsHash: digest("d"), nonce: "2", expiresAt: 2200, now: NOW });
  failsWithoutMutation(domain, () => domain.signContract(signInput("buyer", { version: 2, signature: buyerSignature })), "SIGNER_MISMATCH");
  const second = domain.getTypedData("contract-1");
  const newBuyerSignature = await buyer.signTypedData(second.domain, second.types, second.value);
  const newSupplierSignature = await supplier.signTypedData(second.domain, second.types, second.value);
  domain.signContract(signInput("buyer", { version: 2, signature: newBuyerSignature }));
  assert.equal(domain.signContract(signInput("supplier", { version: 2, signature: newSupplierSignature })).status, "FUNDS_RESERVABLE");
});

test("explicit null revision hashes are rejected and cannot silently retain old signed terms", () => {
  const domain = fixture({ funded: false });
  for (const [key, code] of [["termsHash", "INVALID_TERMS_HASH"], ["acceptanceCriteriaHash", "INVALID_ACCEPTANCE_CRITERIA_HASH"]]) {
    failsWithoutMutation(domain, () => domain.reviseContract({ contractId: "contract-1", nonce: "2", expiresAt: 2200,
      now: NOW, [key]: null }), code);
  }
});

test("BigInt normalization is restricted to fields explicitly accepting decimal integers", () => {
  const domain = createProcurementDomain(undefined, options());
  failsWithoutMutation(domain, () => domain.addQuote(quoteInput({ resourceId: 1n })), "INVALID_RESOURCE_ID");
  failsWithoutMutation(domain, () => domain.addQuote(quoteInput({ id: 1n })), "INVALID_ID");
  domain.addQuote(quoteInput());
  failsWithoutMutation(domain, () => domain.reserve(reserveInput({ taskId: 1n })), "INVALID_TASK_ID");
  domain.reserve(reserveInput());
  domain.createContract(contractInput({ nonce: 1n }));
  assert.equal(domain.getContract("contract-1").versions[0].nonce, "1");
  assert.throws(() => createProcurementDomain({ schemaVersion: 1, commands: [{ method: ["addQuote"], input: quoteInput() }] }), { code: "UNKNOWN_COMMAND" });
});

test("business IDs, hashes and buyer nonces remain unique across separate contracts", () => {
  const domain = fixture();
  deliver(domain);
  accept(domain);
  const first = pending(domain);
  domain.confirmPayment(confirmation(first));
  domain.addQuote(quoteInput({ id: "quote-2" }));
  domain.reserve(reserveInput({ id: "reserve-2", quoteId: "quote-2", taskId: "task-2" }));
  failsWithoutMutation(domain, () => domain.createContract(contractInput({ id: "contract-2", reservationId: "reserve-2" })), "NONCE_REUSED");
  domain.createContract(contractInput({ id: "contract-2", reservationId: "reserve-2", nonce: "2" }));
  domain.signContract(signInput("buyer", { contractId: "contract-2" }));
  domain.signContract(signInput("supplier", { contractId: "contract-2" }));
  fund(domain, "contract-2", digest("8"));
  domain.deliverBatch({ id: "batch-2", contractId: "contract-2", quantity: 10, actor: DELIVERY });
  accept(domain, 1, "PARTIAL", "batch-2");
  failsWithoutMutation(domain, () => pending(domain, "batch-2", first.id), "DUPLICATE_ID");
  const second = pending(domain, "batch-2", "payment-2");
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(second)), "TX_HASH_REUSED");
});

test("small quantity matrix: each outcome derives only unit price times final accepted quantity", () => {
  const price = MON + 1n;
  for (let quantity = 1; quantity <= 10; quantity++) {
    for (let accepted = 0; accepted <= quantity; accepted++) {
      const domain = fixture({ quantity, price });
      deliver(domain, "batch-1", quantity);
      accept(domain, accepted, accepted === 0 ? "REJECTED" : accepted === quantity ? "ACCEPTED" : "PARTIAL");
      if (accepted === 0) {
        failsWithoutMutation(domain, () => pending(domain), "BATCH_NOT_PAYABLE");
      } else {
        assert.equal(pending(domain).value, (price * BigInt(accepted)).toString());
      }
    }
  }
});

test("missing chain configuration and uint256 total overflow cannot create a contract", () => {
  const domain = createProcurementDomain();
  domain.addQuote(quoteInput());
  domain.reserve(reserveInput());
  failsWithoutMutation(domain, () => domain.createContract(contractInput()), "CHAIN_CONFIGURATION_REQUIRED");
  const overflow = createProcurementDomain(undefined, options());
  overflow.addQuote(quoteInput({ unitPriceWei: 1n << 255n }));
  overflow.reserve(reserveInput());
  failsWithoutMutation(overflow, () => overflow.createContract(contractInput()), "INVALID_WEI");
});

test("delivery requires current supplier organization OR supplier wallet, not merely the delivery role", () => {
  const domain = fixture();
  for (const outsider of [
    identity("outsider", "other-org", address("8"), "delivery"),
    identity("buyer", "buyer-org", BUYER, "delivery")
  ]) failsWithoutMutation(domain, () => deliver(domain, "unauthorized", 1, outsider), "SUPPLIER_SCOPE_REQUIRED");
  assert.equal(deliver(domain, "org-authorized", 4, DELIVERY).status, "DELIVERED");
  const supplierWalletActor = identity("supplier-wallet", "external-org", SUPPLIER, "delivery");
  assert.equal(deliver(domain, "wallet-authorized", 6, supplierWalletActor).status, "DELIVERED");
});

test("delivery and escrow confirmation bind the revised supplier and contract version", () => {
  function revisedSupplierVerifyTypedDataStub(domain, types, value, signature) {
    return signature === "0xb7" ? address("7") : verifyTypedDataStub(domain, types, value, signature);
  }
  const domain = fixture({ funded: false, verify: revisedSupplierVerifyTypedDataStub });
  const staleEscrow = escrowConfirmation(domain);
  domain.addQuote(quoteInput({ id: "quote-new", supplierOrganizationId: "new-supplier-org", supplierWallet: address("7") }));
  domain.reserve(reserveInput({ id: "reserve-new", quoteId: "quote-new" }));
  domain.reviseContract({ contractId: "contract-1", reservationId: "reserve-new", nonce: "2", expiresAt: 2200, now: NOW });
  failsWithoutMutation(domain, () => domain.recordEscrowConfirmed(staleEscrow), "VERSION_MISMATCH");
  domain.signContract(signInput("buyer", { version: 2 }));
  failsWithoutMutation(domain, () => domain.signContract(signInput("supplier", { version: 2 })), "SIGNER_MISMATCH");
  domain.signContract(signInput("supplier", { version: 2, signature: "0xb7" }));
  fund(domain);
  failsWithoutMutation(domain, () => deliver(domain), "SUPPLIER_SCOPE_REQUIRED");
  assert.equal(deliver(domain, "new-delivery", 10, { ...DELIVERY, organizationId: "new-supplier-org" }).contractVersion, 2);
});

test("acceptance and finance may belong to the buyer organization but must not use the buyer wallet", () => {
  const domain = fixture();
  deliver(domain);
  failsWithoutMutation(domain, () => accept(domain, 1, "PARTIAL", "batch-1", { ...ACCEPTOR, wallet: BUYER }), "SEPARATION_OF_DUTIES");
  assert.equal(accept(domain).acceptance.actor.organizationId, "buyer-org");
  failsWithoutMutation(domain, () => pending(domain, "batch-1", "payment-1", { actor: { ...FINANCE, wallet: BUYER } }), "SEPARATION_OF_DUTIES");
  assert.equal(pending(domain).financeActor.wallet, FINANCE.wallet);
});

test("neither draft nor a single signature permits escrow confirmation", () => {
  const domain = fixture({ signed: false });
  failsWithoutMutation(domain, () => fund(domain), "BOTH_SIGNATURES_REQUIRED");
  domain.signContract(signInput("buyer"));
  failsWithoutMutation(domain, () => fund(domain), "BOTH_SIGNATURES_REQUIRED");
  domain.signContract(signInput("supplier"));
  assert.equal(domain.getContract("contract-1").status, "FUNDS_RESERVABLE");
  assert.equal(fund(domain).status, "CONFIRMED");
  assert.equal(domain.getContract("contract-1").status, "FUNDS_RESERVED");
});

test("escrow receipt strictly validates every funding field and the full contract amount", () => {
  const domain = fixture({ funded: false });
  const valid = escrowConfirmation(domain);
  for (const status of [0, "1", 1n, true, null]) {
    failsWithoutMutation(domain, () => domain.recordEscrowConfirmed({ ...valid, receipt: { ...valid.receipt, status } }), "RECEIPT_FAILED");
  }
  for (const wrong of [
    { chainId: "1" }, { escrowContract: address("a") }, { value: "0" }, { value: 12n * MON },
    { value: 120n * MON - 1n }, { value: 120n * MON + 1n }, { transactionHash: digest("8") },
    { escrowBusinessId: "other-escrow" }, { contractId: "contract-other" }, { contractVersion: 2 }
  ]) failsWithoutMutation(domain, () => domain.recordEscrowConfirmed({ ...valid, receipt: { ...valid.receipt, ...wrong } }), "RECEIPT_MISMATCH");
  for (const [wrong, code] of [
    [{ chainId: 10143 }, "INVALID_CHAIN_ID"], [{ chainId: "0" }, "INVALID_CHAIN_ID"],
    [{ escrowContract: address("0") }, "INVALID_ESCROW_CONTRACT"], [{ escrowContract: "0x123" }, "INVALID_ESCROW_CONTRACT"],
    [{ value: 120 }, "INVALID_WEI"], [{ value: "-1" }, "INVALID_WEI"], [{ value: "01" }, "INVALID_WEI"],
    [{ transactionHash: "0x123" }, "INVALID_TX_HASH"], [{ escrowBusinessId: "" }, "INVALID_ESCROW_BUSINESS_ID"],
    [{ contractId: "" }, "INVALID_CONTRACT_ID"], [{ contractVersion: "1" }, "INVALID_VERSION"],
    [{ unexpected: true }, "UNKNOWN_FIELD"]
  ]) failsWithoutMutation(domain, () => domain.recordEscrowConfirmed({ ...valid, receipt: { ...valid.receipt, ...wrong } }), code);
  for (const [wrong, code] of [
    [{ contractId: "unknown" }, "NOT_FOUND"], [{ version: 2 }, "VERSION_MISMATCH"], [{ version: "1" }, "INVALID_VERSION"],
    [{ version: 0 }, "INVALID_VERSION"], [{ escrowBusinessId: "" }, "INVALID_ESCROW_BUSINESS_ID"],
    [{ txHash: "0x123" }, "INVALID_TX_HASH"], [{ txHash: digest("0") }, "INVALID_TX_HASH"], [{ receipt: null }, "INVALID_OBJECT"]
  ]) failsWithoutMutation(domain, () => domain.recordEscrowConfirmed({ ...valid, ...wrong }), code);
  for (const key of Object.keys(valid.receipt)) {
    const missing = structuredClone(valid);
    delete missing.receipt[key];
    const before = domain.exportState();
    assert.throws(() => domain.recordEscrowConfirmed(missing));
    assert.deepEqual(domain.exportState(), before);
  }
  failsWithoutMutation(domain, () => deliver(domain), "FUNDS_RESERVED_REQUIRED");
  const saved = domain.recordEscrowConfirmed({ ...valid, receipt: { ...valid.receipt, chainId: 10143n, value: 120n * MON } });
  assert.equal(saved.value, (120n * MON).toString());
  assert.equal(saved.chainId, "10143");
  assert.equal(domain.getContract("contract-1").escrowBusinessId, valid.escrowBusinessId);
});

test("escrow confirmation retries are idempotent, preserve fulfillment status, and cannot rewrite a lock", () => {
  const domain = fixture({ funded: false });
  const request = escrowConfirmation(domain);
  const escrow = domain.recordEscrowConfirmed(request);
  const journal = domain.exportState();
  assert.deepEqual(domain.recordEscrowConfirmed(request), escrow);
  assert.deepEqual(domain.exportState(), journal);
  failsWithoutMutation(domain, () => domain.recordEscrowConfirmed(escrowConfirmation(domain, "contract-1", digest("8"))), "ESCROW_ALREADY_CONFIRMED");
  failsWithoutMutation(domain, () => domain.recordEscrowConfirmed(escrowConfirmation(domain, "contract-1", digest("9"), "new-business")), "ESCROW_ALREADY_CONFIRMED");
  failsWithoutMutation(domain, () => domain.reviseContract({ contractId: "contract-1", nonce: "2", expiresAt: 2200, now: NOW }), "FUNDS_ALREADY_RESERVED");
  deliver(domain);
  assert.deepEqual(domain.recordEscrowConfirmed(request), escrow);
  assert.equal(domain.getContract("contract-1").status, "IN_FULFILLMENT");
  domain.getEscrow(escrow.id).value = "1";
  escrow.receipt.value = "2";
  request.receipt.value = "3";
  assert.equal(domain.getEscrow(escrow.id).value, (120n * MON).toString());
});

test("escrow business IDs and transaction hashes are unique across contracts and payout records", () => {
  const domain = fixture();
  const firstEscrow = domain.snapshot().escrows[0];
  deliver(domain);
  accept(domain);
  const payment = pending(domain);
  failsWithoutMutation(domain, () => domain.confirmPayment(confirmation(payment, firstEscrow.txHash)), "TX_HASH_REUSED");
  domain.confirmPayment(confirmation(payment, digest("c")));
  domain.addQuote(quoteInput({ id: "quote-2" }));
  domain.reserve(reserveInput({ id: "reserve-2", quoteId: "quote-2", taskId: "task-2" }));
  domain.createContract(contractInput({ id: "contract-2", reservationId: "reserve-2", nonce: "2" }));
  domain.signContract(signInput("buyer", { contractId: "contract-2" }));
  domain.signContract(signInput("supplier", { contractId: "contract-2" }));
  failsWithoutMutation(domain, () => domain.recordEscrowConfirmed(escrowConfirmation(domain, "contract-2", digest("8"), firstEscrow.id)), "DUPLICATE_ESCROW_BUSINESS_ID");
  failsWithoutMutation(domain, () => domain.recordEscrowConfirmed(escrowConfirmation(domain, "contract-2", firstEscrow.txHash)), "TX_HASH_REUSED");
  failsWithoutMutation(domain, () => domain.recordEscrowConfirmed(escrowConfirmation(domain, "contract-2", `0x${"C".repeat(64)}`)), "TX_HASH_REUSED");
  assert.equal(fund(domain, "contract-2", digest("8")).status, "CONFIRMED");
  assert.equal(domain.snapshot().escrows.length, 2);
});

test("true alone cannot create a payment path without a persisted escrow confirmation", () => {
  const domain = fixture({ funded: false });
  failsWithoutMutation(domain, () => deliver(domain), "FUNDS_RESERVED_REQUIRED");
  failsWithoutMutation(domain, () => pending(domain), "NOT_FOUND");
  fund(domain);
  deliver(domain);
  accept(domain);
  const payment = pending(domain);
  assert.equal(payment.escrowBusinessId, domain.getContract("contract-1").escrowBusinessId);
  assert.equal(domain.getEscrow(payment.escrowBusinessId).value, (120n * MON).toString());
  assert.equal(payment.value, (12n * MON).toString());
  const journal = domain.exportState();
  journal.commands = journal.commands.filter(({ method }) => method !== "recordEscrowConfirmed");
  assert.throws(() => createProcurementDomain(journal, options()), { code: "FUNDS_RESERVED_REQUIRED" });
  const restored = createProcurementDomain(JSON.parse(JSON.stringify(domain.exportState())), options());
  assert.deepEqual(restored.snapshot(), domain.snapshot());
  assert.deepEqual(pending(restored), payment);
});
