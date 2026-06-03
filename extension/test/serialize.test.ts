import assert from "node:assert/strict";
import { buildMessage, serializeArg } from "../src/serialize.js";

let n = 0;
function check(name: string, cond: boolean): void {
  assert.ok(cond, name);
  n++;
  console.error("ok -", name);
}

// serializeArg
check("string passes through", serializeArg("hi") === "hi");
check("Error → 'Name: message'", serializeArg(new Error("boom")) === "Error: boom");
check("TypeError name preserved", serializeArg(new TypeError("bad")) === "TypeError: bad");
check("number", serializeArg(42) === "42");
check("boolean", serializeArg(true) === "true");
check("null", serializeArg(null) === "null");
check("undefined", serializeArg(undefined) === "undefined");
check("plain object → JSON", serializeArg({ a: 1, b: "x" }) === '{"a":1,"b":"x"}');
check("array → JSON", serializeArg([1, 2, 3]) === "[1,2,3]");

const circular: Record<string, unknown> = {};
circular.self = circular;
check("circular ref falls back to String()", serializeArg(circular) === "[object Object]");

const bigint = serializeArg(10n);
check("bigint doesn't throw, stringifies", bigint === "10");

// buildMessage
check("buildMessage joins with spaces", buildMessage(["a", 1, null]) === "a 1 null");
check("buildMessage empty", buildMessage([]) === "");
check(
  "buildMessage mixes Error + text",
  buildMessage(["failed:", new Error("nope")]) === "failed: Error: nope",
);

console.error(`\n${n} assertions passed`);
