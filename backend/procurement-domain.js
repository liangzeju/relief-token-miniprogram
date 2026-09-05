"use strict";

// No clock, network, storage, authentication, or cryptographic implementation lives here.
// `now` / `expiresAt` / `validUntil` are integer Unix seconds supplied by the caller.
// expiresAt is the signature deadline; it does not void already signed fulfillment.
// Actors must be authenticated upstream. Receipt fields describe verified escrow
// funding/payout events (not raw RPC receipts); the caller must obtain this evidence.
// verifyTypedData(domain, types, value, signature) must synchronously recover a wallet.
// initial/exportState use a replayable command journal, never trusted derived state.
// Journal provenance and chain evidence remain the caller's responsibility.

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function ensure(condition, code) {
  if (!condition) fail(code);
}

function text(value, field) {
  ensure(typeof value === "string" && value.length > 0 && value.trim() === value, `INVALID_${field}`);
  return value;
}

function integer(value, field, minimum = 1) {
  ensure(Number.isSafeInteger(value) && value >= minimum, `INVALID_${field}`);
  return value;
}

function decimal(value, field = "WEI", minimum = 0n) {
  ensure(typeof value === "bigint" || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)), `INVALID_${field}`);
  const result = BigInt(value);
  ensure(result >= minimum && result < (1n << 256n), `INVALID_${field}`);
  return result.toString();
}

function wallet(value, field = "WALLET") {
  ensure(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value), `INVALID_${field}`);
  return value.toLowerCase();
}

function hash(value, field = "HASH") {
  ensure(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value), `INVALID_${field}`);
  return value.toLowerCase();
}

function fields(value, allowed) {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), "INVALID_OBJECT");
  ensure(Object.keys(value).every((key) => allowed.includes(key)), "UNKNOWN_FIELD");
  return value;
}

// Canonical JSON data also prevents caller aliases, getters and executable values
// from entering the journal, signature callback, or domain state.
function data(value, ancestors = new Set(), preserveBigInt = false) {
  if (typeof value === "bigint") return preserveBigInt ? value : value.toString();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    ensure(Number.isSafeInteger(value), "INVALID_NUMBER");
    return value;
  }
  ensure(value && typeof value === "object" && !ancestors.has(value), "INVALID_DATA");
  ensure(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), "INVALID_DATA");
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "INVALID_DATA");
    if (Array.isArray(value)) ensure(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length, "INVALID_DATA");
    Object.defineProperty(result, key, { value: data(descriptor.value, ancestors, preserveBigInt), enumerable: true, writable: true, configurable: true });
  }
  if (Array.isArray(value)) ensure(Object.keys(result).length === value.length, "INVALID_DATA");
  ancestors.delete(value);
  return result;
}

function calculatePayableWei(unitPriceWei, acceptedQuantity) {
  const price = decimal(unitPriceWei, "UNIT_PRICE_WEI", 1n);
  integer(acceptedQuantity, "ACCEPTED_QUANTITY", 0);
  return decimal(BigInt(price) * BigInt(acceptedQuantity));
}

const TERM_TYPES = Object.freeze([
  ["contractId", "string"], ["version", "uint256"], ["reservationId", "string"],
  ["taskId", "string"], ["quoteId", "string"], ["resourceId", "string"],
  ["quantity", "uint256"], ["unitPriceWei", "uint256"],
  ["buyerOrganizationId", "string"], ["supplierOrganizationId", "string"],
  ["buyerWallet", "address"], ["supplierWallet", "address"],
  ["acceptanceCriteriaHash", "bytes32"], ["termsHash", "bytes32"],
  ["nonce", "uint256"], ["expiresAt", "uint256"]
].map(([name, type]) => Object.freeze({ name, type })));

function buildTypedData(version) {
  const value = {};
  for (const { name } of TERM_TYPES) value[name] = version[name];
  return data({
    domain: { name: "ReliefProcurement", version: "1", chainId: version.chainId, verifyingContract: version.escrowContract },
    types: { ProcurementContract: TERM_TYPES }, value
  });
}

function actor(value, role) {
  fields(value, ["id", "organizationId", "wallet", "role"]);
  ensure(value.role === role, "ACTOR_ROLE_REQUIRED");
  return { id: text(value.id, "ACTOR_ID"), organizationId: text(value.organizationId, "ORGANIZATION_ID"), wallet: wallet(value.wallet), role };
}

function samePerson(left, right) {
  return left.id === right.id || left.wallet === right.wallet;
}

function party(person, terms, side) {
  return person.wallet === terms[`${side}Wallet`] || person.organizationId === terms[`${side}OrganizationId`];
}

function createProcurementDomain(initial, options = {}) {
  fields(options, ["chainId", "escrowContract", "verifyTypedData"]);
  ensure(options.verifyTypedData === undefined || typeof options.verifyTypedData === "function", "INVALID_VERIFIER");
  const verifyTypedData = options.verifyTypedData;
  const chainId = options.chainId === undefined ? undefined : decimal(options.chainId, "CHAIN_ID", 1n);
  const escrowContract = options.escrowContract === undefined ? undefined : wallet(options.escrowContract, "ESCROW_CONTRACT");
  let state = { quotes: [], reservations: [], contracts: [], escrows: [], batches: [], payables: [], payments: [] };
  const commands = [];
  let busy = false;

  function find(items, id) {
    text(id, "ID");
    const result = items.find((item) => item.id === id);
    ensure(result, "NOT_FOUND");
    return result;
  }

  function unused(items, id) {
    text(id, "ID");
    ensure(!items.some((item) => item.id === id), "DUPLICATE_ID");
  }

  function current(contract) {
    return contract.versions[contract.currentVersion - 1];
  }

  function fresh(expiresAt, now) {
    integer(now, "NOW", 0);
    ensure(expiresAt > now, "EXPIRED");
  }

  function termsFor(s, contractId, version, reservation, input) {
    ensure(chainId && escrowContract, "CHAIN_CONFIGURATION_REQUIRED");
    const quote = find(s.quotes, reservation.quoteId);
    fresh(quote.validUntil, input.now);
    const expiresAt = integer(input.expiresAt, "EXPIRES_AT");
    fresh(expiresAt, input.now);
    ensure(expiresAt <= quote.validUntil, "EXPIRY_EXCEEDS_QUOTE");
    const nonce = decimal(input.nonce, "NONCE");
    ensure(!s.contracts.some((contract) => contract.versions.some((versionTerms) =>
      versionTerms.buyerWallet === reservation.buyerWallet && versionTerms.nonce === nonce)), "NONCE_REUSED");
    calculatePayableWei(quote.unitPriceWei, reservation.quantity);
    return {
      contractId, version, reservationId: reservation.id, taskId: reservation.taskId,
      quoteId: quote.id, resourceId: quote.resourceId, quantity: reservation.quantity,
      unitPriceWei: quote.unitPriceWei, buyerWallet: reservation.buyerWallet,
      buyerOrganizationId: reservation.buyerOrganizationId,
      supplierWallet: quote.supplierWallet, supplierOrganizationId: quote.supplierOrganizationId,
      acceptanceCriteriaHash: hash(input.acceptanceCriteriaHash, "ACCEPTANCE_CRITERIA_HASH"),
      termsHash: hash(input.termsHash, "TERMS_HASH"), nonce, expiresAt, chainId, escrowContract
    };
  }

  function fulfilledContract(s, id) {
    const contract = find(s.contracts, id);
    ensure(["FUNDS_RESERVED", "IN_FULFILLMENT"].includes(contract.status), "FUNDS_RESERVED_REQUIRED");
    const terms = current(contract);
    const escrow = s.escrows.find((item) => item.id === contract.escrowBusinessId);
    ensure(escrow && escrow.status === "CONFIRMED" && escrow.contractId === contract.id &&
      escrow.contractVersion === terms.version && escrow.chainId === terms.chainId &&
      escrow.escrowContract === terms.escrowContract &&
      escrow.value === calculatePayableWei(terms.unitPriceWei, terms.quantity), "ESCROW_NOT_CONFIRMED");
    return contract;
  }

  function disallowFinanceParticipant(s, contractId, person) {
    ensure(!s.payments.some((payment) => payment.contractId === contractId && samePerson(payment.financeActor, person)), "SEPARATION_OF_DUTIES");
  }

  function independentReviewer(s, batch, reviewer) {
    const terms = current(find(s.contracts, batch.contractId));
    ensure(!party(reviewer, terms, "buyer") && !party(reviewer, terms, "supplier") &&
      !samePerson(reviewer, batch.deliveryActor) && !samePerson(reviewer, batch.acceptance.actor), "REVIEWER_NOT_INDEPENDENT");
    disallowFinanceParticipant(s, batch.contractId, reviewer);
  }

  function payableFor(s, batchId) {
    const batch = find(s.batches, batchId);
    ensure(["ACCEPTED", "PARTIAL"].includes(batch.status) && batch.acceptedQuantity > 0, "BATCH_NOT_PAYABLE");
    const existing = s.payables.find((item) => item.batchId === batch.id);
    if (existing) return existing;
    const contract = fulfilledContract(s, batch.contractId);
    const terms = current(contract);
    ensure(batch.contractVersion === terms.version, "VERSION_MISMATCH");
    const amountWei = calculatePayableWei(terms.unitPriceWei, batch.acceptedQuantity);
    const prior = s.payables.filter((item) => item.contractId === contract.id);
    ensure(prior.reduce((sum, item) => sum + BigInt(item.acceptedQuantity), BigInt(batch.acceptedQuantity)) <= BigInt(terms.quantity), "CONTRACT_QUANTITY_EXCEEDED");
    ensure(prior.reduce((sum, item) => sum + BigInt(item.amountWei), BigInt(amountWei)) <= BigInt(calculatePayableWei(terms.unitPriceWei, terms.quantity)), "CONTRACT_VALUE_EXCEEDED");
    const payable = { id: `payable:${batch.id}`, batchId: batch.id, contractId: contract.id,
      contractVersion: terms.version, acceptedQuantity: batch.acceptedQuantity, amountWei,
      to: terms.supplierWallet, status: "PAYABLE" };
    s.payables.push(payable);
    return payable;
  }

  const handlers = {
    addQuote(s, input) {
      fields(input, ["id", "resourceId", "supplierOrganizationId", "supplierWallet", "unitPriceWei", "availableQuantity", "validUntil", "etaHours"]);
      unused(s.quotes, input.id);
      const quote = { id: input.id, resourceId: text(input.resourceId, "RESOURCE_ID"),
        supplierOrganizationId: text(input.supplierOrganizationId, "SUPPLIER_ORGANIZATION_ID"),
        supplierWallet: wallet(input.supplierWallet), unitPriceWei: decimal(input.unitPriceWei, "UNIT_PRICE_WEI", 1n),
        availableQuantity: integer(input.availableQuantity, "AVAILABLE_QUANTITY"),
        validUntil: integer(input.validUntil, "VALID_UNTIL"), etaHours: integer(input.etaHours, "ETA_HOURS", 0) };
      s.quotes.push(quote);
      return quote;
    },

    reserve(s, input) {
      fields(input, ["id", "quoteId", "taskId", "quantity", "buyerWallet", "buyerOrganizationId", "now"]);
      unused(s.reservations, input.id);
      const quote = find(s.quotes, input.quoteId);
      fresh(quote.validUntil, input.now);
      const quantity = integer(input.quantity, "QUANTITY");
      ensure(quantity <= quote.availableQuantity, "INSUFFICIENT_AVAILABILITY");
      const reservation = { id: input.id, quoteId: quote.id, taskId: text(input.taskId, "TASK_ID"), quantity,
        buyerWallet: wallet(input.buyerWallet), buyerOrganizationId: text(input.buyerOrganizationId, "BUYER_ORGANIZATION_ID"), status: "RESERVED" };
      ensure(!party({ wallet: reservation.buyerWallet, organizationId: reservation.buyerOrganizationId }, quote, "supplier"), "BUYER_IS_SUPPLIER");
      quote.availableQuantity -= quantity;
      s.reservations.push(reservation);
      return reservation;
    },

    createContract(s, input) {
      fields(input, ["id", "reservationId", "acceptanceCriteriaHash", "termsHash", "nonce", "expiresAt", "now"]);
      unused(s.contracts, input.id);
      const reservation = find(s.reservations, input.reservationId);
      ensure(reservation.status === "RESERVED", "RESERVATION_UNAVAILABLE");
      const terms = termsFor(s, input.id, 1, reservation, input);
      const contract = { id: input.id, currentVersion: 1, versions: [terms], status: "DRAFT", signatures: {}, signatureHistory: [], escrowBusinessId: null };
      reservation.status = "BOUND";
      reservation.contractId = contract.id;
      s.contracts.push(contract);
      return contract;
    },

    reviseContract(s, input) {
      fields(input, ["contractId", "reservationId", "acceptanceCriteriaHash", "termsHash", "nonce", "expiresAt", "now"]);
      const contract = find(s.contracts, input.contractId);
      ensure(!s.batches.some((batch) => batch.contractId === contract.id), "FULFILLMENT_ALREADY_STARTED");
      ensure(contract.escrowBusinessId === null, "FUNDS_ALREADY_RESERVED");
      const previous = current(contract);
      const oldReservation = find(s.reservations, previous.reservationId);
      const reservation = input.reservationId === undefined ? oldReservation : find(s.reservations, input.reservationId);
      ensure(reservation === oldReservation || reservation.status === "RESERVED", "RESERVATION_UNAVAILABLE");
      ensure(reservation.buyerWallet === previous.buyerWallet && reservation.buyerOrganizationId === previous.buyerOrganizationId &&
        reservation.taskId === previous.taskId, "RESERVATION_OWNER_MISMATCH");
      const terms = termsFor(s, contract.id, integer(contract.currentVersion + 1, "VERSION"), reservation, {
        ...input, acceptanceCriteriaHash: input.acceptanceCriteriaHash === undefined ? previous.acceptanceCriteriaHash : input.acceptanceCriteriaHash,
        termsHash: input.termsHash === undefined ? previous.termsHash : input.termsHash
      });
      if (reservation !== oldReservation) {
        const oldQuote = find(s.quotes, oldReservation.quoteId);
        oldQuote.availableQuantity = integer(oldQuote.availableQuantity + oldReservation.quantity, "AVAILABLE_QUANTITY");
        oldReservation.status = "RELEASED";
        reservation.status = "BOUND";
        reservation.contractId = contract.id;
      }
      // Version terms and signatureHistory are append-only; only current authority resets.
      contract.versions.push(terms);
      contract.currentVersion = terms.version;
      contract.signatures = {};
      contract.status = "DRAFT";
      return contract;
    },

    signContract(s, input) {
      fields(input, ["contractId", "version", "party", "signature", "now"]);
      const contract = find(s.contracts, input.contractId);
      const terms = current(contract);
      ensure(integer(input.version, "VERSION") === terms.version, "VERSION_MISMATCH");
      ensure(["buyer", "supplier"].includes(input.party), "INVALID_PARTY");
      fresh(terms.expiresAt, input.now);
      ensure(typeof verifyTypedData === "function", "VERIFIER_REQUIRED");
      ensure(typeof input.signature === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(input.signature), "INVALID_SIGNATURE");
      const typed = buildTypedData(terms);
      let signer;
      try {
        signer = wallet(verifyTypedData(typed.domain, typed.types, typed.value, input.signature));
      } catch {
        fail("SIGNATURE_VERIFICATION_FAILED");
      }
      ensure(signer === terms[`${input.party}Wallet`], "SIGNER_MISMATCH");
      const existing = contract.signatures[input.party];
      if (existing) {
        ensure(existing.signature === input.signature, "PARTY_ALREADY_SIGNED");
        return contract;
      }
      ensure(!s.batches.some((batch) => batch.contractId === contract.id), "FULFILLMENT_ALREADY_STARTED");
      contract.signatures[input.party] = { signer, signature: input.signature };
      contract.signatureHistory.push({ version: terms.version, party: input.party, signer, signature: input.signature });
      contract.status = contract.signatures.buyer && contract.signatures.supplier ? "FUNDS_RESERVABLE" : "PARTIALLY_SIGNED";
      return contract;
    },

    recordEscrowConfirmed(s, input) {
      fields(input, ["contractId", "version", "escrowBusinessId", "txHash", "receipt"]);
      const contract = find(s.contracts, input.contractId);
      const terms = current(contract);
      ensure(integer(input.version, "VERSION") === terms.version, "VERSION_MISMATCH");
      ensure(contract.signatures.buyer && contract.signatures.supplier &&
        ["FUNDS_RESERVABLE", "FUNDS_RESERVED", "IN_FULFILLMENT"].includes(contract.status), "BOTH_SIGNATURES_REQUIRED");
      const escrowBusinessId = text(input.escrowBusinessId, "ESCROW_BUSINESS_ID");
      const txHash = hash(input.txHash, "TX_HASH");
      fields(input.receipt, ["status", "transactionHash", "chainId", "escrowContract", "value", "escrowBusinessId", "contractId", "contractVersion"]);
      ensure(input.receipt.status === 1, "RECEIPT_FAILED");
      const receipt = { status: 1, transactionHash: hash(input.receipt.transactionHash, "TX_HASH"),
        chainId: decimal(input.receipt.chainId, "CHAIN_ID", 1n), escrowContract: wallet(input.receipt.escrowContract, "ESCROW_CONTRACT"),
        value: decimal(input.receipt.value), escrowBusinessId: text(input.receipt.escrowBusinessId, "ESCROW_BUSINESS_ID"),
        contractId: text(input.receipt.contractId, "CONTRACT_ID"), contractVersion: integer(input.receipt.contractVersion, "VERSION") };
      ensure(receipt.transactionHash === txHash && receipt.chainId === terms.chainId && receipt.escrowContract === terms.escrowContract &&
        receipt.value === calculatePayableWei(terms.unitPriceWei, terms.quantity) && receipt.escrowBusinessId === escrowBusinessId &&
        receipt.contractId === contract.id && receipt.contractVersion === terms.version, "RECEIPT_MISMATCH");
      const existing = s.escrows.find((item) => item.contractId === contract.id);
      if (existing) {
        ensure(existing.id === escrowBusinessId && existing.txHash === txHash &&
          JSON.stringify(existing.receipt) === JSON.stringify(receipt), "ESCROW_ALREADY_CONFIRMED");
        return existing;
      }
      ensure(!s.escrows.some((item) => item.id === escrowBusinessId), "DUPLICATE_ESCROW_BUSINESS_ID");
      ensure(!s.escrows.some((item) => item.txHash === txHash) && !s.payments.some((item) => item.txHash === txHash), "TX_HASH_REUSED");
      const escrow = { id: escrowBusinessId, escrowBusinessId, contractId: contract.id, contractVersion: terms.version,
        chainId: terms.chainId, escrowContract: terms.escrowContract, value: receipt.value, txHash, status: "CONFIRMED", receipt };
      s.escrows.push(escrow);
      contract.escrowBusinessId = escrowBusinessId;
      contract.status = "FUNDS_RESERVED";
      return escrow;
    },

    deliverBatch(s, input) {
      fields(input, ["id", "contractId", "quantity", "actor"]);
      unused(s.batches, input.id);
      const contract = fulfilledContract(s, input.contractId);
      const terms = current(contract);
      const quantity = integer(input.quantity, "QUANTITY");
      const delivered = s.batches.filter((batch) => batch.contractId === contract.id)
        .reduce((sum, batch) => sum + BigInt(batch.deliveredQuantity), 0n);
      ensure(delivered + BigInt(quantity) <= BigInt(terms.quantity), "CONTRACT_QUANTITY_EXCEEDED");
      const deliveryActor = actor(input.actor, "delivery");
      ensure(party(deliveryActor, terms, "supplier"), "SUPPLIER_SCOPE_REQUIRED");
      const batch = { id: input.id, contractId: contract.id, contractVersion: terms.version,
        deliveredQuantity: quantity, acceptedQuantity: 0, deliveryActor, status: "DELIVERED", acceptance: null, review: null };
      contract.status = "IN_FULFILLMENT";
      s.batches.push(batch);
      return batch;
    },

    acceptBatch(s, input) {
      fields(input, ["batchId", "outcome", "acceptedQuantity", "actor"]);
      const batch = find(s.batches, input.batchId);
      ensure(batch.status === "DELIVERED", "BATCH_ALREADY_ASSESSED");
      const acceptanceActor = actor(input.actor, "acceptance");
      const terms = current(find(s.contracts, batch.contractId));
      ensure(acceptanceActor.wallet !== terms.buyerWallet && !party(acceptanceActor, terms, "supplier") &&
        !samePerson(acceptanceActor, batch.deliveryActor), "SEPARATION_OF_DUTIES");
      disallowFinanceParticipant(s, batch.contractId, acceptanceActor);
      const quantity = integer(input.acceptedQuantity, "ACCEPTED_QUANTITY", 0);
      ensure(quantity <= batch.deliveredQuantity, "ACCEPTED_QUANTITY_EXCEEDED");
      ensure(["ACCEPTED", "PARTIAL", "REJECTED", "DISPUTED"].includes(input.outcome), "INVALID_OUTCOME");
      ensure(input.outcome === "ACCEPTED" ? quantity === batch.deliveredQuantity :
        input.outcome === "PARTIAL" ? quantity > 0 && quantity < batch.deliveredQuantity : quantity === 0, "OUTCOME_QUANTITY_MISMATCH");
      batch.status = input.outcome;
      batch.acceptedQuantity = quantity;
      batch.acceptance = { actor: acceptanceActor, outcome: input.outcome, acceptedQuantity: quantity };
      return batch;
    },

    assignReviewer(s, input) {
      fields(input, ["batchId", "id", "assignmentId", "reviewer", "assignedBy", "reason", "assignedAt"]);
      const batch = find(s.batches, input.batchId);
      ensure(batch.status === "DISPUTED", "BATCH_NOT_DISPUTED");
      const id = text(input.id, "REVIEW_ASSIGNMENT_ID");
      ensure(id.isWellFormed(), "INVALID_REVIEW_ASSIGNMENT_ID");
      ensure(!s.batches.some(item => (item.reviewAssignments || []).some(assignment => assignment.id === id)), "DUPLICATE_REVIEW_ASSIGNMENT_ID");
      const reviewer = actor(input.reviewer, "reviewer");
      independentReviewer(s, batch, reviewer);
      ensure(typeof input.reason === "string" && input.reason.isWellFormed() &&
        input.reason.trim().length >= 2 && input.reason.length <= 2000, "INVALID_ASSIGNMENT_REASON");
      // Admin identity and registry binding are authenticated by the upstream caller.
      const assignment = { id, assignmentId: text(input.assignmentId, "ASSIGNMENT_ID"), reviewer,
        assignedBy: text(input.assignedBy, "ASSIGNED_BY"), reason: input.reason,
        assignedAt: integer(input.assignedAt, "ASSIGNED_AT", 0) };
      batch.reviewAssignments = [...(batch.reviewAssignments || []), assignment];
      return batch;
    },

    resolveDispute(s, input) {
      fields(input, ["batchId", "acceptedQuantity", "actor", "reviewAssignmentId"]);
      const batch = find(s.batches, input.batchId);
      ensure(batch.status === "DISPUTED", "BATCH_NOT_DISPUTED");
      const reviewer = actor(input.actor, "reviewer");
      independentReviewer(s, batch, reviewer);
      const assignment = batch.reviewAssignments?.at(-1);
      if (assignment) {
        ensure(input.reviewAssignmentId === assignment.id, "REVIEW_ASSIGNMENT_MISMATCH");
        ensure(["id", "organizationId", "wallet", "role"].every(field => reviewer[field] === assignment.reviewer[field]), "REVIEWER_ASSIGNMENT_MISMATCH");
      } else {
        // Only historical trusted journals may resolve without an assignment.
        ensure(input.reviewAssignmentId === undefined, "REVIEW_ASSIGNMENT_REQUIRED");
      }
      const quantity = integer(input.acceptedQuantity, "ACCEPTED_QUANTITY", 0);
      ensure(quantity <= batch.deliveredQuantity, "ACCEPTED_QUANTITY_EXCEEDED");
      batch.status = quantity === 0 ? "REJECTED" : quantity === batch.deliveredQuantity ? "ACCEPTED" : "PARTIAL";
      batch.acceptedQuantity = quantity;
      batch.review = { actor: reviewer, outcome: batch.status, acceptedQuantity: quantity,
        ...(assignment ? { reviewAssignmentId: assignment.id } : {}) };
      return batch;
    },

    derivePayable(s, input) {
      fields(input, ["batchId"]);
      return payableFor(s, input.batchId);
    },

    markPaymentPending(s, input) {
      fields(input, ["batchId", "paymentBusinessId", "actor", "onChainEscrowConfirmed"]);
      ensure(input.onChainEscrowConfirmed === true, "ESCROW_NOT_CONFIRMED");
      const financeActor = actor(input.actor, "finance");
      const batch = find(s.batches, input.batchId);
      const contract = fulfilledContract(s, batch.contractId);
      const terms = current(contract);
      ensure(financeActor.wallet !== terms.buyerWallet && !party(financeActor, terms, "supplier") && !s.batches.some((item) => item.contractId === contract.id &&
        ((item.acceptance && samePerson(financeActor, item.acceptance.actor)) || (item.review && samePerson(financeActor, item.review.actor)))), "SEPARATION_OF_DUTIES");
      const paymentBusinessId = text(input.paymentBusinessId, "PAYMENT_BUSINESS_ID");
      const existing = s.payments.find((item) => item.batchId === batch.id);
      if (existing) {
        ensure(existing.id === paymentBusinessId && JSON.stringify(existing.financeActor) === JSON.stringify(financeActor), "PAYMENT_ALREADY_EXISTS");
        return existing;
      }
      unused(s.payments, paymentBusinessId);
      const payable = payableFor(s, batch.id);
      ensure(payable.status === "PAYABLE", "BATCH_NOT_PAYABLE");
      const payment = { id: paymentBusinessId, paymentBusinessId, payableId: payable.id, batchId: batch.id,
        contractId: contract.id, contractVersion: terms.version, escrowBusinessId: contract.escrowBusinessId,
        chainId: terms.chainId, contract: terms.escrowContract,
        to: payable.to, value: payable.amountWei, financeActor, onChainEscrowConfirmed: true,
        status: "PAYMENT_PENDING", txHash: null, receipt: null };
      payable.status = "PAYMENT_PENDING";
      s.payments.push(payment);
      return payment;
    },

    confirmPayment(s, input) {
      fields(input, ["paymentBusinessId", "txHash", "receipt"]);
      const payment = find(s.payments, input.paymentBusinessId);
      const txHash = hash(input.txHash, "TX_HASH");
      fields(input.receipt, ["status", "transactionHash", "chainId", "contract", "to", "value", "paymentBusinessId"]);
      ensure(input.receipt.status === 1, "RECEIPT_FAILED");
      const receipt = { status: 1, transactionHash: hash(input.receipt.transactionHash, "TX_HASH"),
        chainId: decimal(input.receipt.chainId, "CHAIN_ID", 1n), contract: wallet(input.receipt.contract, "ESCROW_CONTRACT"),
        to: wallet(input.receipt.to), value: decimal(input.receipt.value), paymentBusinessId: text(input.receipt.paymentBusinessId, "PAYMENT_BUSINESS_ID") };
      ensure(receipt.transactionHash === txHash && receipt.chainId === payment.chainId && receipt.contract === payment.contract &&
        receipt.to === payment.to && receipt.value === payment.value && receipt.paymentBusinessId === payment.id, "RECEIPT_MISMATCH");
      ensure(!s.payments.some((other) => other.id !== payment.id && other.txHash === txHash) &&
        !s.escrows.some((escrow) => escrow.txHash === txHash), "TX_HASH_REUSED");
      if (payment.status === "PAID") {
        ensure(payment.txHash === txHash && JSON.stringify(payment.receipt) === JSON.stringify(receipt), "PAYMENT_ALREADY_PAID");
        return payment;
      }
      ensure(payment.status === "PAYMENT_PENDING", "PAYMENT_NOT_PENDING");
      payment.status = "PAID";
      payment.txHash = txHash;
      payment.receipt = receipt;
      find(s.payables, payment.payableId).status = "PAID";
      return payment;
    }
  };

  function execute(method, input) {
    ensure(!busy, "REENTRANT_OPERATION");
    ensure(typeof method === "string" && Object.hasOwn(handlers, method), "UNKNOWN_COMMAND");
    busy = true;
    try {
      const canonicalInput = data(input, new Set(), true);
      const next = data(state);
      const result = handlers[method](next, canonicalInput);
      const output = data(result);
      // No-op retries neither mutate state nor append duplicate journal entries.
      if (JSON.stringify(state) !== JSON.stringify(next)) {
        commands.push({ method, input: data(canonicalInput) });
        state = next;
      }
      return output;
    } finally {
      busy = false;
    }
  }

  if (initial !== undefined) {
    const seed = data(initial, new Set(), true);
    fields(seed, ["schemaVersion", "commands"]);
    ensure(seed.schemaVersion === 1 && Array.isArray(seed.commands), "INVALID_INITIAL_STATE");
    for (const command of seed.commands) {
      fields(command, ["method", "input"]);
      execute(command.method, command.input);
    }
  }

  const api = Object.fromEntries(Object.keys(handlers).map((method) => [method, (input) => execute(method, input)]));
  return Object.freeze({ ...api,
    getQuote: (id) => data(find(state.quotes, id)),
    getContract: (id) => data(find(state.contracts, id)),
    getEscrow: (id) => data(find(state.escrows, id)),
    getBatch: (id) => data(find(state.batches, id)),
    getPayment: (id) => data(find(state.payments, id)),
    getTypedData: (id) => buildTypedData(current(find(state.contracts, id))),
    snapshot: () => data(state),
    exportState: () => data({ schemaVersion: 1, commands })
  });
}

module.exports = { createProcurementDomain, calculatePayableWei, buildTypedData };
