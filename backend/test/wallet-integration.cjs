'use strict';

// Isolated HTTP + EVM integration. No public RPC, timers, or persisted signer keys.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const ganache = require('ganache');
const { JsonRpcProvider, Wallet, Contract, Interface, id, parseEther, formatEther } = require('ethers');
const { createWalletService } = require('../wallet-service');
const artifact = require('../../web/shared/contracts/ReliefPool.json');
const iface = new Interface(artifact.abi);
const mon = parseEther;
const prefix = '/v1/wallet/';
const businessTasks = [
  ['low', 1, 1, '5'], ['wrong-purpose', 2, 3, '5'],
  ['high-first', 1, 3, '0.3'], ['high-second', 1, 3, '0.4'],
  ['middle', 1, 2, '0.5'], ['inactive', 1, 3, '5'],
].map(([name, purpose, urgency, target]) => ({
  id: name, title: `Relief ${name}`, verificationStatus: 'VERIFIED',
  severity: urgency === 3 ? 'critical' : urgency === 2 ? 'high' : 'normal', purpose, urgency, target,
}));

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relief-wallet-integration-'));
  const previousEnv = new Map(['RELIEF_ADMIN_TOKEN', 'MONAD_POOL_ADDRESS', 'MONAD_START_BLOCK']
    .map((name) => [name, process.env[name]]));
  const adminToken = crypto.randomBytes(48).toString('hex');
  process.env.RELIEF_ADMIN_TOKEN = adminToken;
  delete process.env.MONAD_POOL_ADDRESS;
  delete process.env.MONAD_START_BLOCK;
  let service;
  let provider;
  let app;
  const rpc = ganache.server({
    chain: { chainId: 10143, hardfork: 'merge' },
    wallet: { totalAccounts: 6, defaultBalance: 1000 }, logging: { quiet: true },
  });
  t.after(async () => {
    try {
      if (app?.listening) {
        app.closeAllConnections();
        await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
      }
      if (service) await service.close();
      if (provider) provider.destroy();
      await rpc.close();
    } finally {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      const resolved = path.resolve(dataDir);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('relief-wallet-integration-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  await rpc.listen(0, '127.0.0.1');
  const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
  provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 20;
  const [owner, donor, other, recipient] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const localAccounts = rpc.provider.getInitialAccounts();
  const signingWallet = new Wallet(localAccounts[donor.address.toLowerCase()].secretKey);
  const otherSigningWallet = new Wallet(localAccounts[other.address.toLowerCase()].secretKey);
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  async function readBody(req) {
    let body = '';
    for await (const chunk of req) body += chunk;
    return JSON.parse(body || '{}');
  }
  app = http.createServer(async (req, res) => {
    try {
      if (!await service.route(req, res, new URL(req.url, 'http://localhost').pathname)) {
        send(res, 404, { error: { code: 'NOT_FOUND' } });
      }
    } catch (error) {
      send(res, 500, { error: { code: 'TEST_HTTP_ERROR', message: error.message } });
    }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  function createService() {
    return createWalletService({ dataDir, origin, send, readBody, getBusinessTasks: () => businessTasks,
      options: { rpcUrl, walletRpcUrl: rpcUrl, confirmations: 2 } });
  }
  service = createService();
  const session = { cookie: '' };
  const anonymous = { cookie: '' };
  async function request(route, { method = 'GET', body, auth = session, admin = false, headers = {} } = {}) {
    const response = await fetch(origin + prefix + route, {
      method, signal: AbortSignal.timeout(12000),
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(admin ? { 'X-Admin-Token': adminToken } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) auth.cookie = setCookie.split(';')[0];
    const json = await response.json();
    return { status: response.status, ...json, setCookie };
  }
  async function expectRequest(route, options, status = 200, code) {
    const result = await request(route, options);
    assert.equal(result.status, status, `${route}: ${JSON.stringify(result)}`);
    if (code) assert.equal(result.error?.code, code, route);
    return result;
  }
  const mine = async (count = 1) => { for (let i = 0; i < count; i++) await provider.send('evm_mine', []); };
  const publicData = async () => (await expectRequest('dashboard', { auth: anonymous })).data;
  const ownData = async () => (await expectRequest('me', {})).data;
  // submit starts an unawaited sync internally. Poll observable state until it settles.
  async function syncUntil(predicate = () => true) {
    let last;
    for (let i = 0; i < 150; i++) {
      await service.sync();
      last = await publicData();
      if (last.syncStatus === 'RPC_ERROR') assert.fail(`RPC sync failed: ${JSON.stringify(last)}`);
      const finalBlock = await provider.getBlockNumber() - 1;
      if (last.syncStatus === 'SYNCED' && last.confirmedBlock === finalBlock && await predicate(last)) return last;
      await delay(20);
    }
    assert.fail(`Sync did not settle: ${JSON.stringify({ syncStatus: last?.syncStatus,
      confirmedBlock: last?.confirmedBlock, totals: last?.totals })}`);
  }
  async function prepare(amountMon, purpose, requestKey = crypto.randomUUID()) {
    return (await expectRequest('donations/prepare', {
      method: 'POST', body: { amountMon, purpose }, headers: { 'Idempotency-Key': requestKey },
    }, 201)).data;
  }
  async function submit(intent, txHash, options = {}) {
    return expectRequest('donations/submit', { method: 'POST', body: { id: intent.id, txHash },
      headers: { 'Idempotency-Key': crypto.randomUUID() }, ...options }, 202);
  }
  const credentials = { name: 'PRIVATE_DONOR_NAME', email: 'private-donor@example.test',
    organization: 'PRIVATE_ORGANIZATION', password: crypto.randomBytes(24).toString('hex') };
  async function login() { return expectRequest('login', { method: 'POST', body: credentials }); }
  async function bind() {
    const challenge = (await expectRequest('challenge', { method: 'POST', body: { address: donor.address } })).data;
    return expectRequest('verify', { method: 'POST', body: {
      nonce: challenge.nonce, signature: await signingWallet.signMessage(challenge.message),
    } });
  }
  async function restart() {
    await service.close();
    service = createService();
    await syncUntil();
    await login();
  }
  return { dataDir, rpc, provider, owner, donor, other, recipient, signingWallet, otherSigningWallet,
    origin, session, anonymous, request, expectRequest, mine, publicData, ownData, syncUntil, prepare, submit,
    credentials, login, bind, restart, get service() { return service; } };
}

test('wallet service HTTP / real local Monad EVM integration', { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  let pool;
  let mainIntent;

  await t.test('HTTP cookie registration/login, real signature binding and admin isolation', async () => {
    assert.equal((await f.publicData()).contractAddress, null);
    await f.expectRequest('admin/overview', { auth: f.anonymous }, 403, 'ADMIN_AUTH_REQUIRED');
    await f.expectRequest('admin/overview', { headers: { 'X-Admin-Token': 'demo-token' } }, 403, 'ADMIN_AUTH_REQUIRED');
    await f.expectRequest('admin/overview', { headers: { 'X-Admin-Token': 'x'.repeat(96) } }, 403, 'ADMIN_AUTH_REQUIRED');
    await f.expectRequest('admin/overview', { admin: true });
    await f.expectRequest('donations/prepare', { method: 'POST', auth: f.anonymous,
      body: { amountMon: '1', purpose: 1 } }, 401, 'AUTH_REQUIRED');
    const registered = await f.expectRequest('register', { method: 'POST', body: f.credentials }, 201);
    assert.match(registered.setCookie, /HttpOnly/);
    assert.match(registered.setCookie, /SameSite=Strict/);
    assert.equal(registered.data.user.wallet, null);
    await f.expectRequest('logout', { method: 'POST', body: {} });
    assert.equal((await f.ownData()).user, null);
    await f.expectRequest('login', { method: 'POST', body: { ...f.credentials, password: 'wrong-password-123' } }, 401, 'INVALID_CREDENTIALS');
    await f.login();
    assert.equal((await f.ownData()).user.email, f.credentials.email);
    await f.expectRequest('challenge', { method: 'POST', body: { address: f.donor.address },
      headers: { Origin: 'https://invalid.example' } }, 403, 'ORIGIN_FORBIDDEN');
    const challenge = (await f.expectRequest('challenge', { method: 'POST', body: { address: f.donor.address } })).data;
    assert.ok(challenge.message.includes(f.origin));
    assert.ok(challenge.message.includes('Chain ID: 10143'));
    await f.expectRequest('verify', { method: 'POST', body: {
      nonce: challenge.nonce, signature: await f.otherSigningWallet.signMessage(challenge.message),
    } }, 400, 'INVALID_SIGNATURE');
    assert.equal((await f.ownData()).user.wallet, null);
    await f.expectRequest('verify', { method: 'POST', body: {
      nonce: challenge.nonce, signature: await f.signingWallet.signMessage(challenge.message),
    } }, 400, 'INVALID_CHALLENGE');
    await f.bind();
    assert.equal((await f.ownData()).user.wallet, f.donor.address);
  });

  await t.test('deployment receipt, confirmations, initcode and runtime verification', async () => {
    await f.expectRequest('admin/deploy-confirm', { method: 'POST', admin: true,
      body: { txHash: id('fake-deployment') } }, 409, 'DEPLOYMENT_PENDING');
    const unrelated = await f.owner.sendTransaction({ to: f.recipient.address, value: 1n });
    await unrelated.wait();
    await f.mine();
    await f.expectRequest('admin/deploy-confirm', { method: 'POST', admin: true,
      body: { txHash: unrelated.hash } }, 409, 'DEPLOYMENT_FAILED');
    const fakeContract = await f.owner.sendTransaction({ data: '0x6001600c60003960016000f300' });
    await fakeContract.wait();
    await f.mine();
    await f.expectRequest('admin/deploy-confirm', { method: 'POST', admin: true,
      body: { txHash: fakeContract.hash } }, 409, 'WRONG_DEPLOYMENT');
    assert.equal((await f.publicData()).contractAddress, null);
    const deployment = (await f.expectRequest('admin/deploy-prepare', {
      method: 'POST', admin: true, body: { owner: f.owner.address },
    })).data.transaction;
    assert.equal(deployment.chainId, '0x279f');
    assert.equal(deployment.data, artifact.bytecode + iface.encodeDeploy([f.owner.address]).slice(2));
    const tx = await f.owner.sendTransaction(deployment);
    const receipt = await tx.wait();
    await f.expectRequest('admin/deploy-confirm', { method: 'POST', admin: true,
      body: { txHash: tx.hash } }, 409, 'DEPLOYMENT_PENDING');
    await f.mine();
    const confirmed = await f.expectRequest('admin/deploy-confirm', { method: 'POST', admin: true, body: { txHash: tx.hash } });
    assert.equal(confirmed.data.contractAddress, receipt.contractAddress);
    assert.equal(await f.provider.getCode(receipt.contractAddress), artifact.deployedBytecode);
    pool = new Contract(receipt.contractAddress, artifact.abi, f.owner);
    assert.equal(await pool.owner(), f.owner.address);
    for (const task of businessTasks) {
      await (await pool.configureTask(id(task.id), task.purpose, task.urgency, mon(task.target),
        f.recipient.address, task.id !== 'inactive')).wait();
    }
    await f.mine();
    const dashboard = await f.syncUntil();
    assert.equal(dashboard.ready, true);
    assert.equal(dashboard.tasks.length, 6);
    await f.expectRequest('admin/deploy-prepare', { method: 'POST', admin: true,
      body: { owner: f.owner.address } }, 409, 'ALREADY_CONFIGURED');
  });

  await t.test('prepare -> wallet send -> submit -> 2 confirmations -> public/me/admin', async () => {
    const requestKey = crypto.randomUUID();
    mainIntent = await f.prepare('0.900000000000000001', 1, requestKey);
    assert.equal((await f.prepare('0.900000000000000001', 1, requestKey)).id, mainIntent.id);
    await f.expectRequest('donations/prepare', { method: 'POST',
      body: { amountMon: '1', purpose: 1 }, headers: { 'Idempotency-Key': requestKey } }, 409, 'IDEMPOTENCY_CONFLICT');
    const amount = mon('0.900000000000000001');
    assert.equal(BigInt(mainIntent.transaction.value), amount);
    assert.equal(mainIntent.transaction.from, f.donor.address);
    assert.equal(mainIntent.transaction.to, await pool.getAddress());
    const decoded = iface.decodeFunctionData('donate', mainIntent.transaction.data);
    assert.deepEqual(Array.from(decoded), [mainIntent.id, 1n]);
    const expected = [[id('high-first'), mon('0.3').toString()], [id('high-second'), mon('0.4').toString()],
      [id('middle'), mon('0.200000000000000001').toString()]];
    assert.deepEqual(mainIntent.allocations.map((a) => [a.taskId, a.amountWei]), expected);
    assert.equal((await f.publicData()).totals.donatedMon, '0.0');
    const tx = await f.donor.sendTransaction(mainIntent.transaction);
    await tx.wait();
    await f.submit(mainIntent, tx.hash);
    await f.syncUntil(async () => (await f.ownData()).donations.find((d) => d.id === mainIntent.id)?.status === 'CONFIRMING');
    assert.equal((await f.publicData()).totals.donatedMon, '0.0', 'one-confirmation funds must not count');
    assert.equal((await f.ownData()).totals.donatedMon, '0.0');
    await f.mine();
    const publicView = await f.syncUntil((view) => view.recentDonations.some((d) => d.id === mainIntent.id));
    const ownView = await f.ownData();
    const adminView = (await f.expectRequest('admin/overview', { admin: true })).data;
    for (const donation of [publicView.recentDonations.find((d) => d.id === mainIntent.id),
      ownView.donations.find((d) => d.id === mainIntent.id), adminView.donations.find((d) => d.id === mainIntent.id)]) {
      assert.equal(donation.status, 'CONFIRMED');
      assert.equal(donation.amountWei, amount.toString());
      assert.equal(donation.purpose, 1);
      assert.equal(donation.txHash, tx.hash);
    assert.deepEqual(donation.allocations.map((a) => [a.taskId, a.amountWei]), expected);
    }
    await f.expectRequest('admin/task-release-prepare', { method: 'POST', admin: true,
      body: { owner: f.other.address, taskId: id('high-first'), amountMon: '0.1' } }, 403, 'NOT_POOL_OWNER');
    await f.expectRequest('admin/task-release-prepare', { method: 'POST', admin: true,
      body: { owner: f.owner.address, taskId: id('high-first'), amountMon: '1' } }, 409, 'INSUFFICIENT_TASK_BALANCE');
    const releasePrepared = (await f.expectRequest('admin/task-release-prepare', { method: 'POST', admin: true,
      body: { owner: f.owner.address, taskId: id('high-first'), amountMon: '0.1' } })).data.transaction;
    assert.equal(releasePrepared.to, await pool.getAddress());
    assert.deepEqual(Array.from(iface.decodeFunctionData('releaseTask', releasePrepared.data)), [id('high-first'), mon('0.1')]);
    const releaseTx = await f.owner.sendTransaction(releasePrepared);
    await releaseTx.wait();
    await f.mine();
    const releasedView = await f.syncUntil(view => view.tasks.find(task => task.id === id('high-first'))?.releasedWei === mon('0.1').toString());
    assert.equal(releasedView.tasks.find(task => task.id === id('high-first')).releasedWei, mon('0.1').toString());
    assert.equal(ownView.totals.donatedMon, '0.900000000000000001');
    assert.equal(adminView.donations.find((d) => d.id === mainIntent.id).donor.email, f.credentials.email);
    assert.equal(publicView.tasks.find((task) => task.id === id('wrong-purpose')).allocatedWei, '0');
    assert.equal(publicView.tasks.find((task) => task.id === id('inactive')).allocatedWei, '0');
    const serialized = JSON.stringify(publicView);
    for (const sensitive of [f.credentials.name, f.credentials.email, f.credentials.organization, f.credentials.password,
      'passwordHash', 'passwordSalt', 'donorUserId', '"email"', '"name"']) assert.ok(!serialized.includes(sensitive), sensitive);
    assert.equal((await f.expectRequest('me', { auth: f.anonymous })).data.user, null);
    assert.deepEqual((await f.expectRequest('me', { auth: f.anonymous })).data.donations, []);
    await f.submit(mainIntent, tx.hash);
    await f.syncUntil();
    await f.syncUntil();
    assert.equal((await f.publicData()).totals.donatedMon, formatEther(amount));
    assert.equal((await f.ownData()).donations.filter((d) => d.id === mainIntent.id).length, 1);
  });

  await t.test('restart replays neither events nor allocations and preserves wallet association', async () => {
    const before = await f.publicData();
    await f.restart();
    const after = await f.publicData();
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.recentDonations, before.recentDonations);
    assert.equal((await f.ownData()).user.wallet, f.donor.address);
    assert.equal((await f.ownData()).donations.find((d) => d.id === mainIntent.id).status, 'CONFIRMED');
    const ledger = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'wallet-ledger.json'), 'utf8'));
    assert.equal(new Set(ledger.events.map((e) => `${e.txHash}:${e.logIndex}`)).size, ledger.events.length);
  });

  await t.test('fake hashes and wrong destination cannot add funds to the pool', async () => {
    const baseline = mon((await f.publicData()).totals.donatedMon);
    const fake = await f.prepare('0.11', 1);
    await f.submit(fake, id('nonexistent-local-transaction'));
    await f.mine(2);
    await f.syncUntil();
    assert.equal(mon((await f.publicData()).totals.donatedMon), baseline);
    assert.equal((await f.ownData()).donations.find((d) => d.id === fake.id).status, 'SUBMITTED');
    const wrongTo = await f.prepare('0.12', 1);
    const toTx = await f.donor.sendTransaction({ ...wrongTo.transaction, to: f.recipient.address });
    await toTx.wait();
    await f.submit(wrongTo, toTx.hash);
    await f.mine();
    await f.syncUntil(async () => (await f.ownData()).donations.find((d) => d.id === wrongTo.id)?.status === 'FAILED');
    assert.equal(mon((await f.publicData()).totals.donatedMon), baseline);
  });

  for (const variant of ['value', 'from', 'purpose']) {
    await t.test(`wrong ${variant} remains an explicit failed intent without user credit`, async () => {
      const ownBefore = (await f.ownData()).totals.donatedMon;
      const intent = await f.prepare('0.13', 1);
      const transaction = { ...intent.transaction };
      const signer = variant === 'from' ? f.other : f.donor;
      if (variant === 'value') transaction.value = '0x1';
      if (variant === 'from') transaction.from = f.other.address;
      if (variant === 'purpose') transaction.data = iface.encodeFunctionData('donate', [intent.id, 2]);
      const tx = await signer.sendTransaction(transaction);
      await tx.wait();
      await f.submit(intent, tx.hash);
      await f.mine();
      await f.syncUntil(async (view) => view.recentDonations.some((d) => d.id === intent.id)
        && (await f.ownData()).donations.find((d) => d.id === intent.id)?.status === 'FAILED');
      const own = await f.ownData();
      assert.equal(own.totals.donatedMon, ownBefore, `wrong ${variant} must not belong to user intent`);
      const actual = (await f.publicData()).recentDonations.find((d) => d.id === intent.id);
      assert.ok(actual, 'valid native donation still belongs in public on-chain totals');
      assert.equal(actual.amountWei, variant === 'value' ? '1' : mon('0.13').toString());
      assert.equal(actual.wallet, signer.address);
      const registered = own.donations.find((d) => d.id === intent.id);
      assert.ok(registered, `Wrong ${variant}: the original intent disappeared from /me after an unmatched on-chain donation`);
      assert.equal(registered.status, 'FAILED', `Wrong ${variant} must report an explicit transaction mismatch`);
      const admin = (await f.expectRequest('admin/overview', { admin: true })).data;
      assert.ok(admin.donations.some((d) => d.id === intent.id && d.donorUserId === own.user.id && d.status === 'FAILED'));
    });
  }

  await t.test('confirmed scanning recovers a wallet transaction never sent to submit', async () => {
    const before = mon((await f.ownData()).totals.donatedMon);
    const intent = await f.prepare('0.21', 0);
    const tx = await f.donor.sendTransaction(intent.transaction);
    await tx.wait();
    await f.syncUntil();
    assert.equal((await f.ownData()).donations.find((d) => d.id === intent.id).status, 'AWAITING_SIGNATURE');
    await f.mine();
    await f.syncUntil(async () => (await f.ownData()).donations.find((d) => d.id === intent.id)?.status === 'CONFIRMED');
    const own = await f.ownData();
    const donation = own.donations.find((d) => d.id === intent.id);
    assert.equal(donation.txHash, tx.hash);
    assert.equal(donation.amountWei, mon('0.21').toString());
    assert.equal(donation.purpose, 0);
    assert.equal(mon(own.totals.donatedMon), before + mon('0.21'));
    await f.submit(intent, tx.hash);
    await f.syncUntil();
    assert.equal((await f.ownData()).donations.filter((d) => d.id === intent.id).length, 1);
  });

  await t.test('excess, permissionless reallocation, refund and release follow confirmed events', async () => {
    const intent = await f.prepare('0.5', 5);
    assert.equal(intent.unallocatedMon, '0.5');
    await (await f.donor.sendTransaction(intent.transaction)).wait();
    await f.mine();
    await f.syncUntil();
    assert.equal((await f.ownData()).donations.find((d) => d.id === intent.id).unallocatedMon, '0.5');
    await (await pool.configureTask(id('reallocation'), 5, 3, mon('0.2'), f.recipient.address, true)).wait();
    await f.mine();
    await f.syncUntil();
    const reallocate = (await f.expectRequest('donations/reallocate', { method: 'POST', body: { id: intent.id } })).data.transaction;
    await (await f.other.sendTransaction({ ...reallocate, from: f.other.address })).wait();
    await f.mine();
    await f.syncUntil();
    let donation = (await f.ownData()).donations.find((d) => d.id === intent.id);
    assert.equal(donation.allocatedMon, '0.2');
    assert.equal(donation.unallocatedMon, '0.3');
    const refund = (await f.expectRequest('donations/refund', { method: 'POST', body: { id: intent.id } })).data.transaction;
    const beforeRefund = await f.publicData();
    await (await f.donor.sendTransaction(refund)).wait();
    await f.syncUntil();
    assert.equal((await f.publicData()).totals.refundedMon, beforeRefund.totals.refundedMon);
    await f.mine();
    await f.syncUntil();
    donation = (await f.ownData()).donations.find((d) => d.id === intent.id);
    assert.equal(donation.refundedWei, mon('0.3').toString());
    assert.equal(donation.unallocatedMon, '0.0');
    await (await pool.releaseTask(id('reallocation'), mon('0.1'))).wait();
    await f.mine();
    const view = await f.syncUntil();
    assert.equal(view.totals.releasedMon, '0.2');
    assert.equal(mon(view.totals.balanceMon), await f.provider.getBalance(await pool.getAddress()));
    assert.equal(view.tasks.find((task) => task.id === id('reallocation')).releasedWei, mon('0.1').toString());
  });

  await t.test('real chain reorg rolls back public/me/admin balances and survives restart', async () => {
    await f.syncUntil();
    const before = await f.publicData();
    const ownBefore = await f.ownData();
    const snapshot = await f.provider.send('evm_snapshot', []);
    const intent = await f.prepare('0.17', 4);
    const tx = await f.donor.sendTransaction(intent.transaction);
    await tx.wait();
    await f.submit(intent, tx.hash);
    await f.mine(2);
    await f.syncUntil(async () => (await f.ownData()).donations.find((d) => d.id === intent.id)?.status === 'CONFIRMED');
    assert.equal(mon((await f.publicData()).totals.donatedMon), mon(before.totals.donatedMon) + mon('0.17'));
    assert.equal(await f.provider.send('evm_revert', [snapshot]), true);
    await f.provider.send('evm_increaseTime', [17]);
    await f.mine(4);
    await f.syncUntil((view) => !view.recentDonations.some((d) => d.id === intent.id));
    const after = await f.publicData();
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual((await f.ownData()).totals, ownBefore.totals);
    assert.notEqual((await f.ownData()).donations.find((d) => d.id === intent.id).status, 'CONFIRMED');
    const admin = (await f.expectRequest('admin/overview', { admin: true })).data;
    assert.deepEqual(admin.totals, before.totals);
    assert.notEqual(admin.donations.find((d) => d.id === intent.id).status, 'CONFIRMED');
    assert.equal(mon(after.totals.balanceMon), await f.provider.getBalance(await pool.getAddress()));
    await f.restart();
    assert.deepEqual((await f.publicData()).totals, before.totals);
    assert.deepEqual((await f.ownData()).totals, ownBefore.totals);
  });
});
