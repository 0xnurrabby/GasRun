// Vercel Serverless Function: /api/leaderboard
// "Perfect" Leaderboard:
// - Shows only: This Week + Last Week (no all-time).
// - Instant open via Vercel KV cache (if configured).
// - Instant-ish updates via:
//    * Manual refresh: /api/leaderboard?refresh=1
//    * Optional Vercel Cron: /api/cron/leaderboard (updates in background schedule)
// - Onchain source-of-truth remains: contract logs (eth_getLogs). Cache stores only derived totals.
//
// Env (recommended):
// - Add Upstash Redis (Vercel Storage → Upstash → Upstash for Redis).
//   Vercel will add env vars: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
//   If Upstash missing, falls back to in-memory cache.
// - Optional: NEYNAR_API_KEY for FC usernames (bulk; low cost).

const { keccak_256 } = require("js-sha3");

// Optional KV store (Upstash preferred). Safe fallback if not configured.
let store = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const { Redis } = require("@upstash/redis");
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
    store = {
      kind: "upstash",
      get: (k) => redis.get(k),
      set: (k, v, opts) => redis.set(k, v, opts),
      del: (k) => redis.del(k)
    };
  }
} catch (_) {
  // ignore
}

// (Optional) Back-compat: if user has Vercel KV configured.
if (!store) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const kv = require("@vercel/kv").kv;
    if (kv && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      store = {
        kind: "vercel-kv",
        get: (k) => kv.get(k),
        set: (k, v, opts) => kv.set(k, v, opts),
        del: (k) => kv.del(k)
      };
    }
  } catch (_) {
    // ignore
  }
}

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF".toLowerCase();

// ActionLogged(address indexed user, bytes payload, bytes32 action)
const TOPIC0_ACTION_LOGGED =
  "0x" + keccak_256("ActionLogged(address,bytes32,uint256,bytes)");

// bytes32("WEEKLY_ADD") padded to 32 bytes
const TOPIC2_ACTION_WEEKLY_ADD =
  "0x5745454b4c595f41444400000000000000000000000000000000000000000000";

// Public Base RPCs (include several; order matters)
// Put known-good public Base RPCs first so a restrictive/"free-tier" RPC set in env
// doesn't block historical log backfills.
const RPCS = [
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://base.llamarpc.com",
  process.env.RPC_URL,
  ...(process.env.RPC_URLS ? process.env.RPC_URLS.split(",") : [])
].filter(Boolean);

// KV keys
const KV_PREFIX = "lanerunner:lb:v3";
const KV_STATE_KEY = `${KV_PREFIX}:state`; // compact state for 2 weeks
const KV_RESP_KEY = `${KV_PREFIX}:resp`;  // already formatted response payload
const KV_LOCK_KEY = `${KV_PREFIX}:lock`;  // simple lock (best-effort)

// Bump this when the shape/meaning of persisted state changes.
// Used to automatically rebuild old cached snapshots after deployments.
const STATE_SCHEMA_VERSION = 4;


// In-memory fallback (works only per warm serverless instance)
let MEM_STATE = null;
let MEM_RESP = null;
let MEM_RESP_AT = 0;

// Tunables
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour for resp; cron/refresh keeps it hot
const STATE_TTL_SECONDS = 60 * 60 * 24 * 21; // 3 weeks
const MAX_TOP = 100;   // leaderboard UI size
const PRUNE_KEEP = 250; // keep top N in state to keep KV value small
const MAX_SERVERLESS_MS = 8500; // try to finish before hard limits

function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun
  const diffToMon = (day + 6) % 7; // Mon=0
  const mon = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0)
  );
  return mon.getTime();
}

function toHex(n) {
  const b = typeof n === "bigint" ? n : BigInt(n);
  return "0x" + b.toString(16);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitish(status, bodyText) {
  const t = (bodyText || "").toLowerCase();
  return (
    status === 429 ||
    t.includes("rate limit") ||
    t.includes("too many requests") ||
    t.includes("over rate limit")
  );
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`RPC HTTP ${res.status}: ${text.slice(0, 240)}`);
    err.httpStatus = res.status;
    err.bodyText = text;
    throw err;
  }

  const json = JSON.parse(text);
  if (json.error) {
    const err = new Error(`RPC error: ${JSON.stringify(json.error)}`);
    err.rpcError = json.error;
    throw err;
  }
  return json.result;
}

async function withRpcRotation(fn, { tries = 6 } = {}) {
  const urls = RPCS.length ? RPCS : ["https://mainnet.base.org"];
  let lastErr = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      return await fn(url);
    } catch (e) {
      lastErr = e;
      const status = e?.httpStatus;
      const bodyText = e?.bodyText || "";
      const msg = (e?.message || "").toLowerCase();

      // backoff on rate limit-ish
      if (isRateLimitish(status, bodyText) || msg.includes("timeout") || msg.includes("fetch failed")) {
        await sleep(250 * (attempt + 1));
        continue;
      }

      // move on to next RPC
      await sleep(60);
    }
  }
  throw lastErr || new Error("RPC rotation failed");
}

function addrFromTopic(topic1) {
  const t = (topic1 || "").startsWith("0x") ? topic1.slice(2) : (topic1 || "");
  return ("0x" + t.slice(t.length - 40)).toLowerCase();
}

// data contains ABI-encoded (bytes payload) - we only need the bytes value
// The contract logs encode: data = offset(32) + length(32) + bytes
function extractBytesParamFromLogData(dataHex) {
  const hex = (dataHex || "").startsWith("0x") ? dataHex.slice(2) : (dataHex || "");
  if (hex.length < 128) return null;

  // Two supported layouts:
  // A) bytes only:   [offset][length][bytes...]
  // B) uint256,bytes: [timestamp][offset][length][bytes...]
  const w0 = Number(BigInt("0x" + hex.slice(0, 64)));
  const w1 = Number(BigInt("0x" + hex.slice(64, 128)));

  let lenPos;
  let bytesStart;

  if (w0 === 32) {
    // A) bytes only (offset=32 bytes)
    lenPos = 64;
    bytesStart = 128;
  } else {
    // B) timestamp + bytes (offset should be 64 bytes)
    lenPos = w1 * 2;
    bytesStart = lenPos + 64;
    if (lenPos + 64 > hex.length) return null;
  }

  const len = Number(BigInt("0x" + hex.slice(lenPos, lenPos + 64)));
  const end = bytesStart + len * 2;
  if (end > hex.length) return null;

  return "0x" + hex.slice(bytesStart, end);
}

// ActionLogged data encodes: uint256 timestamp, bytes payload
// payload encodes: uint256 points, uint256 weekStartMs
function decodePointsAndWeek(payloadHex) {
  const hex = payloadHex && payloadHex.startsWith("0x") ? payloadHex.slice(2) : (payloadHex || "");
  if (!hex || hex.length < 128) return null;

  const points = BigInt("0x" + hex.slice(0, 64));
  const week = BigInt("0x" + hex.slice(64, 128));
  return { points, week };
}



function decodeActionLoggedData(dataHex) {
  const hex = dataHex && dataHex.startsWith("0x") ? dataHex.slice(2) : (dataHex || "");
  // Need at least timestamp (32) + offset (32)
  if (!hex || hex.length < 128) return null;

  const ts = BigInt("0x" + hex.slice(0, 64));
  const offset = Number(BigInt("0x" + hex.slice(64, 128))); // in bytes
  const offsetHexPos = offset * 2;
  if (offsetHexPos + 64 > hex.length) return null;

  const len = Number(BigInt("0x" + hex.slice(offsetHexPos, offsetHexPos + 64)));
  const payloadStart = offsetHexPos + 64;
  const payloadEnd = payloadStart + len * 2;
  if (payloadEnd > hex.length) return null;

  const payloadHex = "0x" + hex.slice(payloadStart, payloadEnd);
  return { ts, payloadHex };
}


// --------------------------
// Farcaster names via Neynar (optional, bulk)
// --------------------------
async function fetchNamesFromNeynar(addresses) {
  const key = process.env.NEYNAR_API_KEY;
  if (!key) return new Map();

  const uniq = [...new Set((addresses || []).map((a) => String(a || "").toLowerCase()))].filter(Boolean);
  if (!uniq.length) return new Map();

  const out = new Map();
  const chunkSize = 200;

  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk-by-address");
    url.searchParams.set("addresses", chunk.join(","));

    const res = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        api_key: key
      }
    });

    if (!res.ok) continue;
    const json = await res.json();

    const users = json?.users || [];
    for (const u of users) {
      const addr = (u?.verified_addresses?.eth_addresses?.[0] || "").toLowerCase();
      const uname = u?.username;
      if (addr && uname) out.set(addr, uname);
    }
  }

  return out;
}

function sortMapToArray(m) {
  if (!m) return [];
  return [...m.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([address, points]) => ({ address, points: points.toString() }));
}

function pruneToTop(map, keep = PRUNE_KEEP) {
  const arr = [...map.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const pruned = new Map(arr.slice(0, keep));
  return pruned;
}

function nowMs() {
  return Date.now();
}

function hasStoreConfigured() {
  return !!store;
}

async function storeGetJson(key) {
  if (!hasStoreConfigured()) {
    if (key === KV_STATE_KEY) return MEM_STATE;
    if (key === KV_RESP_KEY) return MEM_RESP;
    return null;
  }
  const v = await store.get(key);
  if (!v) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (_) { return null; }
  }
  return v;
}

async function storeSetJson(key, value, exSeconds) {
  if (!hasStoreConfigured()) {
    if (key === KV_STATE_KEY) MEM_STATE = value;
    if (key === KV_RESP_KEY) {
      MEM_RESP = value;
      MEM_RESP_AT = nowMs();
    }
    return true;
  }
  // Store JSON string for cross-provider consistency.
  const payload = JSON.stringify(value);
  await store.set(key, payload, exSeconds ? { ex: exSeconds } : undefined);
  return true;
}

async function storeAcquireLock(lockKey, ttlSeconds = 30) {
  if (!hasStoreConfigured()) return true; // no shared store => no contention
  // best-effort: set if not exists
  // Upstash + Vercel KV both support: set(key, value, { nx: true, ex: ttl })
  try {
    const ok = await store.set(lockKey, "1", { nx: true, ex: ttlSeconds });
    return ok === "OK" || ok === true;
  } catch (_) {
    return true;
  }
}

async function storeReleaseLock(lockKey) {
  if (!hasStoreConfigured()) return;
  try { await store.del(lockKey); } catch (_) {}
}

// --------------------------
// Onchain log fetch (adaptive chunking to survive "max 1k blocks" RPCs)
// --------------------------
// Optional BaseScan (Etherscan-style) Logs API, which is often more reliable than RPC eth_getLogs on free-tier nodes.
// Uses Etherscan-compatible getLogs query params (topics + page/offset).
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || process.env.BASESCAN_KEY || "";

async function fetchLogsViaBaseScan(fromBlock, toBlock, deadlineMs) {
  // BaseScan expects decimal block numbers.
  const fromDec = fromBlock.toString(10);
  const toDec = toBlock.toString(10);
  const offset = 1000;
  let page = 1;
  const out = [];

  while (true) {
    if (deadlineMs && nowMs() > deadlineMs) {
      const e = new Error("deadline");
      e.code = "DEADLINE";
      throw e;
    }

    const url = new URL("https://api.basescan.org/api");
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("fromBlock", fromDec);
    url.searchParams.set("toBlock", toDec);
    url.searchParams.set("address", CONTRACT);

    // Filter: topic0 (event sig) AND topic2 (action bytes32)
    url.searchParams.set("topic0", TOPIC0_ACTION_LOGGED);
    url.searchParams.set("topic0_2_opr", "and");
    url.searchParams.set("topic2", TOPIC2_ACTION_WEEKLY_ADD);

    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(offset));
    if (BASESCAN_API_KEY) url.searchParams.set("apikey", BASESCAN_API_KEY);

    const r = await fetch(url.toString(), { headers: { accept: "application/json" }, cache: "no-store" });
    const j = await r.json().catch(() => null);

    // Handle HTTP errors / rate limits gracefully
    if (!r.ok) {
      const txt = JSON.stringify(j || {}).toLowerCase();
      if (r.status === 429 || txt.includes("rate limit") || txt.includes("too many")) {
        await sleep(250);
        continue;
      }
      throw new Error(`BaseScan HTTP ${r.status}: ${(j && JSON.stringify(j).slice(0, 240)) || ""}`);
    }

    const status = String(j?.status || "");
    const msg = String(j?.message || "");

    // No records found is a normal terminal condition.
    if (status === "0" && msg.toLowerCase().includes("no records")) break;

    if (status !== "1") {
      // Some variants return status=0 with rate-limit-ish messages
      const m = (msg || "").toLowerCase();
      const resultText = JSON.stringify(j?.result || "").toLowerCase();
      if (m.includes("rate") || resultText.includes("rate") || resultText.includes("too many")) {
        await sleep(250);
        continue;
      }
      throw new Error(`BaseScan error: ${msg || resultText || "unknown"}`);
    }

    const logs = Array.isArray(j?.result) ? j.result : [];
    if (logs.length) out.push(...logs);

    if (logs.length < offset) break;
    page += 1;
    await sleep(120);
  }

  return out;
}

async function fetchLogsRange(fromBlock, toBlock, stepInitial = 8000n, hardMinStep = 900n, deadlineMs) {
  const logsOut = [];
  let step = stepInitial;

  // Progress cursor: last block we successfully scanned up to.
  // This lets us continue over multiple cron invocations without losing data.
  let lastScanned = fromBlock > 0n ? (fromBlock - 1n) : 0n;
  let complete = true;

  for (let from = fromBlock; from <= toBlock; ) {
    if (deadlineMs && nowMs() > deadlineMs) {
      complete = false;
      break;
    }

    let to = from + step;
    if (to > toBlock) to = toBlock;

    const filter = {
      address: CONTRACT,
      fromBlock: toHex(from),
      toBlock: toHex(to),
      topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
    };

    try {
      const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));
      if (Array.isArray(logs) && logs.length) logsOut.push(...logs);

      lastScanned = to;
      from = to + 1n;
    } catch (e) {
      const msg = (e?.message || "").toLowerCase();

      // Some providers reject *historical* ranges on free tier (shrinking step won't help).
      // Example: "ranges over 10000 blocks are not supported on freetier".
      if (msg.includes("freetier") || msg.includes("not supported on freetier") || msg.includes("ranges over 10000")) {
        throw e;
      }

      // If the provider says the range is too large, shrink the step
      if (msg.includes("range is too large") || msg.includes("m...1k") || msg.includes("limit") || msg.includes("block range")) {
        step = step / 2n;
        if (step < hardMinStep) step = hardMinStep;
        // retry same from with smaller range
        await sleep(120);
        continue;
      }

      // If we got rate limited, wait and retry same segment
      if (isRateLimitish(e?.httpStatus, e?.bodyText) || msg.includes("timeout") || msg.includes("fetch failed")) {
        await sleep(250);
        continue;
      }

      // Unknown error: rotate & try again with smaller step once
      step = step / 2n;
      if (step < hardMinStep) step = hardMinStep;
      await sleep(120);
    }
  }

  return { logs: logsOut, lastScannedBlock: lastScanned, complete };
}

async function getLatestBlock() {
  const latestHex = await withRpcRotation((url) => rpcCall(url, "eth_blockNumber", []));
  return BigInt(latestHex);
}

// --------------------------
// Precise time -> block lookup
// --------------------------
// Fixes cases where a "650k blocks ~= 14 days" heuristic is too small and the
// backfill misses early-week logs (leading to fewer users + lower points).
//
// Prefer BaseScan's getblocknobytime (single HTTP call). Fallback to RPC binary search.
async function getBlockByTimeBaseScan(timestampSec, closest = "before") {
  const url = new URL("https://api.basescan.org/api");
  url.searchParams.set("module", "block");
  url.searchParams.set("action", "getblocknobytime");
  url.searchParams.set("timestamp", String(Math.max(0, Math.floor(timestampSec))));
  url.searchParams.set("closest", closest);
  if (BASESCAN_API_KEY) url.searchParams.set("apikey", BASESCAN_API_KEY);

  const r = await fetch(url.toString(), { headers: { accept: "application/json" }, cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`BaseScan block-by-time HTTP ${r.status}`);

  const status = String(j?.status || "");
  if (status !== "1") {
    const msg = String(j?.message || "");
    const resultText = String(j?.result || "");
    throw new Error(`BaseScan block-by-time error: ${msg || resultText || "unknown"}`);
  }

  // result is decimal string block number
  return BigInt(String(j.result));
}

async function getBlockTimestampSec(blockNumber) {
  const b = await withRpcRotation((url) => rpcCall(url, "eth_getBlockByNumber", [toHex(blockNumber), false]));
  if (!b || !b.timestamp) throw new Error("eth_getBlockByNumber missing timestamp");
  return Number(BigInt(b.timestamp));
}

async function findFirstBlockAtOrAfterTsSec(targetTsSec, latestBlock) {
  let lo = 0n;
  let hi = latestBlock;
  let ans = latestBlock;

  // Binary search: smallest block with timestamp >= target
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const ts = await getBlockTimestampSec(mid);
    if (ts >= targetTsSec) {
      ans = mid;
      if (mid === 0n) break;
      hi = mid - 1n;
    } else {
      lo = mid + 1n;
    }
  }

  return ans;
}

// --------------------------
// Core aggregation logic (incremental with KV state)
// --------------------------
function emptyWeekState(weekMs) {
  return { weekMs, map: new Map() };
}

function deserializeState(s) {
  if (!s) return null;
  try {
    const weekA = s?.weeks?.[0];
    const weekB = s?.weeks?.[1];
    const weeks = [];
    for (const w of [weekA, weekB]) {
      if (!w || !w.weekMs || !w.entries) continue;
      const m = new Map();
      for (const [addr, pts] of w.entries) m.set(String(addr).toLowerCase(), BigInt(pts));
      weeks.push({ weekMs: Number(w.weekMs), map: m });
    }
    return {
      schemaVersion: Number(s.schemaVersion || 0),
      backfillFromBlock: s.backfillFromBlock ? BigInt(s.backfillFromBlock) : null,
      anchorTsSec: Number(s.anchorTsSec || 0),
      currentWeekMs: Number(s.currentWeekMs || 0),
      lastWeekMs: Number(s.lastWeekMs || 0),
      lastProcessedBlock: s.lastProcessedBlock ? BigInt(s.lastProcessedBlock) : null,
      weeks,
      updatedAt: Number(s.updatedAt || 0)
    };
  } catch (_) {
    return null;
  }
}

function serializeState(state) {
  const weeks = state.weeks.map((w) => ({
    weekMs: w.weekMs,
    entries: [...w.map.entries()].map(([a, p]) => [a, p.toString()])
  }));
  return {
    schemaVersion: state.schemaVersion || STATE_SCHEMA_VERSION,
    backfillFromBlock: state.backfillFromBlock ? state.backfillFromBlock.toString() : null,
    anchorTsSec: state.anchorTsSec || 0,
    currentWeekMs: state.currentWeekMs,
    lastWeekMs: state.lastWeekMs,
    lastProcessedBlock: state.lastProcessedBlock ? state.lastProcessedBlock.toString() : null,
    weeks,
    updatedAt: state.updatedAt
  };
}

function getOrMakeWeekMap(state, weekMs) {
  let w = state.weeks.find((x) => x.weekMs === weekMs);
  if (!w) {
    w = emptyWeekState(weekMs);
    state.weeks.push(w);
  }
  return w.map;
}

function formatResponsePayload(state, { includeNames = false, fcMap = null } = {}) {
  const curMap = state.weeks.find((x) => x.weekMs === state.currentWeekMs)?.map || new Map();
  const prevMap = state.weeks.find((x) => x.weekMs === state.lastWeekMs)?.map || new Map();

  const weekly = sortMapToArray(curMap).slice(0, MAX_TOP);
  const lastWeek = sortMapToArray(prevMap).slice(0, MAX_TOP);

  const enrich = (arr) =>
    arr.map((it) => {
      if (!includeNames || !fcMap) return it;
      const u = fcMap.get(it.address.toLowerCase());
      return { ...it, name: u ? `${u}.farcaster.eth` : undefined };
    });

  return {
    ok: true,
    weekStart: state.currentWeekMs,
    prevWeekStart: state.lastWeekMs,
    weekly: enrich(weekly),
    lastWeek: enrich(lastWeek),
    meta: {
      schemaVersion: state.schemaVersion || STATE_SCHEMA_VERSION,
      weeklyUsers: curMap.size,
      lastWeekUsers: prevMap.size,
      lastProcessedBlock: state.lastProcessedBlock ? state.lastProcessedBlock.toString() : null,
      updatedAt: state.updatedAt
    }
  };
}

async function backfillTwoWeeks(now, deadlineMs) {
  const curWeekMs = weekStartUtcMs(now);
  const prevWeekMs = curWeekMs - 7 * 24 * 60 * 60 * 1000;

  const latest = await getLatestBlock();

  // IMPORTANT: don't assume a fixed "blocks per day".
  // If this is too small, the backfill will miss early-week logs (exactly your bug).
  const anchorTsSec = Math.floor(prevWeekMs / 1000) - 3600; // 1h safety buffer
  let fromBlock = 0n;
  try {
    fromBlock = await getBlockByTimeBaseScan(anchorTsSec, "before");
  } catch (_) {
    // Fallback: RPC binary search (slower). If that also fails, fall back to a wide window.
    try {
      fromBlock = await findFirstBlockAtOrAfterTsSec(anchorTsSec, latest);
      // extra buffer so we never miss boundary events
      if (fromBlock > 2000n) fromBlock = fromBlock - 2000n;
    } catch (_) {
      const WINDOW = 1500000n; // ~2+ weeks even at 1s blocks
      fromBlock = latest > WINDOW ? latest - WINDOW : 0n;
    }
  }

  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    backfillFromBlock: fromBlock,
    anchorTsSec,
    currentWeekMs: curWeekMs,
    lastWeekMs: prevWeekMs,
    lastProcessedBlock: null,
    weeks: [emptyWeekState(curWeekMs), emptyWeekState(prevWeekMs)],
    updatedAt: nowMs()
  };

  // Prefer BaseScan for large backfills (more reliable on free-tier RPCs). Fallback to RPC.
  let logs = [];
  let progress = { lastScannedBlock: fromBlock > 0n ? (fromBlock - 1n) : 0n, complete: false };

  try {
    // If BaseScan can't finish within the serverless budget, it will throw (DEADLINE),
    // and we'll fall back to chunked RPC scanning which supports resuming.
    logs = await fetchLogsViaBaseScan(fromBlock, latest, deadlineMs);
    progress = { lastScannedBlock: latest, complete: true };
  } catch (_) {
    const r = await fetchLogsRange(fromBlock, latest, 8000n, 900n, deadlineMs);
    logs = r.logs;
    progress = { lastScannedBlock: r.lastScannedBlock, complete: r.complete };
  }

  for (const l of logs) {
    const user = addrFromTopic(l.topics?.[1]);
    const payload = extractBytesParamFromLogData(l.data);
    const dec = decodePointsAndWeek(payload);
    if (!dec) continue;

    const wk = Number(dec.week);
    if (wk !== curWeekMs && wk !== prevWeekMs) continue;

    const points = dec.points;
    const m = getOrMakeWeekMap(state, wk);
    m.set(user, (m.get(user) || 0n) + points);
  }

  // prune to keep KV small
  for (const w of state.weeks) w.map = pruneToTop(w.map, PRUNE_KEEP);
  // IMPORTANT: only mark up-to-latest when the scan fully completed.
  // Otherwise we would permanently drop events from the not-yet-scanned part of the range.
  state.lastProcessedBlock = progress.complete ? latest : progress.lastScannedBlock;
  state.updatedAt = nowMs();
  return state;
}

async function incrementalUpdate(existingState, deadlineMs) {
  const now = nowMs();
  const curWeekMs = weekStartUtcMs(now);
  const prevWeekMs = curWeekMs - 7 * 24 * 60 * 60 * 1000;

  const latest = await getLatestBlock();

  // If week rolled over, state missing lastProcessed, or the persisted schema changed => do a safe backfill.
  if (
    !existingState ||
    !existingState.lastProcessedBlock ||
    existingState.currentWeekMs !== curWeekMs ||
    Number(existingState.schemaVersion || 0) < STATE_SCHEMA_VERSION
  ) {
    return await backfillTwoWeeks(now, deadlineMs);
  }

  const state = existingState;
  state.currentWeekMs = curWeekMs;
  state.lastWeekMs = prevWeekMs;

  const from = state.lastProcessedBlock + 1n;
  if (from > latest) {
    state.updatedAt = nowMs();
    return state;
  }

  // For incremental updates, RPC is usually fine and supports resuming across cron runs.
  // BaseScan is used only as a fallback (and must complete fully to avoid double-counting).
  let logs = [];
  let progress = { lastScannedBlock: from > 0n ? (from - 1n) : 0n, complete: false };

  try {
    const r = await fetchLogsRange(from, latest, 8000n, 900n, deadlineMs);
    logs = r.logs;
    progress = { lastScannedBlock: r.lastScannedBlock, complete: r.complete };
  } catch (_) {
    logs = await fetchLogsViaBaseScan(from, latest, deadlineMs);
    progress = { lastScannedBlock: latest, complete: true };
  }

  for (const l of logs) {
    const user = addrFromTopic(l.topics?.[1]);
    const payload = extractBytesParamFromLogData(l.data);
    const dec = decodePointsAndWeek(payload);
    if (!dec) continue;

    const wk = Number(dec.week);
    if (wk !== curWeekMs && wk !== prevWeekMs) continue;

    const m = getOrMakeWeekMap(state, wk);
    m.set(user, (m.get(user) || 0n) + dec.points);
  }

  // prune + persist progress
  state.weeks = state.weeks
    .filter((w) => w.weekMs === curWeekMs || w.weekMs === prevWeekMs)
    .map((w) => ({ weekMs: w.weekMs, map: pruneToTop(w.map, PRUNE_KEEP) }));

  // Same safety as backfill: never claim we've processed up to `latest` unless we really did.
  state.lastProcessedBlock = progress.complete ? latest : progress.lastScannedBlock;
  state.updatedAt = nowMs();
  return state;
}

async function getCachedResponse() {
  const v = await storeGetJson(KV_RESP_KEY);
  if (!hasStoreConfigured()) {
    if (!v) return null;
    const age = nowMs() - (MEM_RESP_AT || 0);
    if (age > CACHE_TTL_SECONDS * 1000) return null;
  }
  return v;
}

async function setCachedResponse(resp) {
  await storeSetJson(KV_RESP_KEY, resp, CACHE_TTL_SECONDS);
}

// Main handler
module.exports = async function handler(req, res) {
  const started = nowMs();
  const deadlineMs = started + MAX_SERVERLESS_MS;

  const refresh = String(req.query.refresh || "0") === "1";
  const includeNames = String(req.query.names || "0") === "1";

  try {
    // Fast path: cached response (instant open)
    if (!refresh) {
      const cached = await getCachedResponse();
      if (cached) {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        return res.status(200).send(JSON.stringify(cached));
      }
    }

    // Best-effort lock to prevent stampede on refresh/cron
    const gotLock = await storeAcquireLock(KV_LOCK_KEY, 30);
    if (!gotLock && !refresh) {
      // If we couldn't lock and it's not a forced refresh, return whatever we can
      const cached = await getCachedResponse();
      if (cached) {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        return res.status(200).send(JSON.stringify({ ...cached, meta: { ...cached.meta, busy: true } }));
      }
    }

    const rawState = await storeGetJson(KV_STATE_KEY);
    const state = deserializeState(rawState);

    const updated = await incrementalUpdate(state, deadlineMs);

    let fcMap = null;
    if (includeNames && nowMs() < deadlineMs - 500) {
      const addrs = new Set();
      for (const w of updated.weeks) for (const a of w.map.keys()) addrs.add(a);
      fcMap = await fetchNamesFromNeynar([...addrs]);
    }

    const resp = formatResponsePayload(updated, { includeNames, fcMap });

    // Persist
    await storeSetJson(KV_STATE_KEY, serializeState(updated), STATE_TTL_SECONDS);
    await setCachedResponse(resp);
    await storeReleaseLock(KV_LOCK_KEY);

    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(JSON.stringify(resp));
  } catch (e) {
    // Always attempt to unlock
    try { await storeReleaseLock(KV_LOCK_KEY); } catch (_) {}

    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(
      JSON.stringify({
        ok: false,
        error: e?.message || String(e),
        hint:
          "If this persists: (1) Connect your Upstash Redis to the Vercel project so KV_REST_API_* env vars are present, (2) set RPC_URL to a full-history Base RPC (Alchemy/Ankr/QuickNode or mainnet.base.org), and (3) optionally set BASESCAN_API_KEY to use BaseScan Logs API for backfills.",
      })
    );
  }
};
