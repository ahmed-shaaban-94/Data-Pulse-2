// loadtests/k6/lib/util.js
//
// Shared helpers for k6 scripts:
//   - BASE_URL resolver (reads __ENV.BASE_URL, defaults to http://localhost:3000)
//   - uuidv4()         — RFC 4122 v4 generator used for Idempotency-Key headers
//   - jsonHeaders()    — base headers for JSON requests (forward-compat
//                        Idempotency-Key included on POST flows where it
//                        helps Track D adoption later)
//   - sleepJitter()    — small randomized think-time
//
// k6 stdlib only — no npm imports.

import { sleep } from "k6";
import crypto from "k6/crypto";

export function baseUrl() {
  return (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

// k6's k6/crypto.randomBytes is not always available across versions, so we
// fall back to Math.random where needed. The resulting UUID is fine for
// idempotency keys in a synthetic load environment (it does NOT need to be
// cryptographically unique across tenants — collisions just produce replays).
export function uuidv4() {
  try {
    // Preferred path — uses k6/crypto if randomBytes is exposed.
    const bytes = new Uint8Array(crypto.randomBytes(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuidBytes(bytes);
  } catch (_e) {
    // Fallback: Math.random()-based generator. Not cryptographically secure,
    // acceptable for load-test idempotency keys.
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuidBytes(bytes);
  }
}

function formatUuidBytes(bytes) {
  const hex = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

export function jsonHeaders(extra) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (extra) {
    for (const k in extra) headers[k] = extra[k];
  }
  return headers;
}

// Headers for POST flows. Includes an Idempotency-Key by default so that
// when Track D enables per-endpoint policy on these routes the load harness
// will already exercise the replay/conflict/425 paths instead of all-new
// keys. Pass { idempotencyKey: false } to omit.
export function jsonPostHeaders(opts) {
  const o = opts || {};
  const h = jsonHeaders(o.extra);
  if (o.idempotencyKey !== false) {
    h["Idempotency-Key"] = o.key || uuidv4();
  }
  return h;
}

export function sleepJitter(maxSeconds) {
  const m = typeof maxSeconds === "number" ? maxSeconds : 1;
  sleep(Math.random() * m);
}
