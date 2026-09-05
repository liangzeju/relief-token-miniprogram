"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createStateStore } = require("../state-store.js");

const REQUIRED = [
  "donations", "tasks", "contracts", "deliveries", "redemptions", "traces",
  "chainTransactions", "auditEvents", "responses", "awards"
];
const ARRAYS = [...REQUIRED, "marketplace", "marketOrders"];

function initialState() {
  return { ...Object.fromEntries(REQUIRED.map(key => [key, []])), idempotency: {} };
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relief-state-store-"));
  // Only remove this test's freshly created directory, never application data.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  return { directory, file, tmp: `${file}.tmp`, store: createStateStore({ file, initialState, ...options }) };
}

function expectFailure(action, code) {
  let caught;
  assert.throws(action, error => {
    caught = error;
    return error instanceof Error && error.status === 503 && error.code === code;
  });
  return caught;
}

test("missing state returns an independent initial clone without writing", t => {
  const initial = initialState();
  initial.donations.push({ id: "DON-1", extra: { amount: 5 } });
  const { store, directory } = fixture(t, { initialState: () => initial });
  const loaded = store.load();
  assert.deepEqual(loaded, initial);
  loaded.donations[0].extra.amount = 99;
  assert.equal(initial.donations[0].extra.amount, 5);
  assert.deepEqual(store.load(), initial);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("commit round trip and restart preserve legacy and unknown fields", t => {
  const { store, file, tmp } = fixture(t);
  const value = initialState();
  for (const key of REQUIRED) value[key].push({ id: "shared-across-arrays", extra: { intact: true } });
  value.idempotency = { request: { result: { amount: 12 } } };
  value.extension = { keep: [null, 1, "x", false] };
  const before = structuredClone(value);
  store.commit(value);
  assert.deepEqual(value, before);
  assert.equal(fs.existsSync(tmp), false);
  const restarted = createStateStore({ file, initialState: () => { throw new Error("must not initialize"); } });
  assert.deepEqual(restarted.load(), value);
  assert.equal(Object.hasOwn(restarted.load(), "marketplace"), false);
  value.marketplace = [{ id: "MAT-1" }];
  value.marketOrders = [{ id: "ORDER-1" }];
  store.commit(value);
  assert.deepEqual(restarted.load(), value);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

const invalidStates = [
  ["null", () => null],
  ["top-level array", () => []],
  ["primitive", () => 1],
  ["missing idempotency", () => { const value = initialState(); delete value.idempotency; return value; }],
  ...[null, [], "bad"].map(value => [`invalid idempotency ${JSON.stringify(value)}`, () => ({ ...initialState(), idempotency: value })]),
  ...REQUIRED.map(key => [`missing ${key}`, () => { const value = initialState(); delete value[key]; return value; }]),
  ...ARRAYS.flatMap(key => [
    [`wrong array ${key}`, () => ({ ...initialState(), [key]: {} })],
    ...[null, [], 1, "bad"].map(item => [`invalid ${key} item ${JSON.stringify(item)}`, () => ({ ...initialState(), [key]: [item] })]),
    ...[{}, { id: "" }, { id: " " }, { id: 1 }].map(item => [`invalid ${key} id ${JSON.stringify(item)}`, () => ({ ...initialState(), [key]: [item] })]),
    [`duplicate ${key} id`, () => ({ ...initialState(), [key]: [{ id: "same" }, { id: "same" }] })]
  ])
];

test("invalid stored structures fail closed without changing either file", async t => {
  for (const [name, makeValue] of invalidStates) {
    await t.test(name, t => {
      const { store, file, tmp } = fixture(t);
      const raw = JSON.stringify(makeValue());
      fs.writeFileSync(file, raw);
      fs.writeFileSync(tmp, "recovery evidence");
      expectFailure(() => store.load(), "STATE_INVALID");
      assert.equal(fs.readFileSync(file, "utf8"), raw);
      assert.equal(fs.readFileSync(tmp, "utf8"), "recovery evidence");
    });
  }
});

test("invalid initial state fails before any file creation", async t => {
  for (const [name, makeValue] of [
    ...invalidStates,
    ["non-plain object", () => Object.assign(new Date(), initialState())],
    ["factory error", () => { throw new Error("factory failed"); }]
  ]) {
    await t.test(name, t => {
      const { store, directory } = fixture(t, { initialState: makeValue });
      expectFailure(() => store.load(), "STATE_INVALID");
      assert.deepEqual(fs.readdirSync(directory), []);
    });
  }
});

test("malformed JSON never initializes or overwrites state", t => {
  const { store, file, directory } = fixture(t, { initialState: () => assert.fail("unexpected initialization") });
  fs.writeFileSync(file, '{"donations":');
  const error = expectFailure(() => store.load(), "STATE_READ_FAILED");
  assert.ok(error.cause instanceof SyntaxError);
  assert.equal(fs.readFileSync(file, "utf8"), '{"donations":');
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("non-ENOENT read and temporary-file inspection errors propagate", async t => {
  for (const method of ["readFileSync", "lstatSync"]) {
    for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
      await t.test(`${method} ${code}`, t => {
        const injected = Object.assign(new Error("injected read failure"), { code });
        const { store, directory } = fixture(t, {
          initialState: () => assert.fail("unexpected initialization"),
          fsImpl: { ...fs, [method]: () => { throw injected; } }
        });
        assert.equal(expectFailure(() => store.load(), "STATE_READ_FAILED").cause, injected);
        assert.deepEqual(fs.readdirSync(directory), []);
      });
    }
  }
});

test("orphan temporary state prevents initialization and is preserved", t => {
  const { store, file, tmp } = fixture(t, { initialState: () => assert.fail("unexpected initialization") });
  fs.writeFileSync(tmp, "interrupted write");
  expectFailure(() => store.load(), "STATE_READ_FAILED");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(tmp, "utf8"), "interrupted write");
  expectFailure(() => store.commit(initialState()), "STATE_WRITE_FAILED");
  assert.equal(fs.readFileSync(tmp, "utf8"), "interrupted write");
});

test("write order uses an exclusive 0600 temporary file, fsync, close, rename", t => {
  const calls = [];
  const wrapped = { ...fs };
  for (const method of ["openSync", "writeFileSync", "fsyncSync", "closeSync", "renameSync"]) {
    wrapped[method] = (...args) => { calls.push([method, ...args]); return fs[method](...args); };
  }
  const { store, file, tmp } = fixture(t, { fsImpl: wrapped });
  store.commit(initialState());
  assert.deepEqual(calls.map(call => call[0]), ["openSync", "writeFileSync", "fsyncSync", "closeSync", "renameSync"]);
  assert.deepEqual(calls[0], ["openSync", tmp, "wx", 0o600]);
  assert.equal(calls[1][1], calls[2][1]);
  assert.equal(calls[2][1], calls[3][1]);
  assert.deepEqual(calls[4], ["renameSync", tmp, file]);
});

test("open, partial write, flush, close and rename failures retain original data", async t => {
  for (const stage of ["openSync", "writeFileSync", "fsyncSync", "closeSync", "renameSync"]) {
    await t.test(stage, t => {
      const injected = new Error(`injected ${stage}`);
      const descriptors = new Set();
      let failed = false;
      const wrapped = { ...fs };
      wrapped.openSync = (...args) => { const fd = fs.openSync(...args); descriptors.add(fd); return fd; };
      wrapped.closeSync = fd => { fs.closeSync(fd); descriptors.delete(fd); };
      const actual = wrapped[stage];
      wrapped[stage] = (...args) => {
        if (!failed) {
          failed = true;
          if (stage === "writeFileSync") fs.writeSync(args[0], "partial");
          throw injected;
        }
        return actual(...args);
      };
      const { store, file, tmp } = fixture(t, { fsImpl: wrapped });
      const original = JSON.stringify({ ...initialState(), marker: "original" });
      fs.writeFileSync(file, original);
      assert.equal(expectFailure(() => store.commit(initialState()), "STATE_WRITE_FAILED").cause, injected);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      assert.equal(descriptors.size, 0);
      assert.equal(fs.existsSync(tmp), stage !== "openSync");
      assert.deepEqual(createStateStore({ file, initialState }).load(), JSON.parse(original));
      if (stage !== "openSync") {
        const evidence = fs.readFileSync(tmp);
        expectFailure(() => store.commit(initialState()), "STATE_WRITE_FAILED");
        assert.deepEqual(fs.readFileSync(tmp), evidence);
      }
    });
  }
});

test("cleanup errors preserve both failure causes", t => {
  const writeError = new Error("write failed");
  const closeError = new Error("close failed");
  const { store, file } = fixture(t, { fsImpl: {
    ...fs,
    writeFileSync: () => { throw writeError; },
    closeSync: fd => { fs.closeSync(fd); throw closeError; }
  } });
  const original = JSON.stringify(initialState());
  fs.writeFileSync(file, original);
  const error = expectFailure(() => store.commit(initialState()), "STATE_WRITE_FAILED");
  assert.ok(error.cause instanceof AggregateError);
  assert.deepEqual(error.cause.errors, [writeError, closeError]);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("non-Error thrown values are still reported as failures", t => {
  const { store, file } = fixture(t, { fsImpl: {
    ...fs,
    readFileSync: () => { throw null; },
    writeFileSync: () => { throw undefined; }
  } });
  const original = JSON.stringify(initialState());
  fs.writeFileSync(file, original);
  expectFailure(() => store.load(), "STATE_READ_FAILED");
  expectFailure(() => store.commit(initialState()), "STATE_WRITE_FAILED");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("invalid commits and lossy JSON values never open a temporary file", async t => {
  const circular = initialState();
  circular.extra = circular;
  for (const [name, makeValue] of [
    ...invalidStates,
    ["circular", () => circular],
    ...[undefined, NaN, Infinity, 1n, () => {}, Symbol("value"), new Date()].map((value, i) => [
      `non-JSON field ${i}`, () => ({ ...initialState(), extra: value })
    ]),
    ["sparse array", () => ({ ...initialState(), extra: new Array(1) })],
    ["non-index array property", () => ({ ...initialState(), extra: Object.assign([], { 4294967295: "lost" }) })],
    ["symbol property", () => ({ ...initialState(), [Symbol("key")]: 1 })]
  ]) {
    await t.test(name, t => {
      const { store, file, tmp } = fixture(t);
      const original = JSON.stringify(initialState());
      fs.writeFileSync(file, original);
      expectFailure(() => store.commit(makeValue()), "STATE_WRITE_FAILED");
      assert.equal(fs.readFileSync(file, "utf8"), original);
      assert.equal(fs.existsSync(tmp), false);
    });
  }
});
