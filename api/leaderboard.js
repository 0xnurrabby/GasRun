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


// In-memory fallback (works only per warm serverless instance)
let MEM_STATE = null;
let MEM_RESP = null;
let MEM_RESP_AT = 0;

// Tunables
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour for resp; cron/refresh keeps it hot
const STATE_TTL_SECONDS = 60 * 60 * 24 * 21; // 3 weeks
const MAX_TOP = 100;   // leaderboard UI size
const PRUNE_KEEP = 5000; // keep top N in state to keep KV value small
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
    if (deadlineMs && nowMs() > deadlineMs) break;

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

  for (let from = fromBlock; from <= toBlock; ) {
    if (deadlineMs && nowMs() > deadlineMs) break;

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
      from = to + 1n;
    } catch (e) {
      const msg = (e?.message || "").toLowerCase();

      // Some providers reject *historical* ranges on free tier (shrinking step won't help).
      // Example: "ranges over 10000 blocks are not supported on freetier".
      if (msg.includes("freetier") || msg.includes("not supported on freetier") || msg.includes("ranges over 10000")) {
        throw e;
      }

      // If the provider says the range is too large, shrink the step
      if (msg.includes("range is too large") || msg.includes("max is 1k") || msg.includes("limit") || msg.includes("block range")) {
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
  return logsOut;
}

async function getLatestBlock() {
  const latestHex = await withRpcRotation((url) => rpcCall(url, "eth_blockNumber", []));
  return BigInt(latestHex);
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

function formatResponsePayload(state, { includeNames = false, fcMap = null, viewerAddress = null } = {}) {
  const curMap = state.weeks.find((x) => x.weekMs === state.currentWeekMs)?.map || new Map();
  const prevMap = state.weeks.find((x) => x.weekMs === state.lastWeekMs)?.map || new Map();

const weeklyAll = sortMapToArray(curMap);
const lastWeekAll = sortMapToArray(prevMap);

const weekly = weeklyAll.slice(0, MAX_TOP);
const lastWeek = lastWeekAll.slice(0, MAX_TOP);

const normAddr = (a) => (typeof a === "string" ? a.toLowerCase() : "");
const viewer = (() => {
  const v = normAddr(viewerAddress);
  if (!v || !/^0x[0-9a-f]{40}$/.test(v)) return null;

  const find = (arr) => {
    const i = arr.findIndex((x) => normAddr(x.address) === v);
    if (i < 0) return { rank: null, points: "0" };
    return { rank: i + 1, points: arr[i].points };
  };

  return { address: v, weekly: find(weeklyAll), lastWeek: find(lastWeekAll) };
})();

  const enrich = (arr) =>
    arr.map((it) => {
      if (!includeNames || !fcMap) return it;
      const u = fcMap.get(it.address.toLowerCase());
      return { ...it, name: u ? `${u}.farcaster.eth` : undefined };
    });

  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  const isoDay = (ms) => iso(ms).slice(0, 10);

  return {
    ok: true,
    weekStart: state.currentWeekMs,
    prevWeekStart: state.lastWeekMs,
    // Human-friendly info (kept additive so the game UI doesn't break)
    windows: {
      current: {
        startMs: state.currentWeekMs,
        endMs: state.currentWeekMs + ONE_WEEK,
        startISO: iso(state.currentWeekMs),
        endISO: iso(state.currentWeekMs + ONE_WEEK),
        label: `${isoDay(state.currentWeekMs)} (UTC)`
      },
      previous: {
        startMs: state.lastWeekMs,
        endMs: state.lastWeekMs + ONE_WEEK,
        startISO: iso(state.lastWeekMs),
        endISO: iso(state.lastWeekMs + ONE_WEEK),
        label: `${isoDay(state.lastWeekMs)} (UTC)`
      }
    },
    weekly: enrich(weekly),
    lastWeek: enrich(lastWeek),
    you: viewer || undefined,
    meta: {
      lastProcessedBlock: state.lastProcessedBlock ? state.lastProcessedBlock.toString() : null,
      updatedAt: state.updatedAt,
      counts: { weeklyPlayers: curMap.size, lastWeekPlayers: prevMap.size }
    }
  };
}

async function backfillTwoWeeks(now, deadlineMs) {
  const curWeekMs = weekStartUtcMs(now);
  const prevWeekMs = curWeekMs - 7 * 24 * 60 * 60 * 1000;

  const latest = await getLatestBlock();

  // IMPORTANT:
  // We need to cover *at least* the last 2 weeks of logs.
  // Base L2 block time can vary; 650k blocks is sometimes not enough to cover
  // a full 14 days. If the backfill window is too small, you'll see exactly the
  // bug you reported: Weekly looked huge during the week, but after rollover
  // "Last week" becomes smaller/missing players because early-week logs were
  // outside the backfill window.
  //
  // We intentionally over-shoot and then filter by the on-chain week value.
  const WINDOW = 1200000n;
  const fromBlock = latest > WINDOW ? latest - WINDOW : 0n;

  const state = {
    currentWeekMs: curWeekMs,
    lastWeekMs: prevWeekMs,
    lastProcessedBlock: null,
    weeks: [emptyWeekState(curWeekMs), emptyWeekState(prevWeekMs)],
    updatedAt: nowMs()
  };

  // Prefer BaseScan for large backfills (more reliable on free-tier RPCs). Fallback to RPC.
  let logs = [];
  try {
    logs = await fetchLogsViaBaseScan(fromBlock, latest, deadlineMs);
  } catch (_) {
    logs = await fetchLogsRange(fromBlock, latest, 8000n, 900n, deadlineMs);
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
  state.lastProcessedBlock = latest;
  state.updatedAt = nowMs();
  return state;
}

async function incrementalUpdate(existingState, deadlineMs) {
  const now = nowMs();
  const curWeekMs = weekStartUtcMs(now);
  const prevWeekMs = curWeekMs - 7 * 24 * 60 * 60 * 1000;

  const latest = await getLatestBlock();

  // Cold start or unknown progress => backfill 2 weeks.
  if (!existingState || !existingState.lastProcessedBlock) {
    return await backfillTwoWeeks(now, deadlineMs);
  }

  const state = existingState;

  // ✅ Week rollover handling (snapshot/rotate instead of re-backfill)
  // 
  // The previous implementation re-scanned the last ~2 weeks every Monday.
  // On free RPCs that often times out or returns partial ranges, which creates
  // the exact symptom you saw:
  // - End of week: weekly shows big totals + more players
  // - After rollover: "last week" becomes smaller/missing players
  // 
  // Instead, when the week changes by exactly 1 week, we simply:
  // 1) Move the old current-week map -> last-week map
  // 2) Create a fresh current-week map
  // 3) Keep lastProcessedBlock and keep incrementally applying new logs.
  if (state.currentWeekMs !== curWeekMs) {
    // If we missed multiple week rollovers (server slept for >7 days),
    // snapshotting can't reconstruct the missing history—so we backfill.
    if (state.currentWeekMs !== prevWeekMs) {
      return await backfillTwoWeeks(now, deadlineMs);
    }

    const oldCurrentMs = state.currentWeekMs;
    const oldCurrentMap = getOrMakeWeekMap(state, oldCurrentMs);

    state.currentWeekMs = curWeekMs;
    state.lastWeekMs = prevWeekMs;
    state.weeks = [
      { weekMs: curWeekMs, map: new Map() },
      { weekMs: prevWeekMs, map: oldCurrentMap }
    ];
  } else {
    state.currentWeekMs = curWeekMs;
    state.lastWeekMs = prevWeekMs;
  }

  const from = state.lastProcessedBlock + 1n;
  if (from > latest) {
    state.updatedAt = nowMs();
    return state;
  }

  // For incremental updates, RPC is usually fine, but fallback to BaseScan if needed.
  let logs = [];
  try {
    logs = await fetchLogsRange(from, latest, 8000n, 900n, deadlineMs);
  } catch (_) {
    logs = await fetchLogsViaBaseScan(from, latest, deadlineMs);
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

  state.lastProcessedBlock = latest;
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

const addressRaw = String(req.query.address || "").trim();
const viewerAddress = /^0x[a-fA-F0-9]{40}$/.test(addressRaw) ? addressRaw : null;

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

    const resp = formatResponsePayload(updated, { includeNames, fcMap, viewerAddress });

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
