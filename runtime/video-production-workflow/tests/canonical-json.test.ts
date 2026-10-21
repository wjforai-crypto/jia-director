import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256Canonical } from "../src/canonical-json.js";

test("canonical JSON is stable across key order, Unicode form, and negative zero", () => {
  const composed = { b: -0, a: "é", nested: { z: 2, y: 1 } };
  const decomposed = { nested: { y: 1, z: 2 }, a: "e\u0301", b: 0 };
  assert.equal(canonicalJson(composed), canonicalJson(decomposed));
  assert.equal(sha256Canonical(composed), sha256Canonical(decomposed));
  assert.equal(canonicalJson(composed), '{"a":"é","b":0,"nested":{"y":1,"z":2}}');
});

test("canonical JSON rejects non-finite numbers", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/i);
});

test("canonical JSON rejects keys that collide after NFC normalization", () => {
  assert.throws(() => canonicalJson({ "é": 1, "e\u0301": 2 }), /key collision/i);
});
