"use strict";

const fs = require("node:fs");

const REQUIRED_ARRAYS = [
  "donations", "tasks", "contracts", "deliveries", "redemptions", "traces",
  "chainTransactions", "auditEvents", "responses", "awards"
];
const OPTIONAL_ARRAYS = ["marketplace", "marketOrders"];

function failure(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { status: 503, code });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validate(value) {
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("State must be a plain object");
  }
  for (const key of [...REQUIRED_ARRAYS, ...OPTIONAL_ARRAYS]) {
    if (OPTIONAL_ARRAYS.includes(key) && !Object.hasOwn(value, key)) continue;
    if (!Object.hasOwn(value, key) || !Array.isArray(value[key])) {
      throw new Error(`State.${key} must be an array`);
    }
    const ids = new Set();
    for (const item of value[key]) {
      if (!isObject(item)) throw new Error(`State.${key} items must be objects`);
      if (!Object.hasOwn(item, "id") || typeof item.id !== "string" || !item.id.trim()) {
        throw new Error(`State.${key} items must have a non-empty string id`);
      }
      if (ids.has(item.id)) throw new Error(`State.${key} contains duplicate ids`);
      ids.add(item.id);
    }
  }
  if (!Object.hasOwn(value, "idempotency") || !isObject(value.idempotency)) {
    throw new Error("State.idempotency must be an object");
  }
  return value;
}

// Reject values JSON would silently omit or coerce, including unknown fields.
function checkJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error("State contains a non-JSON value");
  if (ancestors.has(value)) throw new Error("State contains a circular reference");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("State contains a non-JSON object");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error("State contains a sparse array");
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error("State contains a non-JSON property");
    }
    if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error("State contains an array property JSON would omit");
    }
    checkJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function createStateStore({ file, initialState, fsImpl = fs }) {
  const temporaryFile = `${file}.tmp`;

  function load() {
    let raw;
    try {
      raw = fsImpl.readFileSync(file, "utf8");
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        throw failure("STATE_READ_FAILED", "Unable to read state", cause);
      }
      try {
        // lstat also detects dangling links left at the recovery path.
        fsImpl.lstatSync(temporaryFile);
      } catch (temporaryError) {
        if (temporaryError?.code !== "ENOENT") {
          throw failure("STATE_READ_FAILED", "Unable to inspect temporary state", temporaryError);
        }
        try {
          const initial = validate(initialState());
          checkJson(initial);
          return validate(structuredClone(initial));
        } catch (initialError) {
          throw failure("STATE_INVALID", "Invalid initial state", initialError);
        }
      }
      throw failure("STATE_READ_FAILED", "Temporary state requires recovery before initialization", cause);
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      throw failure("STATE_READ_FAILED", "Unable to parse state JSON", cause);
    }
    try {
      return validate(value);
    } catch (cause) {
      throw failure("STATE_INVALID", "Invalid stored state", cause);
    }
  }

  function commit(value) {
    let fd;
    let writeError;
    let failed = false;
    try {
      validate(value);
      checkJson(value);
      const serialized = JSON.stringify(value, null, 2);
      // Exclusive creation preserves an existing recovery file on every failure.
      fd = fsImpl.openSync(temporaryFile, "wx", 0o600);
      fsImpl.writeFileSync(fd, serialized, "utf8");
      fsImpl.fsyncSync(fd);
      fsImpl.closeSync(fd);
      fd = undefined;
      fsImpl.renameSync(temporaryFile, file);
    } catch (cause) {
      failed = true;
      writeError = cause;
    } finally {
      if (fd !== undefined) {
        try {
          fsImpl.closeSync(fd);
        } catch (closeError) {
          writeError = failed
            ? new AggregateError([writeError, closeError], "State write and descriptor close failed")
            : closeError;
          failed = true;
        }
      }
    }
    if (failed) throw failure("STATE_WRITE_FAILED", "Unable to commit state", writeError);
  }

  return { load, commit };
}

module.exports = { createStateStore };
