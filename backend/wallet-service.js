const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Interface, JsonRpcProvider, FetchRequest, getAddress, isAddress, id: taskHash, parseEther, formatEther, toQuantity, Contract } = require("ethers");
const { createAccounts } = require("./wallet-accounts");

const ABI = [
  "function donate(bytes32 donationId,uint8 purpose) payable",
  "function configureTask(bytes32 taskId,uint8 purpose,uint8 urgency,uint256 targetWei,address recipient,bool active)",
  "function releaseTask(bytes32 taskId,uint256 amountWei)",
  "function allocateRemaining(bytes32 donationId)",
  "function refundUnallocated(bytes32 donationId)",
  "function owner() view returns(address)",
  "function getTasks() view returns(tuple(bytes32 id,uint8 purpose,uint8 urgency,uint256 targetWei,uint256 allocatedWei,uint256 releasedWei,address recipient,bool active)[])",
  "event DonationReceived(bytes32 indexed donationId,address indexed donor,uint8 purpose,uint256 amountWei)",
  "event DonationAllocated(bytes32 indexed donationId,bytes32 indexed taskId,uint256 amountWei)",
  "event DonationUnallocated(bytes32 indexed donationId,uint256 amountWei)",
  "event DonationRefunded(bytes32 indexed donationId,address indexed donor,uint256 amountWei)",
  "event TaskReleased(bytes32 indexed taskId,address indexed recipient,uint256 amountWei)"
];
const iface = new Interface(ABI);
const PURPOSES = ["不限用途", "饮水食品", "医疗物资", "安置装备", "救援服务", "灾后重建"].map((label, id) => ({ id, label }));
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const time = () => new Date().toISOString();
const lower = value => String(value || "").toLowerCase();
const hexHash = value => /^0x[0-9a-fA-F]{64}$/.test(value);
const sumWei = values => values.reduce((sum, value) => sum + BigInt(value || "0"), 0n);
const sameDonation = (a, b) => lower(a.id) === lower(b.id) && lower(a.wallet) === lower(b.wallet) && a.amountWei === b.amountWei && a.purpose === b.purpose;

function amountWei(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})(\.\d{1,18})?$/.test(value)) fail(400, "INVALID_AMOUNT", "MON 金额需为正数，最多 18 位小数");
  const amount = parseEther(value);
  if (amount <= 0n) fail(400, "INVALID_AMOUNT", "MON 金额必须大于 0");
  return amount;
}

function planAllocation(amount, purpose, tasks) {
  let remaining = BigInt(amount);
  const allocations = [];
  tasks.map((task, index) => ({ ...task, index })).filter(task => task.active && (purpose === 0 || Number(task.purpose) === purpose))
    .sort((a, b) => Number(b.urgency) - Number(a.urgency) || a.index - b.index).forEach(task => {
      const capacity = BigInt(task.targetWei) - BigInt(task.allocatedWei);
      const value = capacity < remaining ? capacity : remaining;
      if (value > 0n) { allocations.push({ taskId: task.id, amountWei: value.toString(), amountMon: formatEther(value) }); remaining -= value; }
    });
  return { allocations, unallocatedWei: remaining.toString(), unallocatedMon: formatEther(remaining) };
}

function createWalletService({ dataDir, origin, send, readBody, getBusinessTasks = () => [], options = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "wallet-ledger.json");
  const rpcUrl = options.rpcUrl || process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
  const walletRpcUrl = options.walletRpcUrl || process.env.MONAD_WALLET_RPC_URL || "https://testnet-rpc.monad.xyz";
  const chainId = 10143;
  const confirmations = Math.max(2, Number(options.confirmations || process.env.MONAD_CONFIRMATIONS || 2));
  if (!Number.isSafeInteger(confirmations)) throw new Error("MONAD_CONFIRMATIONS must be an integer");
  const rpcRequest = new FetchRequest(rpcUrl);
  rpcRequest.timeout = 8000;
  const provider = new JsonRpcProvider(rpcRequest, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  const accounts = createAccounts({ dataDir, origin, chainId, send, readBody, isAdminSession: options.isAdminSession });
  const blank = () => ({ config: null, intents: [], events: [], checkpoints: [], through: null, chainTasks: [], version: 0, lastSyncedAt: null });
  let db;
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; db = blank(); }
  if (process.env.MONAD_POOL_ADDRESS) {
    if (!isAddress(process.env.MONAD_POOL_ADDRESS)) throw new Error("MONAD_POOL_ADDRESS is invalid");
    const address = getAddress(process.env.MONAD_POOL_ADDRESS);
    if (db.config && lower(db.config.address) !== lower(address)) throw new Error("Configured pool differs from persisted ledger; use a separate DATA_DIR");
    if (!db.config) {
      const startBlock = Number(process.env.MONAD_START_BLOCK);
      if (process.env.MONAD_START_BLOCK === undefined || !Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error("MONAD_START_BLOCK must be the deployment block");
      db.config = { address, startBlock, chainId };
    }
  }
  let syncStatus = db.config ? "CONNECTING" : "NOT_DEPLOYED";
  let syncError = "";
  let syncedAt = null;
  let verified = false;
  let busy = false;
  let pendingCursor = 0;
  let closing = false;
  const idleWaiters = [];
  let queue = Promise.resolve();
  const clients = new Set();
  let timer;
  function artifact() { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "../web/shared/contracts/ReliefPool.json"), "utf8")); }
  function broadcast() {
    for (const client of clients) {
      if (client.destroyed || client.writableLength > 65536) { client.end(); clients.delete(client); continue; }
      client.write(`event: change\ndata: ${JSON.stringify({ version: db.version })}\n\n`);
    }
  }
  function mutate(fn) {
    const action = queue.then(() => {
      const next = structuredClone(db);
      const result = fn(next);
      next.version++;
      fs.writeFileSync(file + ".tmp", JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
      db = next;
      broadcast();
      return result;
    });
    queue = action.catch(() => {});
    return action;
  }
  function config() {
    const ready = !!db.config && verified && syncStatus === "SYNCED" && syncedAt && Date.now() - syncedAt < 20000;
    return { chainId, chainHex: toQuantity(chainId), chainName: "Monad Testnet", rpcUrl: walletRpcUrl,
      explorerUrl: "https://testnet.monadexplorer.com", contractAddress: db.config?.address || null,
      ready: !!ready, newOperationsEnabled: options.newOperationsEnabled !== false,
      operationBlockReason: options.newOperationsEnabled === false ? "新版资金流程和 Gas 政策未就绪，暂停新捐赠及原型合约部署" : "",
      confirmations, purposes: PURPOSES, reason: !db.config ? "尚未部署资金池合约" : syncError || (ready ? "" : "正在同步链上资金池") };
  }
  function taskInfo(taskId) {
    const task = getBusinessTasks().find(task => lower(taskHash(task.id)) === lower(taskId));
    return { businessId: task?.id || null, title: task?.title || task?.location || taskId };
  }
  function buildLedger() {
    const map = new Map();
    for (const event of db.events) {
      if (event.name !== "DonationReceived") continue;
      const intent = db.intents.find(intent => lower(intent.id) === lower(event.donationId) && lower(intent.wallet) === lower(event.donor) && intent.amountWei === event.amountWei && intent.purpose === event.purpose);
      map.set(lower(event.donationId), { id: event.donationId, wallet: event.donor, amountWei: event.amountWei, purpose: event.purpose,
        status: "CONFIRMED", txHash: event.txHash, blockNumber: event.blockNumber, blockHash: event.blockHash,
        donorUserId: intent?.userId || null, donor: intent?.donor || null, createdAt: intent?.createdAt || null,
        allocations: [], refundedWei: "0" });
    }
    for (const event of db.events) {
      const donation = map.get(lower(event.donationId));
      if (!donation) continue;
      if (event.name === "DonationAllocated") donation.allocations.push({ taskId: event.taskId, amountWei: event.amountWei, txHash: event.txHash, logIndex: event.logIndex, ...taskInfo(event.taskId) });
      if (event.name === "DonationRefunded") donation.refundedWei = (BigInt(donation.refundedWei) + BigInt(event.amountWei)).toString();
    }
    return Array.from(map.values()).map(donation => {
      const allocatedWei = sumWei(donation.allocations.map(a => a.amountWei));
      const unallocatedWei = BigInt(donation.amountWei) - allocatedWei - BigInt(donation.refundedWei);
      if (unallocatedWei < 0n) fail(503, "LEDGER_MISMATCH", "链上分配金额异常，暂停记账");
      return { ...donation, amountMon: formatEther(donation.amountWei), allocatedMon: formatEther(allocatedWei), unallocatedMon: formatEther(unallocatedWei), refundedMon: formatEther(donation.refundedWei),
        allocations: donation.allocations.map(a => ({ ...a, amountMon: formatEther(a.amountWei) })) };
    });
  }
  function dashboard() {
    const ledger = buildLedger();
    const donated = sumWei(ledger.map(d => d.amountWei));
    const allocated = sumWei(ledger.flatMap(d => d.allocations.map(a => a.amountWei)));
    const refunded = sumWei(ledger.map(d => d.refundedWei));
    const released = sumWei(db.events.filter(e => e.name === "TaskReleased").map(e => e.amountWei));
    const tasks = db.chainTasks.map(task => ({ ...task, ...taskInfo(task.id), targetMon: formatEther(task.targetWei), allocatedMon: formatEther(task.allocatedWei), releasedMon: formatEther(task.releasedWei), remainingMon: formatEther(BigInt(task.targetWei) - BigInt(task.allocatedWei)) }));
    return { ...config(), syncStatus, lastSyncedAt: db.lastSyncedAt, confirmedBlock: db.through,
      totals: { donatedMon: formatEther(donated), allocatedMon: formatEther(allocated), unallocatedMon: formatEther(donated - allocated - refunded), balanceMon: formatEther(donated - refunded - released), releasedMon: formatEther(released), refundedMon: formatEther(refunded), donorCount: new Set(ledger.map(d => lower(d.wallet))).size },
      tasks, recentDonations: ledger.slice(-30).reverse().map(({ donor, donorUserId, ...publicDonation }) => publicDonation) };
  }
  function allDonations() {
    const ledger = buildLedger();
    return ledger.concat(db.intents.filter(intent => !ledger.some(d => sameDonation(d, intent))).map(intent => ({ ...intent, donorUserId: intent.userId, amountMon: formatEther(intent.amountWei), allocatedMon: "0", unallocatedMon: "0", allocations: [] })))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }
  function ownData(req) {
    const user = accounts.user(req);
    const donations = user ? allDonations().filter(d => d.donorUserId === user.id).map(({ donor, requestKey, requestHash, userId, ...d }) => d) : [];
    const confirmed = donations.filter(d => d.status === "CONFIRMED");
    return { user, donations, totals: {
      donatedMon: formatEther(sumWei(confirmed.map(d => d.amountWei))),
      allocatedMon: formatEther(sumWei(confirmed.flatMap(d => d.allocations.map(a => a.amountWei)))),
      unallocatedMon: formatEther(sumWei(confirmed.map(d => parseEther(d.unallocatedMon).toString())))
    } };
  }
  async function checkNetwork() {
    if (Number(await provider.send("eth_chainId", [])) !== chainId) fail(503, "WRONG_RPC_NETWORK", "RPC 不是 Monad 测试网（10143）");
  }
  async function checkCode(address) {
    const code = await provider.getCode(address);
    if (lower(code) !== lower(artifact().deployedBytecode)) fail(409, "WRONG_CONTRACT", "合约字节码与本项目资金池不匹配");
  }
  function parseLog(log) {
    let parsed;
    try { parsed = iface.parseLog(log); } catch (_) { return null; }
    if (!parsed) return null;
    const item = { name: parsed.name, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, blockHash: log.blockHash };
    for (const input of parsed.fragment.inputs) {
      const value = parsed.args[input.name];
      item[input.name] = typeof value === "bigint" ? input.name === "purpose" ? Number(value) : value.toString() : value;
    }
    return item;
  }
  async function inspectPending() {
    const ledger = buildLedger();
    const candidates = db.intents.filter(d => d.txHash && !["FAILED", "CONFIRMED"].includes(d.status));
    if (!candidates.length) { pendingCursor = 0; return; }
    pendingCursor %= candidates.length;
    const start = pendingCursor;
    const batch = Array.from({ length: Math.min(50, candidates.length) }, (_, index) => candidates[(start + index) % candidates.length]);
    const deadline = Date.now() + 1500;
    for (const pending of batch) {
      if (Date.now() > deadline) break;
      pendingCursor = (pendingCursor + 1) % candidates.length;
      const confirmed = ledger.find(d => sameDonation(d, pending));
      if (confirmed) continue;
      const tx = await provider.getTransaction(pending.txHash);
      if (!tx) continue;
      const valid = lower(tx.from) === lower(pending.wallet) && lower(tx.to) === lower(db.config.address) && tx.value.toString() === pending.amountWei
        && lower(tx.data) === lower(iface.encodeFunctionData("donate", [pending.id, pending.purpose])) && Number(tx.chainId) === chainId;
      const receipt = valid ? await provider.getTransactionReceipt(pending.txHash) : null;
      const status = !valid || receipt?.status === 0 ? "FAILED" : receipt ? "CONFIRMING" : "SUBMITTED";
      if (pending.status !== status) await mutate(next => {
        const intent = next.intents.find(d => d.id === pending.id);
        if (intent) { intent.status = status; intent.failureReason = !valid ? "交易的钱包、合约、金额或用途与登记不一致" : receipt?.status === 0 ? "链上执行失败" : null; }
      });
    }
  }
  async function resetChain() {
    verified = false;
    await mutate(next => {
      next.events = []; next.checkpoints = []; next.through = null; next.chainTasks = []; next.lastSyncedAt = null;
      next.intents.forEach(intent => { if (intent.status === "CONFIRMED") intent.status = "REORGED"; });
    });
  }
  async function sync() {
    if (busy || closing || !db.config) return;
    busy = true;
    const previousStatus = syncStatus;
    try {
      await checkNetwork();
      if (!verified) { await checkCode(db.config.address); verified = true; }
      const latest = await provider.getBlockNumber();
      const finalBlock = latest - confirmations + 1;
      if (db.through !== null) {
        const last = db.checkpoints.at(-1);
        const block = last && await provider.getBlock(last.number);
        if (!block || lower(block.hash) !== lower(last.hash)) {
          await resetChain();
          syncStatus = "REINDEXING";
        }
      }
      let from = (db.through ?? (db.config.startBlock - 1)) + 1;
      for (let batch = 0; from <= finalBlock && batch < 10; batch++) {
        const to = Math.min(from + 99, finalBlock);
        const previousAnchor = db.checkpoints.at(-1);
        const checkpoint = await provider.getBlock(to);
        if (!checkpoint) throw new Error("确认区块暂不可用");
        const logs = await provider.getLogs({ address: db.config.address, fromBlock: from, toBlock: to });
        const logBlocks = new Map();
        for (const log of logs) {
          if (!logBlocks.has(log.blockNumber)) logBlocks.set(log.blockNumber, await provider.getBlock(log.blockNumber));
          if (log.removed || log.blockNumber < from || log.blockNumber > to || lower(log.address) !== lower(db.config.address) || lower(logBlocks.get(log.blockNumber)?.hash) !== lower(log.blockHash)) {
            await resetChain(); throw new Error("日志不属于当前确认链，重新索引");
          }
        }
        const entries = logs.map(parseLog).filter(Boolean);
        const chainTasks = (await new Contract(db.config.address, ABI, provider).getTasks({ blockTag: to })).map(task => ({ id: task.id, purpose: Number(task.purpose), urgency: Number(task.urgency), targetWei: task.targetWei.toString(), allocatedWei: task.allocatedWei.toString(), releasedWei: task.releasedWei.toString(), recipient: task.recipient, active: task.active }));
        const canonical = await provider.getBlock(to);
        const previousCanonical = previousAnchor && await provider.getBlock(previousAnchor.number);
        if (!canonical || canonical.hash !== checkpoint.hash || (previousAnchor && lower(previousCanonical?.hash) !== lower(previousAnchor.hash))) { await resetChain(); throw new Error("区块发生重组，等待重试"); }
        await mutate(next => {
          const seen = new Set(next.events.map(event => `${event.txHash}:${event.logIndex}`));
          next.events.push(...entries.filter(event => !seen.has(`${event.txHash}:${event.logIndex}`)));
          next.through = to; next.checkpoints = [{ number: to, hash: checkpoint.hash }]; next.chainTasks = chainTasks; next.lastSyncedAt = time();
          for (const event of entries.filter(e => e.name === "DonationReceived")) {
            const intent = next.intents.find(d => lower(d.id) === lower(event.donationId));
            if (!intent) continue;
            if (lower(intent.wallet) === lower(event.donor) && intent.amountWei === event.amountWei && intent.purpose === event.purpose) { intent.status = "CONFIRMED"; intent.txHash = event.txHash; intent.confirmedAt = time(); }
            else { intent.status = "FAILED"; intent.failureReason = "相同捐赠编号的链上交易与登记的钱包、金额或用途不一致"; }
          }
        });
        from = to + 1;
      }
      await inspectPending();
      syncStatus = from <= finalBlock ? "SYNCING" : "SYNCED";
      syncedAt = Date.now(); syncError = "";
    } catch (error) { syncStatus = "RPC_ERROR"; syncError = error.code === "WRONG_CONTRACT" ? error.message : "链上同步暂不可用，已保留上次确认的记录"; }
    finally { busy = false; if (previousStatus !== syncStatus) broadcast(); idleWaiters.splice(0).forEach(resolve => resolve()); }
  }
  function requireAdmin(req) { if (!accounts.isAdmin(req)) fail(403, "ADMIN_AUTH_REQUIRED", "请输入后台管理员访问令牌"); }
  function requireReady() { if (!config().ready) fail(503, "POOL_NOT_READY", config().reason); }
  function requireNewOperations() { if (!config().newOperationsEnabled) fail(503, "WORKFLOW_NOT_READY", config().operationBlockReason); }
  function requestKey(req) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 160) fail(400, "IDEMPOTENCY_REQUIRED", "请求必须包含有效 Idempotency-Key");
    return key;
  }
  function publicIntent(intent) {
    return { id: intent.id, status: intent.status, transaction: { from: intent.wallet, to: db.config.address, value: toQuantity(BigInt(intent.amountWei)), data: iface.encodeFunctionData("donate", [intent.id, intent.purpose]), chainId: toQuantity(chainId) },
      allocations: intent.preview.allocations.map(a => ({ ...a, ...taskInfo(a.taskId) })), unallocatedMon: intent.preview.unallocatedMon };
  }
  async function route(req, res, p) {
    if (!p.startsWith("/v1/wallet/")) return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method === "POST") accounts.assertOrigin(req);
      if (await accounts.handle(req, res, p)) return true;
      if (req.method === "GET" && p === "/v1/wallet/config") send(res, 200, { data: config() });
      else if (req.method === "GET" && p === "/v1/wallet/me") send(res, 200, { data: ownData(req) });
      else if (req.method === "GET" && p === "/v1/wallet/dashboard") send(res, 200, { data: dashboard() });
      else if (req.method === "GET" && p === "/v1/wallet/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        clients.add(res); res.write(`event: change\ndata: ${JSON.stringify({ version: db.version })}\n\n`);
        const ping = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 15000); ping.unref();
        req.on("close", () => { clients.delete(res); clearInterval(ping); });
      }
      else if (req.method === "POST" && p === "/v1/wallet/donations/prepare") {
        const user = accounts.requireUser(req); requireNewOperations(); requireReady();
        if (!user.wallet) fail(409, "WALLET_REQUIRED", "请先签名绑定 MetaMask 钱包");
        const body = await readBody(req); const amount = amountWei(body.amountMon); const purpose = body.purpose;
        if (!Number.isInteger(purpose) || purpose < 0 || purpose > 5) fail(400, "INVALID_PURPOSE", "请选择有效捐赠用途");
        const key = requestKey(req); const digest = crypto.createHash("sha256").update(JSON.stringify([user.wallet, amount.toString(), purpose])).digest("hex");
        const result = await mutate(next => {
          const previous = next.intents.find(intent => intent.userId === user.id && intent.requestKey === key);
          if (previous) { if (previous.requestHash !== digest) fail(409, "IDEMPOTENCY_CONFLICT", "相同请求键不能更改金额或用途"); return previous; }
          if (next.intents.filter(intent => intent.userId === user.id && ["AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMING"].includes(intent.status)).length >= 50) fail(429, "TOO_MANY_INTENTS", "未完成的捐赠登记过多");
          const intent = { id: "0x" + crypto.randomBytes(32).toString("hex"), userId: user.id, donor: structuredClone(user), wallet: user.wallet, amountWei: amount.toString(), purpose,
            status: "AWAITING_SIGNATURE", requestKey: key, requestHash: digest, createdAt: time(), txHash: null, preview: planAllocation(amount, purpose, db.chainTasks) };
          next.intents.push(intent); return intent;
        });
        send(res, 201, { data: publicIntent(result) });
      }
      else if (req.method === "POST" && p === "/v1/wallet/donations/submit") {
        const user = accounts.requireUser(req); requestKey(req);
        const body = await readBody(req);
        if (!hexHash(body.txHash) || !hexHash(body.id)) fail(400, "INVALID_HASH", "交易哈希或捐赠编号无效");
        const result = await mutate(next => {
          const intent = next.intents.find(d => d.id === body.id && d.userId === user.id);
          if (!intent) fail(404, "NOT_FOUND", "捐赠记录不存在");
          if (intent.txHash && lower(intent.txHash) !== lower(body.txHash)) fail(409, "HASH_CONFLICT", "该捐赠已关联交易，等待链上索引结果");
          // A hash is only an untrusted claim until the transaction and its event are verified.
          intent.txHash = body.txHash; if (intent.status === "AWAITING_SIGNATURE") intent.status = "SUBMITTED";
          return { id: intent.id, status: intent.status, txHash: intent.txHash };
        });
        send(res, 202, { data: result }); void sync();
      }
      else if (req.method === "POST" && p === "/v1/wallet/donations/reallocate") {
        const user = accounts.requireUser(req); requireReady(); const body = await readBody(req);
        const donation = buildLedger().find(d => d.id === body.id && d.donorUserId === user.id);
        if (!donation || parseEther(donation.unallocatedMon) === 0n) fail(409, "NO_REMAINDER", "暂无可继续分配余额");
        send(res, 200, { data: { transaction: { from: user.wallet, to: db.config.address, value: "0x0", data: iface.encodeFunctionData("allocateRemaining", [donation.id]), chainId: toQuantity(chainId) } } });
      }
      else if (req.method === "POST" && p === "/v1/wallet/donations/refund") {
        const user = accounts.requireUser(req); requireReady(); const body = await readBody(req);
        const donation = buildLedger().find(d => d.id === body.id && d.donorUserId === user.id && lower(d.wallet) === lower(user.wallet));
        if (!donation || parseEther(donation.unallocatedMon) === 0n) fail(409, "NO_REMAINDER", "暂无可退回的未分配余额");
        send(res, 200, { data: { transaction: { from: user.wallet, to: db.config.address, value: "0x0", data: iface.encodeFunctionData("refundUnallocated", [donation.id]), chainId: toQuantity(chainId) } } });
      }
      else if (p.startsWith("/v1/wallet/admin/")) {
        requireAdmin(req);
        if (req.method === "GET" && p === "/v1/wallet/admin/overview") {
          const donations = allDonations().map(({ requestKey, requestHash, preview, ...d }) => d);
          send(res, 200, { data: { ...dashboard(), donations, businessTasks: getBusinessTasks().filter(t => t.verificationStatus === "VERIFIED").map(t => ({ id: t.id, taskId: taskHash(t.id), title: t.title || t.location, urgency: t.severity === "critical" ? 3 : t.severity === "high" ? 2 : 1 })) } });
        }
        else if (req.method === "POST" && p === "/v1/wallet/admin/deploy-prepare") {
          requireNewOperations();
          if (db.config) fail(409, "ALREADY_CONFIGURED", "资金池合约已配置");
          const body = await readBody(req); if (!isAddress(body.owner)) fail(400, "INVALID_ADDRESS", "管理员钱包地址无效");
          await checkNetwork();
          const artifactData = artifact();
          const constructor = new Interface(artifactData.abi).encodeDeploy([getAddress(body.owner)]);
          send(res, 200, { data: { transaction: { from: getAddress(body.owner), data: artifactData.bytecode + constructor.slice(2), value: "0x0", chainId: toQuantity(chainId) } } });
        }
        else if (req.method === "POST" && p === "/v1/wallet/admin/deploy-confirm") {
          const body = await readBody(req); if (!hexHash(body.txHash)) fail(400, "INVALID_HASH", "部署交易哈希无效");
          await checkNetwork();
          const receipt = await provider.getTransactionReceipt(body.txHash);
          if (!receipt) fail(409, "DEPLOYMENT_PENDING", "合约部署交易尚未出块");
          if (receipt.status !== 1 || !receipt.contractAddress) fail(409, "DEPLOYMENT_FAILED", "交易未成功部署合约");
          if (await provider.getBlockNumber() - receipt.blockNumber + 1 < confirmations) fail(409, "DEPLOYMENT_PENDING", "部署交易仍等待确认");
          const tx = await provider.getTransaction(body.txHash); const art = artifact();
          const expected = art.bytecode + new Interface(art.abi).encodeDeploy([tx.from]).slice(2);
          if (tx.to !== null || lower(tx.data) !== lower(expected)) fail(409, "WRONG_DEPLOYMENT", "部署交易内容与资金池合约不匹配");
          await checkCode(receipt.contractAddress);
          await mutate(next => {
            if (next.config && lower(next.config.address) !== lower(receipt.contractAddress)) fail(409, "POOL_EXISTS", "不能替换已有资金池账本");
            next.config = { address: getAddress(receipt.contractAddress), startBlock: receipt.blockNumber, chainId };
          });
          verified = false; await sync(); send(res, 200, { data: config() });
        }
        else if (req.method === "POST" && p === "/v1/wallet/admin/task-prepare") {
          requireNewOperations();
          requireReady(); const body = await readBody(req); const task = getBusinessTasks().find(t => t.id === body.businessId && t.verificationStatus === "VERIFIED");
          if (!task) fail(404, "TASK_NOT_FOUND", "请选择已核验的救援任务");
          if (!isAddress(body.owner) || !isAddress(body.recipient) || lower(body.recipient) === "0x0000000000000000000000000000000000000000") fail(400, "INVALID_ADDRESS", "任务收款钱包无效");
          if (!Number.isInteger(body.purpose) || body.purpose < 1 || body.purpose > 5 || !Number.isInteger(body.urgency) || body.urgency < 1 || body.urgency > 3) fail(400, "INVALID_TASK", "用途或紧急程度无效");
          const owner = await new Contract(db.config.address, ABI, provider).owner();
          if (lower(owner) !== lower(body.owner)) fail(403, "NOT_POOL_OWNER", "当前钱包不是资金池合约管理员");
          const data = iface.encodeFunctionData("configureTask", [taskHash(task.id), body.purpose, body.urgency, amountWei(body.targetMon), getAddress(body.recipient), body.active !== false]);
          send(res, 200, { data: { transaction: { from: getAddress(body.owner), to: db.config.address, data, value: "0x0", chainId: toQuantity(chainId) }, taskId: taskHash(task.id) } });
        }
        else if (req.method === "POST" && p === "/v1/wallet/admin/task-release-prepare") {
          requireNewOperations();
          requireReady();
          const body = await readBody(req);
          if (!isAddress(body.owner)) fail(400, "INVALID_ADDRESS", "管理员钱包地址无效");
          const taskId = body.taskId;
          if (!hexHash(taskId)) fail(400, "INVALID_TASK", "任务编号必须是 32 字节哈希");
          const amount = amountWei(body.amountMon);
          if (amount <= 0n) fail(400, "INVALID_AMOUNT", "释放金额必须大于 0");
          const owner = await new Contract(db.config.address, ABI, provider).owner();
          if (lower(owner) !== lower(body.owner)) fail(403, "NOT_POOL_OWNER", "当前钱包不是资金池合约管理员");
          const chainTask = (await new Contract(db.config.address, ABI, provider).getTasks()).find(task => lower(task.id) === lower(taskId));
          if (!chainTask) fail(404, "TASK_NOT_FOUND", "链上救援任务不存在");
          const available = BigInt(chainTask.allocatedWei) - BigInt(chainTask.releasedWei);
          if (available <= 0n || amount > available) fail(409, "INSUFFICIENT_TASK_BALANCE", "任务没有足够的可释放余额");
          const data = iface.encodeFunctionData("releaseTask", [taskId, amount]);
          send(res, 200, { data: { transaction: { from: getAddress(body.owner), to: db.config.address, data, value: "0x0", chainId: toQuantity(chainId) }, taskId, amountWei: amount.toString() } });
        }
        else fail(404, "NOT_FOUND", "钱包管理接口不存在");
      }
      else fail(404, "NOT_FOUND", "钱包接口不存在");
    } catch (error) { if (!res.headersSent) send(res, error.status || 503, { error: { code: error.code || "WALLET_SERVICE_ERROR", message: error.status ? error.message : "服务暂不可用，请稍后重试" } }); }
    return true;
  }
  function start() { if (!timer) { timer = setInterval(() => void sync(), options.pollInterval || 2000); timer.unref(); void sync(); } }
  async function close() { closing = true; clearInterval(timer); for (const res of clients) res.end(); if (busy) await new Promise(resolve => idleWaiters.push(resolve)); await queue; provider.destroy(); }
  return { route, accounts, dashboard, config, start, sync, close, adminTokenPath: accounts.adminTokenPath };
}

module.exports = { createWalletService, planAllocation, amountWei, ABI };
