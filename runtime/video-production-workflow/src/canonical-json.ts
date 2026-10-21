import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not allow non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const normalizedKeys = new Set<string>();
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      const normalizedKey = key.normalize("NFC");
      if (normalizedKeys.has(normalizedKey)) {
        throw new Error(`Canonical JSON key collision after NFC normalization: ${normalizedKey}`);
      }
      normalizedKeys.add(normalizedKey);
      result[normalizedKey] = normalize(source[key]);
    }
    return result;
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
