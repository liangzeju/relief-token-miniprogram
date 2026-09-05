"use strict";

const { ZeroHash } = require("ethers");

function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function queryParams(req) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const allowed = ["limit", "offset", "status", "purpose", "q"];
  const invalid = () => fail(400, "INVALID_FUNDING_QUERY", "筛选或分页参数无效");
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  function integer(key, fallback, maximum) {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^(0|[1-9][0-9]{0,8})$/.test(value) || Number(value) > maximum) invalid();
    return Number(value);
  }
  const limit = integer("limit", 25, 100), offset = integer("offset", 0, 100000000);
  const status = params.get("status") ?? "all", purpose = params.get("purpose") ?? "all", q = params.get("q") ?? "";
  if (!limit || !["all", "PREPARED", "RECORDED", "REORGED"].includes(status) || !/^(all|[0-5])$/.test(purpose) ||
      q !== "" && !/^0x[0-9a-f]{4,64}$/i.test(q)) invalid();
  return { limit, offset, status, purpose, q: q.toLowerCase() };
}
const balanceFields = ["gasReservedWei", "availableWei", "allocatedWei", "lockedWei", "spentWei", "refundedWei"];
const project = value => value === ZeroHash ? null : value;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// Read only. Stores contain prepared identity snapshots and a historical verified
// event projection; neither is a live RPC balance or permission to move money.
function createFundingReadService({ accounts, isAdmin, send, intents = null, funding = null, chainId = "10143", poolAddress = null, getIndexerStatus = null }) {
  if (typeof accounts?.requireUser !== "function" || typeof accounts?.assertOrigin !== "function" || typeof isAdmin !== "function" || typeof send !== "function" ||
      Boolean(intents) !== Boolean(funding) || Boolean(poolAddress) !== Boolean(intents) || getIndexerStatus !== null && typeof getIndexerStatus !== "function" ||
      getIndexerStatus && !intents) throw new TypeError("Invalid funding read dependencies.");
  function connection() {
    if (!intents) return { configured: false, chainId, poolAddress: null, live: false,
      indexerState: "DISABLED", indexedThroughBlock: null, confirmedBlock: null, reason: "尚未配置新版资金池，暂无可读取的捐赠账本" };
    if (!getIndexerStatus) return { configured: true, chainId, poolAddress, live: false,
      indexerState: "SAVED_ONLY", indexedThroughBlock: null, confirmedBlock: null, reason: "尚未连接持续索引，以下为已保存的账本记录" };
    const status = getIndexerStatus(), live = status.state === "IDLE" && status.errorCode === null && status.runtimeErrorCode === null &&
      status.lastSuccessAt !== null && status.throughBlock === status.confirmedBlock;
    return { configured: true, chainId, poolAddress, live, indexerState: status.state,
      indexedThroughBlock: status.throughBlock, confirmedBlock: status.confirmedBlock,
      reason: live ? `已同步至确认区块 ${status.throughBlock}` : status.state === "ERROR" ? "持续索引异常，当前仅展示上次通过核验的投影" : "持续索引正在追赶确认区块" };
  }
  const respond = (res, status, body) => send(res, status, body, { "Cache-Control": "no-store",
    "Vary": "Origin, Cookie, X-Relief-Actor", "X-Content-Type-Options": "nosniff" });

  function snapshot(ownerId) {
    if (!intents) return { records: [], ledger: null };
    // Read the mutable projection first, then immutable intents. Newer prepared
    // records cannot cause an already-recorded donation to lose its identity.
    const ledger = funding.readWithEvents(), records = intents.list();
    if (ledger.chainId !== chainId || !same(ledger.poolAddress, poolAddress)) throw new Error("Funding configuration mismatch.");
    const byId = new Map(records.map(record => [record.permit.donationId, record]));
    for (const record of records) {
      if (record.chainId !== chainId || !same(record.poolAddress, poolAddress)) throw new Error("Intent configuration mismatch.");
    }
    for (const donation of [...ledger.donations, ...ledger.orphanedDonations]) {
      const record = byId.get(donation.id), permit = record?.permit;
      if (!record || record.userId !== donation.donorUserId || !same(record.wallet, donation.donorWallet) ||
          permit.amountWei !== donation.amountWei || permit.gasReservedWei !== donation.gasReservedWei ||
          permit.purpose !== donation.purpose || project(permit.projectId) !== donation.projectId) {
        throw new Error("Recorded donation does not match original intent.");
      }
    }
    return { records: ownerId ? records.filter(record => record.userId === ownerId) : records, ledger };
  }
  function row(record, ledger) {
    const donation = ledger?.donations.find(item => item.id === record.permit.donationId);
    const orphan = ledger?.orphanedDonations.findLast(item => item.id === record.permit.donationId);
    return { id: record.permit.donationId, userId: record.userId, donorName: record.profile.name, wallet: record.wallet,
      purpose: record.permit.purpose, projectId: project(record.permit.projectId), amountWei: record.permit.amountWei,
      gasReservedWei: record.permit.gasReservedWei, createdAt: record.createdAt, status: donation ? "RECORDED" : orphan ? "REORGED" : "PREPARED",
      txHash: donation?.txHash ?? null, blockNumber: donation?.blockNumber ?? null };
  }
  function summary(records, ledger) {
    if (!ledger) return null;
    const ids = new Set(records.map(record => record.permit.donationId)), donations = ledger.donations.filter(item => ids.has(item.id));
    const reorgedCount = records.filter(record => row(record, ledger).status === "REORGED").length;
    const totals = { preparedCount: records.length - donations.length - reorgedCount, recordedCount: donations.length, reorgedCount };
    for (const key of ["amountWei", ...balanceFields]) {
      totals[key === "amountWei" ? "donatedWei" : key] = donations.reduce((total, item) => total + BigInt(item[key]), 0n).toString();
    }
    totals.balanceWei = (BigInt(totals.donatedWei) - BigInt(totals.spentWei) - BigInt(totals.refundedWei)).toString();
    return totals;
  }
  function detail(record, ledger) {
    const result = row(record, ledger), donation = ledger?.donations.find(item => item.id === result.id);
    const activity = [];
    if (donation) for (const event of ledger.canonicalEvents) {
      const data = event.data;
      const contract = ledger.contracts.find(item => item.id === data.contractId && item.sources.some(source => source.donationId === result.id));
      const payment = ledger.payments.find(item => item.id === data.paymentId && item.sources.some(source => source.donationId === result.id));
      const contractEvent = ["ContractLocked", "ContractClosed"].includes(event.type) && contract;
      const taskClosed = event.type === "TaskClosed" && ledger.allocations.some(item => item.taskId === data.taskId && item.donationId === result.id);
      if (data.donationId !== result.id && !contractEvent && !payment && !taskClosed) continue;
      // Batch events carry the whole batch amount. Show only this donor's FIFO
      // contribution, not the amount funded by everyone in that same payment.
      const sourceAmount = payment?.sources.find(source => source.donationId === result.id)?.amountWei ??
        (event.type === "ContractLocked" ? contract?.sources.find(source => source.donationId === result.id)?.amountWei : undefined);
      activity.push({ type: event.type, txHash: event.txHash, blockNumber: event.blockNumber, logIndex: event.logIndex,
        taskId: data.taskId ?? payment?.taskId ?? contract?.taskId ?? null, contractId: data.contractId ?? payment?.contractId ?? null,
        batchId: data.batchId ?? null, amountWei: sourceAmount ?? data.amountWei ?? null });
    }
    return { ...result, profile: { ...record.profile }, registrationHash: record.registrationHash, chainId, poolAddress,
      orphanedReceipts: ledger ? ledger.orphanedDonations.filter(item => item.id === result.id)
        .map(item => ({ txHash: item.txHash, blockNumber: item.blockNumber, blockHash: item.blockHash })) : [],
      activity,
      balances: donation ? Object.fromEntries(balanceFields.map(key => [key, donation[key]])) : null,
      allocations: donation ? ledger.allocations.filter(item => item.donationId === result.id)
        .map(item => ({ taskId: item.taskId, availableWei: item.availableWei })) : [],
      contracts: donation ? ledger.contracts.flatMap(item => item.sources.filter(source => source.donationId === result.id)
        .map(source => ({ contractId: item.id, taskId: item.taskId, amountWei: source.amountWei, remainingWei: source.remainingWei, txHash: item.txHash }))) : [],
      payments: donation ? ledger.payments.flatMap(item => item.sources.filter(source => source.donationId === result.id)
        .map(source => ({ paymentId: item.id, batchId: item.batchId, taskId: item.taskId, contractId: item.contractId,
          amountWei: source.amountWei, txHash: item.txHash }))) : [],
      refunds: donation ? ledger.refunds.filter(item => item.donationId === result.id)
        .map(item => ({ refundId: item.id, amountWei: item.amountWei, txHash: item.txHash })) : [] };
  }
  async function handle(req, res, p) {
    if (!p.startsWith("/v1/funding/")) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie, X-Relief-Actor");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (p === "/v1/funding/pool") {
        accounts.assertOrigin(req);
        if (req.method !== "GET") fail(405, "METHOD_NOT_ALLOWED", "仅支持读取资金池汇总");
        if (new URL(req.url, "http://localhost").search) fail(400, "INVALID_FUNDING_QUERY", "资金池汇总不接受筛选参数");
        const { records, ledger } = snapshot();
        const totals = summary(records, ledger);
        const publicSummary = totals ? Object.fromEntries(["donatedWei", ...balanceFields, "balanceWei"].map(key => [key, totals[key]])) : null;
        if (publicSummary) publicSummary.donorCount = new Set(ledger.donations.map(item => item.donorUserId)).size;
        respond(res, 200, { data: { connection: connection(), projectionVersion: ledger?.storeVersion ?? null, summary: publicSummary } });
        return true;
      }
      if (p === "/v1/funding/admin/indexer") {
        accounts.assertOrigin(req);
        if (!isAdmin(req)) fail(401, "ADMIN_AUTH_REQUIRED", "请先验证管理权限");
        if (req.method !== "GET") fail(405, "METHOD_NOT_ALLOWED", "仅支持读取索引状态");
        if (new URL(req.url, "http://localhost").search) fail(400, "INVALID_FUNDING_QUERY", "索引状态不接受查询参数");
        respond(res, 200, { data: { connection: connection(), indexer: getIndexerStatus ? getIndexerStatus() : null } }); return true;
      }
      const match = /^\/v1\/funding\/(admin|me)\/donations(?:\/([^/]+))?$/.exec(p);
      if (!match) fail(404, "NOT_FOUND", "接口不存在");
      accounts.assertOrigin(req);
      let ownerId = null;
      if (match[1] === "admin") {
        if (!isAdmin(req)) fail(401, "ADMIN_AUTH_REQUIRED", "请先验证管理权限");
      } else ownerId = accounts.requireUser(req).id;
      if (req.method !== "GET") fail(405, "METHOD_NOT_ALLOWED", "仅支持读取捐赠记录");
      const query = queryParams(req);
      if (match[2] && !/^0x[0-9a-f]{64}$/i.test(match[2])) fail(400, "INVALID_DONATION_ID", "捐赠编号无效");
      let state;
      try { state = snapshot(ownerId); }
      catch (_) { fail(503, "FUNDING_RECORDS_UNAVAILABLE", "账本或历史身份记录未通过完整性核验，请联系管理员检查存储"); }
      const { records, ledger } = state;
      if (match[2]) {
        const record = records.find(item => item.permit.donationId === match[2].toLowerCase());
        if (!record) fail(404, "DONATION_NOT_FOUND", "捐赠记录不存在或无权查看");
        respond(res, 200, { data: { ...detail(record, ledger), connection: connection(), accountSummary: ownerId ? summary(records, ledger) : null } }); return true;
      }
      const rows = records.map(record => row(record, ledger))
        .filter(item => (query.status === "all" || item.status === query.status) &&
          (query.purpose === "all" || item.purpose === Number(query.purpose)) && (!query.q || item.id.startsWith(query.q)))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      respond(res, 200, { data: { connection: connection(), projectionVersion: ledger?.storeVersion ?? null, summary: summary(records, ledger),
        items: rows.slice(query.offset, query.offset + query.limit), pagination: { offset: query.offset, limit: query.limit, total: rows.length } } });
    } catch (error) {
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
      respond(res, known ? error.status : 503, { data: null, error: {
        code: known ? error.code : "FUNDING_RECORDS_UNAVAILABLE", message: known ? error.message : "暂时无法读取捐赠记录" } });
    }
    return true;
  }
  return { handle };
}

module.exports = { createFundingReadService };
