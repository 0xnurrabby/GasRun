/**
 * STARTUP OPTIMIZATION
 * - Render the game immediately (no remote ESM imports at module-eval time).
 * - Mini App SDK is loaded via <script defer ...> in index.html.
 * - Heavy web3 deps (viem + ox) are loaded lazily while the user is already playing.
 */
function _getSdkSync() {
  return (window.miniapp && window.miniapp.sdk) || (window.frame && window.frame.sdk) || null;
}
let sdk = _getSdkSync();
let _sdkWaitPromise = null;

async function ensureSdk(timeoutMs = 12000) {
  if (sdk) return sdk;
  if (_sdkWaitPromise) return _sdkWaitPromise;
  _sdkWaitPromise = new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      sdk = _getSdkSync();
      if (sdk) return resolve(sdk);
      if (performance.now() - start > timeoutMs) return reject(new Error("Mini App SDK not available"));
      setTimeout(poll, 10);
    })();
  });
  return _sdkWaitPromise;
}

// Lazy web3 deps (only needed for connect/commit/chain ops)
let Attribution = null;
let encodeAbiParameters = null;
let encodeFunctionData = null;

// Warm status for "Deposit Saved points" button.
// Goal: game renders instantly, but deposit becomes usable ASAP in the background.
let web3WarmReady = false;
let web3WarmPromise = null;

let _viemPromise = null;
async function ensureViem() {
  if (encodeAbiParameters && encodeFunctionData) return;
  _viemPromise = _viemPromise || import("https://esm.sh/viem@2.21.0");
  const m = await _viemPromise;
  encodeAbiParameters = m.encodeAbiParameters;
  encodeFunctionData = m.encodeFunctionData;
}

let dataSuffix = null;
let _oxPromise = null;
async function ensureAttribution() {
  if (dataSuffix) return;
  _oxPromise = _oxPromise || import("https://esm.sh/ox/erc8021");
  const m = await _oxPromise;
  Attribution = m.Attribution;
  // BUILDER_CODE is defined below (hard input)
  dataSuffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });
}

// One shared "warm" promise so clicks feel instant even if the deps are still loading.
function warmWeb3Deps() {
  if (web3WarmReady) return Promise.resolve();
  web3WarmPromise =
    web3WarmPromise ||
    Promise.all([ensureAttribution(), ensureViem()])
      .then(() => {
        web3WarmReady = true;
      })
      .catch(() => {
        // Keep the game running even if warmup fails; commit will show a real error later.
      });
  return web3WarmPromise;
}

// Kick off background loading *after first paint* (doesn't block UI)
function prefetchWeb3Deps() {
  const start = () => {
    // fire-and-forget; keep UI responsive
    warmWeb3Deps();
  };
  // Prefer idle time so first render stays snappy, but don't wait too long.
  if ("requestIdleCallback" in window) {
    // @ts-ignore
    requestIdleCallback(start, { timeout: 300 });
  } else {
    requestAnimationFrame(() => setTimeout(start, 60));
  }
}

// =====================================================
// HARD INPUTS
// =====================================================
const TOP_TITLE = "👈🏻Click for m0re Dear";
const HUD_TITLE = "Live Statistics";
const HOME_URL = "https://gasrun.vercel.app/";

function colorizeMinecraftText(str) {
  // digits + common symbols => red
  const re = /[0-9$+*\-%=]/g;
  return String(str).replace(re, (m) => `<span class="mcRed">${m}</span>`);
}

let crashAnimStart = 0;
let wasGameOver = false;

let weekCountdownRAF = 0;
let weekCountdownActive = false;

const BASE_CHAIN_ID_HEX = "0x2105";
const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// Builder Code from your screenshot (must match Base.dev)
const BUILDER_CODE = "bc_frzfbuzy";
/* dataSuffix is computed lazily via ensureAttribution() */
// On-chain action name (bytes32)
function _stringToBytes32Hex(str) {
  const enc = new TextEncoder();
  const bytes = enc.encode(String(str));
  if (bytes.length > 32) throw new Error("bytes32 overflow");
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  hex += "00".repeat(32 - bytes.length);
  return "0x" + hex;
}

// On-chain action name (bytes32)
const ACTION_WEEKLY_ADD = _stringToBytes32Hex("WEEKLY_ADD");

// Event ABI
// Event ABI (lazy-parse if needed later)
const ACTION_LOGGED_EVENT_ABI = "event ActionLogged(address indexed user, bytes32 indexed action, uint256 timestamp, bytes data)";
let ACTION_LOGGED_EVENT = null;
// =====================================================
// UI
// =====================================================
const app = document.getElementById("app");
app.innerHTML = `
  <div class="shell">
    <div class="topbar">
      <button class="iconBtn" id="menuBtn" aria-label="Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="title mcFont">${colorizeMinecraftText(TOP_TITLE)}</div>
      <button class="badge" id="statusBadge">Loading…</button>
    </div>

    <div class="gameCard">
      <div class="canvasWrap">
        <canvas id="c"></canvas>
      </div>

      <div class="hud" id="hud">
        <div class="hudTitle">${HUD_TITLE}</div>
        <div class="hudRow">
          <div>Run: <b id="runScore">0</b></div>
          <div>Coins: <b id="coins">0</b></div>
        </div>
        <div class="hudRow" style="margin-top:8px">
          <div>Bank: <b id="bankPoints">0</b></div>
          <div>Boost: <b id="boost">—</b></div>
        </div>
      </div>

      <div class="toast" id="toast"></div>
    </div>

    <div class="bottomBar">
      <div class="controls">
        <button class="ctrlBtn" id="leftBtn" aria-label="Move Left">
          <span class="ctrlIcon">◀</span><span class="ctrlText">Left</span>
        </button>
        <button class="ctrlBtn primary" id="saveBtn" aria-label="Save Points">
          <span class="ctrlText">💾Save</span>
        </button>
        <button class="ctrlBtn" id="rightBtn" aria-label="Move Right">
          <span class="ctrlText">Right</span><span class="ctrlIcon">▶</span>
        </button>
      </div>
    </div>

    <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="sheetPanel">
        <div class="sheetHeader">
          <h3 id="sheetTitle">Menu</h3>
          <button class="iconBtn" id="closeSheet" aria-label="Close">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="sheetBody" id="sheetBody"></div>
      </div>
    </div>
  </div>
`;

const els = {
  statusBadge: $("#statusBadge"),
  sheet: $("#sheet"),
  sheetTitle: $("#sheetTitle"),
  sheetBody: $("#sheetBody"),
  toast: $("#toast"),
  c: $("#c"),
  runScore: $("#runScore"),
  coins: $("#coins"),
  bankPoints: $("#bankPoints"),
  boost: $("#boost"),
  menuBtn: $("#menuBtn"),
  closeSheet: $("#closeSheet"),
  leftBtn: $("#leftBtn"),
  rightBtn: $("#rightBtn"),
  saveBtn: $("#saveBtn")
};

function $(sel) {
  return document.querySelector(sel);
}

function toast(msg, ms = 1800) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}

// =====================================================
// Audio + Haptics (coin sfx, background music, vibration)
// Notes:
// - Mobile browsers block autoplay. We "unlock" audio on the first user gesture.
// - Vibration is best-effort (only works where supported).
// =====================================================
const AUDIO = {
  unlocked: false,
  coinPool: [],
  coinIdx: 0,
  bgm: null
};

function setupAudio() {
  if (AUDIO.coinPool.length) return;

  // Coin SFX pool (allows rapid consecutive plays)
  for (let i = 0; i < 5; i++) {
    const a = new Audio("/assets/coin.mp3");
    a.preload = "auto";
    a.volume = 0.20; // ✅ 50% lower than 0.40
    AUDIO.coinPool.push(a);
  }

  // Background music
  AUDIO.bgm = new Audio("/assets/bgm.mp3");
  AUDIO.bgm.preload = "auto";
  AUDIO.bgm.loop = true;
  AUDIO.bgm.volume = 0.32;
}

async function ensureAudioUnlocked() {
  setupAudio();
  if (AUDIO.unlocked) return;

  try {
    // Attempt a silent play/pause to unlock audio on iOS/Android.
    const a = AUDIO.coinPool[0];
    a.muted = true;
    await a.play();
    a.pause();
    a.currentTime = 0;
    a.muted = false;
    AUDIO.unlocked = true;
  } catch {
    AUDIO.unlocked = false;
  }

  if (AUDIO.unlocked) startBgm();
}

function startBgm() {
  setupAudio();
  if (!AUDIO.unlocked || !AUDIO.bgm) return;
  if (!AUDIO.bgm.paused) return;

  AUDIO.bgm.currentTime = 0;
  AUDIO.bgm.play().catch(() => {});
}

function stopBgm() {
  if (!AUDIO.bgm) return;
  try {
    AUDIO.bgm.pause();
  } catch {}
}

function playCoinSfx() {
  if (!AUDIO.unlocked || !AUDIO.coinPool.length) return;
  const a = AUDIO.coinPool[AUDIO.coinIdx % AUDIO.coinPool.length];
  AUDIO.coinIdx++;
  try {
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {}
}

function vibrate(pattern) {
  // 1) Standard Web Vibration API (works mostly on Android Chrome, some in-app browsers)
  try {
    if (navigator && typeof navigator.vibrate === "function") {
      return navigator.vibrate(pattern);
    }
  } catch {}

  // 2) Farcaster miniapp SDK fallback (best effort)
  try {
    const p = Array.isArray(pattern) ? pattern[0] : pattern;
    if (sdk?.actions?.haptics?.impact) {
      const type = p >= 60 ? "medium" : "light";
      (sdk || _getSdkSync())?.actions?.haptics?.impact?.(type);
      return true;
    }
    if (sdk?.actions?.haptics?.notification) {
      (sdk || _getSdkSync())?.actions?.haptics?.notification?.("success");
      return true;
    }
  } catch {}

  return false;
}

// ✅ Missing functions added
function hapticTap() {
  vibrate(12);
}
function crashVibe() {
  vibrate([55, 30, 55]);
}

// =====================================================
// Mini App READY (MANDATORY)
// - called ASAP from index.html when SDK loads (to hide splash)
// - we also attempt here as a fallback (non-blocking)
// =====================================================
(async () => {
  try {
    els.statusBadge.textContent = "Connect";
    const s = await ensureSdk();
    // idempotent in hosts; safe to call twice
    await s.actions.ready({ disableNativeGestures: true });
  } catch {
    // don't block game if SDK isn't present (e.g., opened in normal browser)
    els.statusBadge.textContent = "Connect";
  }
})();

// Start background loading of heavy deps while the user plays
prefetchWeb3Deps();

// =====================================================
// Wallet / Chain
// =====================================================
let ethProvider = null;
let account = null;

async function getProvider() {
  if (ethProvider) return ethProvider;
  try {
    const s = await ensureSdk();
    ethProvider = await s.wallet.getEthereumProvider();
    return ethProvider;
  } catch {
    return null;
  }
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

let fcUsername = null;
let fcFid = null;

function _toStr(v) {
  if (typeof v === "string") return v;
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "object") {
    if (typeof v.username === "string") return v.username;
    if (typeof v.displayName === "string") return v.displayName;
    if (typeof v.name === "string") return v.name;
  }
  return null;
}

async function getFcUsername() {
  if (fcUsername !== null) return fcUsername;
  try {
    const s = await ensureSdk().catch(() => null);
const ctx =
  (s && s.context) ||
  (s && s.actions && (await s.actions.getContext?.())) ||
  null;
    const u = ctx?.user || ctx?.context?.user || null;
    fcUsername = _toStr(u?.username ?? u?.displayName ?? u?.name ?? null);
    fcFid = u?.fid ?? ctx?.fid ?? ctx?.userFid ?? null;
  } catch {
    fcUsername = null;
  }
  return fcUsername;
}

async function getFcFid() {
  if (fcFid !== null) return fcFid;
  await getFcUsername();
  return fcFid;
}

async function displayNameFor(addr) {
  // Try cached mapping first (localStorage). We also sanitize old/bad cached values
  // like "@[object Object]" from earlier builds.
  try {
    const raw = localStorage.getItem("addrNameMap");
    if (raw) {
      const m = JSON.parse(raw);
      const k = String(addr || "").toLowerCase();
      let v = m?.[k];

      // Normalize objects/invalid strings
      if (typeof v === "object" && v) v = v.username || v.displayName || v.name || null;
      if (typeof v === "string") {
        const vv = v.trim();
        const bad = !vv || vv.includes("[object Object]") || vv.length > 80;
        if (!bad) return vv;
        // delete bad cached value so it won't keep showing
        try {
          delete m[k];
          localStorage.setItem("addrNameMap", JSON.stringify(m));
        } catch {}
      }
    }
  } catch {}

  // For the connected account, try Farcaster username (if available)
  if (account && addr && addr.toLowerCase() === account.toLowerCase()) {
    const u = await getFcUsername();
    if (typeof u === "string") {
      const uu = u.trim().replace(/^@+/, "");
      if (uu && !uu.includes("[object Object]")) return `@${uu}`;
    }
  }

  // Fallback: show FULL address (not truncated).
  return addr ? String(addr) : "";
}


function fmtPts(n) {
  const s = (typeof n === "bigint" ? n : BigInt(n || 0)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function renderStatus() {
  if (!account) {
    els.statusBadge.textContent = "Connect";
    return;
  }
  els.statusBadge.textContent = `${shortAddr(account)} (Base)`;
}

async function connectWallet() {
  const p = await getProvider();
  if (!p) {
    toast("Open inside Farcaster/Base Mini App to connect wallet.");
    return null;
  }
  const accs = await p.request({ method: "eth_requestAccounts", params: [] });
  account = accs?.[0] || null;
  try {
    const u = await getFcUsername();
    if (typeof u === "string" && account) {
      const uu = u.trim().replace(/^@+/, "");
      const raw = localStorage.getItem("addrNameMap");
      const m = raw ? JSON.parse(raw) : {};
      if (uu && !uu.includes("[object Object]")) {
        m[String(account).toLowerCase()] = `@${uu}`;
      } else {
        // If username is missing/invalid, remove any previously cached bad value.
        delete m[String(account).toLowerCase()];
      }
      localStorage.setItem("addrNameMap", JSON.stringify(m));
    }
  } catch {}
  renderStatus();
  return account;
}

async function ensureBase() {
  const p = await getProvider();
  if (!p) throw new Error("No provider");
  const chainId = await p.request({ method: "eth_chainId", params: [] });
  if (chainId === BASE_CHAIN_ID_HEX) return;
  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }]
    });
  } catch {
    throw new Error("Please switch your wallet to Base Mainnet (0x2105).");
  }
}

// =====================================================
// Time windows (Weekly reset) + Boost rhythm
// =====================================================
function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 Sun..6 Sat
  const diffToMon = (day + 6) % 7; // days since Monday
  const mon = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0)
  );
  return mon.getTime();
}

function weekIdUtc(now = Date.now()) {
  return new Date(weekStartUtcMs(now)).toISOString().slice(0, 10);
}
function weekEndUtcMs(now = Date.now()) {
  return weekStartUtcMs(now) + 7 * 24 * 60 * 60 * 1000;
}

function fmtCountdown(ms) {
  ms = Math.max(0, ms);
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const hr = totalHr % 24;
  const days = Math.floor(totalHr / 24);
  const pad = (n) => String(n).padStart(2, "0");
  return days > 0
    ? `${days}d ${pad(hr)}:${pad(min)}:${pad(sec)}`
    : `${pad(hr)}:${pad(min)}:${pad(sec)}`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function renderSevenSeg(canvas, text, pulse = 1) {
  if (!canvas) return;
  const str = String(text);

  // layout in CSS pixels
  const cssH = 16;                 // height of digits
  const segT = Math.max(2, cssH * 0.18);
  const digitW = cssH * 0.62;
  const gap = cssH * 0.18;
  const colonW = cssH * 0.22;

  const charW = (ch) => {
    if (ch === ":") return colonW + gap;
    if (ch === " ") return gap * 0.8;
    return digitW + gap;
  };

  let cssW = 2; // padding start
  for (const ch of str) cssW += charW(ch);
  cssW += 2; // padding end

  // prepare canvas with DPR scaling
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = cssH + "px";
  canvas.style.width = cssW + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const onTop = "rgba(255,70,70,1)";
  const onBot = "rgba(160,0,0,1)";
  const off = "rgba(255,70,70,0.10)";

  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, onTop);
  grad.addColorStop(1, onBot);

  const litAlpha = 0.78 + 0.22 * pulse;

  function drawSeg(x, y, w, h, lit) {
    roundRectPath(ctx, x, y, w, h, segT * 0.45);
    if (lit) {
      ctx.save();
      ctx.globalAlpha = litAlpha;
      ctx.shadowBlur = 10 + 10 * pulse;
      ctx.shadowColor = "rgba(255,70,70,0.55)";
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = off;
      ctx.fill();
      ctx.restore();
    }
  }

  const DIGITS = {
    "0": ["a", "b", "c", "d", "e", "f"],
    "1": ["b", "c"],
    "2": ["a", "b", "g", "e", "d"],
    "3": ["a", "b", "g", "c", "d"],
    "4": ["f", "g", "b", "c"],
    "5": ["a", "f", "g", "c", "d"],
    "6": ["a", "f", "g", "e", "c", "d"],
    "7": ["a", "b", "c"],
    "8": ["a", "b", "c", "d", "e", "f", "g"],
    "9": ["a", "b", "c", "d", "f", "g"],
    // seven-seg lowercase d: b,c,d,e,g
    "d": ["b", "c", "d", "e", "g"]
  };

  function drawChar(ch, x) {
    if (ch === " ") return x + charW(ch);
    if (ch === ":") {
      const r = segT * 0.45;
      const cx = x + colonW * 0.5;
      const y1 = cssH * 0.35;
      const y2 = cssH * 0.68;

      ctx.save();
      ctx.globalAlpha = 0.75 + 0.25 * pulse;
      ctx.shadowBlur = 8 + 8 * pulse;
      ctx.shadowColor = "rgba(255,70,70,0.45)";
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, y1, r, 0, Math.PI * 2);
      ctx.arc(cx, y2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      return x + charW(ch);
    }

    const segs = DIGITS[ch] || DIGITS["0"];
    const lit = (name) => segs.includes(name);

    const topY = 0;
    const midY = cssH * 0.5;
    const botY = cssH;

    const x0 = x;
    const w = digitW;
    const t = segT;

    // horizontals
    drawSeg(x0 + t, topY + 0.5, w - 2 * t, t, lit("a"));
    drawSeg(x0 + t, midY - t / 2, w - 2 * t, t, lit("g"));
    drawSeg(x0 + t, botY - t - 0.5, w - 2 * t, t, lit("d"));

    // verticals (upper)
    drawSeg(x0 + 0.5, topY + t, t, midY - 1.5 * t, lit("f"));
    drawSeg(x0 + w - t - 0.5, topY + t, t, midY - 1.5 * t, lit("b"));

    // verticals (lower)
    drawSeg(x0 + 0.5, midY + t * 0.5, t, midY - 1.5 * t, lit("e"));
    drawSeg(x0 + w - t - 0.5, midY + t * 0.5, t, midY - 1.5 * t, lit("c"));

    return x + charW(ch);
  }

  let x = 2;
  for (const ch of str) x = drawChar(ch, x);
}

function updateWeekCountdownCanvases(nowPerf) {
  const now = Date.now();
  const remain = weekEndUtcMs(now) - now;

  // Smooth pulse for premium feel
  const pulse = 0.75 + 0.25 * Math.sin(nowPerf / 380);
  const str = remain <= 0 ? "00:00:00" : fmtCountdown(remain);

  const c1 = $("#weekCountdownSeg");
  if (c1) renderSevenSeg(c1, str, pulse);

  const c2 = $("#weekCountdownBoardsSeg");
  if (c2) renderSevenSeg(c2, str, pulse);
}

function tickWeekCountdown(nowPerf) {
  if (!weekCountdownActive) return;
  updateWeekCountdownCanvases(nowPerf);
  weekCountdownRAF = requestAnimationFrame(tickWeekCountdown);
}

function startWeekCountdown() {
  stopWeekCountdown();
  weekCountdownActive = true;
  weekCountdownRAF = requestAnimationFrame(tickWeekCountdown);
}

function stopWeekCountdown() {
  weekCountdownActive = false;
  if (weekCountdownRAF) cancelAnimationFrame(weekCountdownRAF);
  weekCountdownRAF = 0;
}



function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hoursToMs(h) {
  return h * 60 * 60 * 1000;
}

// =====================================================
// Off-chain Profile: banked points + coins + decay
// =====================================================
const DECAY_INTERVAL_MS = 10 * 60 * 1000;
const DECAY_MULT = 0.75;

const profile = {
  bankPoints: Number(localStorage.getItem("w3r_bank") || "0"),
  coins: Number(localStorage.getItem("w3r_coins") || "0"),
  lastDecayAt: Number(localStorage.getItem("w3r_decay_at") || "0"),
  boostReadyAt: Number(localStorage.getItem("w3r_boost_ready_at") || "0"),
  boostActiveUntil: Number(localStorage.getItem("w3r_boost_active_until") || "0"),
  boostMult: 1
};

function persistProfile() {
  localStorage.setItem("w3r_bank", String(Math.floor(profile.bankPoints)));
  localStorage.setItem("w3r_coins", String(Math.floor(profile.coins)));
  localStorage.setItem("w3r_decay_at", String(profile.lastDecayAt));
  localStorage.setItem("w3r_boost_ready_at", String(profile.boostReadyAt));
  localStorage.setItem("w3r_boost_active_until", String(profile.boostActiveUntil));
}

function applyDecay(now = Date.now()) {
  if (!profile.lastDecayAt) {
    profile.lastDecayAt = now;
    persistProfile();
    return;
  }
  if (profile.bankPoints <= 0) {
    profile.lastDecayAt = now;
    persistProfile();
    return;
  }

  const elapsed = now - profile.lastDecayAt;
  if (elapsed < DECAY_INTERVAL_MS) return;

  const steps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  profile.bankPoints = profile.bankPoints * Math.pow(DECAY_MULT, steps);
  profile.lastDecayAt += steps * DECAY_INTERVAL_MS;
  persistProfile();
}

function computeBoost(now = Date.now()) {
  if (!profile.boostReadyAt) {
    profile.boostReadyAt = now + hoursToMs(randInt(2, 6));
    persistProfile();
  }

  if (profile.boostActiveUntil && now < profile.boostActiveUntil) {
    profile.boostMult = 1.25;
    return;
  }

  if (now >= profile.boostReadyAt) {
    profile.boostActiveUntil = now + 5 * 60 * 1000;
    profile.boostReadyAt = now + hoursToMs(randInt(2, 6));
    persistProfile();
    toast("Boost active! +25% points for 5 minutes");
    profile.boostMult = 1.25;
    return;
  }

  profile.boostMult = 1.0;
}

function boostCountdownText(now = Date.now()) {
  if (profile.boostActiveUntil && now < profile.boostActiveUntil) {
    const ms = profile.boostActiveUntil - now;
    const m = Math.max(0, Math.floor(ms / 60000));
    const s = Math.max(0, Math.floor((ms % 60000) / 1000));
    return `ON ${m}m ${s}s`;
  }
  const ms = Math.max(0, profile.boostReadyAt - now);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// =====================================================
// GAME: 4-lane runner
// =====================================================
const game = {
  started: false,
  over: false,
  lane: 1,
  runScore: 0,
  t: 0,
  speed: 1.0,
  obstacles: [],
  coins: [],
  lastSpawnAt: 0,
  lastCoinAt: 0,
  lastPowerAt: 0,
  // last time a powerup actually spawned (used for "pity" so powerups don't disappear late-game)
  lastPowerSpawnedAt: 0,
  magnetUntil: 0,
  slowUntil: 0,
  shieldUntil: 0,
  dblUntil: 0,
  lastFrame: performance.now()
};

function resetRun() {
  game.started = true;
  game.over = false;
  game.lane = 1;
  game.runScore = 0;
  game.t = 0;
  game.speed = 1.0;
  game.obstacles = [];
  game.coins = [];
  game.lastSpawnAt = 0;
  game.lastCoinAt = 0;
  game.lastPowerAt = 0;
  game.lastPowerSpawnedAt = 0;

  // Reset powerups so new runs behave consistently
  game.magnetUntil = 0;
  game.slowUntil = 0;
  game.shieldUntil = 0;
  game.dblUntil = 0;

  startBgm();
}
resetRun();

function saveRunToBank() {
  applyDecay();
  if (game.runScore <= 0) {
    toast("No points to save");
    return;
  }
  profile.bankPoints += game.runScore;
  game.runScore = 0;
  persistProfile();
  toast("Saved");
}

function convertCoinsToBank() {
  applyDecay();
  if (profile.coins <= 0) {
    toast("No coins to convert");
    return;
  }
  const pts = profile.coins * 10;
  profile.coins = 0;
  profile.bankPoints += pts;
  persistProfile();
  toast(`Converted +${pts} points`);
}

// =====================================================
// LEADERBOARD API
// =====================================================
async function fetchLeaderboard({ refresh = false, names = false } = {}) {
  const qs = new URLSearchParams();
  if (refresh) qs.set("refresh", "1");
  qs.set("names", names ? "1" : "0");

  const url = `/api/leaderboard?${qs.toString()}`;
  const res = await fetch(url, { cache: "no-store" });

  const j = await res.json().catch(() => ({}));
  if (!j || j.ok !== true) {
    const msg = (j && (j.error || j.hint)) ? `${j.error || "Leaderboard error"}${j.hint ? `\n${j.hint}` : ""}` : "Leaderboard API failed";
    throw new Error(msg);
  }

  const normalize = (arr) =>
    (arr || []).map((x) => ({
      addr: x.address,
      pts: BigInt(x.points),
      name: x.name
    }));

  return {
    weekStart: j.weekStart,
    prevWeekStart: j.prevWeekStart,
    weeklySorted: normalize(j.weekly),
    prevWeekSorted: normalize(j.lastWeek),
    meta: j.meta
  };
}

// =====================================================
// On-chain Commit
// =====================================================
let commitInFlight = false;

async function commitWeeklyOnchain() {
  applyDecay();

  if (!account) {
    await connectWallet();
    if (!account) return;
  }

  const pts = Math.floor(profile.bankPoints);
  if (pts <= 0) {
    toast("Bank is empty");
    return;
  }

  if (commitInFlight) return;
  commitInFlight = true;

  // Give immediate feedback even if the background web3 warmup hasn't finished yet.
  const commitBtn = document.getElementById("btnCommit");
  const prevBtnText = commitBtn ? commitBtn.textContent : "";
  if (commitBtn) {
    commitBtn.disabled = true;
    commitBtn.textContent = "Preparing…";
  }
  toast("Preparing deposit…", 1200);
  // Let the UI paint the new button state/toast before heavy module evaluation.
  await new Promise((r) => requestAnimationFrame(() => r()));

  try {
    await ensureBase();

    // Ensure web3 encoders + builder dataSuffix are available (prefetched in background when possible)
    await warmWeb3Deps();

    const p = await getProvider();
    if (!p) throw new Error("No provider");

    const chainId = await p.request({ method: "eth_chainId", params: [] });

    const weekStart = weekStartUtcMs();
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [BigInt(pts), BigInt(weekStart)]
    );

    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "logAction",
          stateMutability: "nonpayable",
          inputs: [
            { name: "action", type: "bytes32" },
            { name: "data", type: "bytes" }
          ],
          outputs: []
        }
      ],
      functionName: "logAction",
      args: [ACTION_WEEKLY_ADD, payload]
    });

    const params = {
      version: "2.0.0",
      from: account,
      chainId,
      atomicRequired: true,
      calls: [{ to: CONTRACT, value: "0x0", data }],
      capabilities: (dataSuffix ? { dataSuffix } : undefined)
    };

    try {
      await p.request({ method: "wallet_sendCalls", params: [params] });
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("rejected")) {
        toast("Transaction rejected");
        return;
      }
      await p.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: CONTRACT, value: "0x0", data }]
      });
    }

    profile.bankPoints = 0;
    persistProfile();
    toast("Committed on-chain! Updating leaderboard…", 2200);

    if (isSheetOpen()) await openLeaderboardsView();
  } catch (e) {
    toast(e?.message ? String(e.message) : "Commit failed");
  } finally {
    commitInFlight = false;
    if (commitBtn) {
      commitBtn.disabled = false;
      commitBtn.textContent = prevBtnText || "Deposit Saved points → Weekly leaderboard ( Important )";
    }
  }
}

// =====================================================
// Controls: instant + no double triggers
// =====================================================
function bindInstantTap(btn, fn) {
  btn.style.touchAction = "none";

  const onPointerDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ensureAudioUnlocked();
    // Start warming web3 deps on the first real user gesture (doesn't block the tap).
    // This makes the Deposit button feel instant after a short play session.
    warmWeb3Deps();
    fn();
  };

  btn.addEventListener("pointerdown", onPointerDown, { passive: false });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

function moveLane(delta) {
  if (game.over) return;
  const step = isDoubleLaneOn() ? 2 : 1;
  const next = Math.max(0, Math.min(3, game.lane + delta * step));
  game.lane = next;
}

bindInstantTap(els.leftBtn, () => {
  hapticTap();
  moveLane(-1);
});
bindInstantTap(els.rightBtn, () => {
  hapticTap();
  moveLane(+1);
});
bindInstantTap(els.saveBtn, () => saveRunToBank());

// =====================================================
// Menu sheet
// =====================================================
function isSheetOpen() {
  return els.sheet.classList.contains("open");
}

function openSheet(title, bodyHtml, viewKey = "") {
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = bodyHtml;
  // Used for view-specific styling (e.g., leaderboards scroll behavior)
  if (viewKey) els.sheet.dataset.view = viewKey;
  else delete els.sheet.dataset.view;
  els.sheet.classList.add("open");
  els.sheet.setAttribute("aria-hidden", "false");
}

function closeSheet() {
  els.sheet.classList.remove("open");
  els.sheet.setAttribute("aria-hidden", "true");
  stopWeekCountdown();
}

els.menuBtn.addEventListener("click", async () => {
  applyDecay();
  computeBoost();
  renderHud();
  openMainMenu();
});
els.closeSheet.addEventListener("click", closeSheet);
els.sheet.addEventListener("click", (e) => {
  if (e.target === els.sheet) closeSheet();
});
els.statusBadge.addEventListener("click", async () => {
  if (!account) await connectWallet();
  renderStatus();
});

function openMainMenu() {
  // User is about to interact with wallet/deposit; warm deps aggressively but non-blocking.
  warmWeb3Deps();
  const walletLine = account ? shortAddr(account) : "Not connected";
  const week = weekIdUtc();

  openSheet(
    "Menu",
    `
    <div class="menuGrid">
      <div class="kv"><div class="k">Wallet</div><div class="v">${walletLine}</div></div>
      <div class="kv"><div class="k">Week</div><div class="v">${week} (UTC) <span class="weekCountdownWrap">(<canvas id="weekCountdownSeg" class="segCanvas" aria-label="Week remaining"></canvas>)</span></div></div>
      <div class="kv"><div class="k">Run points</div><div class="v">${Math.floor(game.runScore)}</div></div>
      <div class="kv"><div class="k">Saved points</div><div class="v">${Math.floor(profile.bankPoints)}</div></div>
      <div class="kv"><div class="k">Coins</div><div class="v">${Math.floor(profile.coins)} (→ ${Math.floor(profile.coins) * 10} pts)</div></div>
      <div class="kv"><div class="k">⚠️Saved points deduction</div><div class="v">-25% every 10 min</div></div>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnConnect">${account ? "Reconnect" : "Connect wallet"}</button>
      <button class="pill" id="btnLeaderboards">Leaderboards</button>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnConvert">Convert coins → points</button>
      <button class="pill pillHow" id="btnHow">
        <img class="pillIcon" src="/assets/bag.png" alt="" aria-hidden="true" />
        Earn
      </button>
    </div>

    <div class="commitWrap">
      <button class="pill primary" id="btnCommit">Deposit Saved points → Weekly leaderboard ( Important )</button>
    </div>

    <div class="alertRed">
  ⚠️ Important: Please Deposit your Saved points within every 10 min. If you don't,  25% percent of your saved points will be deducted every 10 minutes!
</div>
  `,
    "menu"
  );

  startWeekCountdown();

  $("#btnConnect").addEventListener("click", async () => {
    await connectWallet();
    renderStatus();
    openMainMenu();
  });

  $("#btnLeaderboards").addEventListener("click", openLeaderboardsView);
  $("#btnConvert").addEventListener("click", () => {
    convertCoinsToBank();
    openMainMenu();
  });
  $("#btnHow").addEventListener("click", openHowView);

  const commitBtn = $("#btnCommit");
  commitBtn.addEventListener(
    "pointerdown",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      commitWeeklyOnchain();
    },
    { passive: false }
  );
  commitBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    commitWeeklyOnchain();
  });
}

function openHowView() {
  openSheet(
    "Earn & Know how it works",
    `
    <div class="copy">
      <p><b>Play short runs.</b> Your <b>Run</b> points grow while you survive.</p>
      <p><b>Save</b> moves Run → <b>Bank</b> instantly (no transaction).</p>
      <p><b>Bank decays</b>: every <b>15 minutes</b>, Bank is reduced by <b>25%</b>.</p>
      <p><b>Coins</b>: 1 coin = <b>10 points</b>. Convert from the Menu.</p>
      <p><b>Commit</b> is optional and on-chain. It adds your current Bank to your <b>Weekly public leaderboard</b>.</p>
    </div>
    <div class="btnRow">
      <button class="pill" id="backMenu">Back</button>
      <button class="pill" id="goBoards">Leaderboards</button>
    </div>
  `,
    "how"
  );
  $("#backMenu").addEventListener("click", openMainMenu);
  $("#goBoards").addEventListener("click", openLeaderboardsView);
}

let boardsInFlight = false;

function topN(list, n) {
  return list.slice(0, n);
}

async function openLeaderboardsView(forceRefresh = false) {
  if (boardsInFlight) return;
  boardsInFlight = true;

  openSheet(
    "Leaderboards",
    `
    <div class="copy" style="opacity:.9">Loading on-chain leaderboard…</div>
    <div class="btnRow" style="margin-top:12px">
      <button class="pill" id="backMenu">Back</button>
      <button class="pill" id="refreshBoards">Refresh</button>
    </div>
    <div id="boards" class="boardsWrap"></div>
  `,
    "boards"
  );

  $("#backMenu").addEventListener("click", openMainMenu);
  $("#refreshBoards").addEventListener("click", () => openLeaderboardsView(true));

  try {
    const data = await fetchLeaderboard({ refresh: forceRefresh, names: false });
    const { weekStart, prevWeekStart, weeklySorted, prevWeekSorted } = data;

    const weekLabel = new Date(weekStart).toISOString().slice(0, 10);
    const lastWeekLabel = new Date(prevWeekStart).toISOString().slice(0, 10);

    const weeklyTop = topN(weeklySorted, 100);
        // Show previous week's leaderboard too (scrollable like the other sections)
    const lastWinners = topN(prevWeekSorted, 100);

    const weeklyIndex = account
      ? weeklySorted.findIndex((x) => x.addr.toLowerCase() === account.toLowerCase())
      : -1;
    const yourWeeklyRank = weeklyIndex >= 0 ? weeklyIndex + 1 : null;
    const yourWeeklyPts = weeklyIndex >= 0 ? weeklySorted[weeklyIndex].pts : 0n;

    const paletteForIndex = (i) => {
      // Golden-angle sequence spreads hues nicely even for 100 entries.
      const hue = (i * 137.508) % 360;
      const sat = 58;
      // Keep colors pleasant: not too deep, not too light.
      // - text: readable on dark background
      // - row*: subtle full-row tint for "Last week" section
      const h = hue.toFixed(1);
      return {
        text: `hsl(${h}, ${sat}%, 45%)`,
        // kept for backwards-compat (address pill mode)
        bg: `hsl(${h}, ${sat}%, 83%)`,

        rowBg: `hsla(${h}, ${sat}%, 18%, 0.70)`,
        rowBg2: `hsla(${h}, ${sat}%, 24%, 0.26)`,
        rowBorder: `hsla(${h}, ${sat}%, 55%, 0.28)`,
        rowGlow: `hsla(${h}, ${sat}%, 55%, 0.18)`
      };
    };

    const renderList = async (items, opts = {}) => {
      const showFullAddr = !!opts.showFullAddr;
      const colorMode = opts.colorMode || null; // "text" | "bg" | "row" | null

      const rows = await Promise.all(
        items.map(async (x, i) => {
          const nameRaw = (typeof x.name === "string" && x.name && !String(x.name).includes("[object Object]")) ? x.name : await displayNameFor(x.addr);
          const nameStr = String(nameRaw || "");
          const isFullAddr = /^0x[a-fA-F0-9]{40}$/.test(nameStr);

          // Default: keep rows compact (shorten full addresses). For "Last week",
          // show the full address as requested.
          const display = isFullAddr ? (showFullAddr ? nameStr : shortAddr(nameStr)) : nameStr;

          // Only add tooltip when we're shortening the address.
          const titleAttr = isFullAddr && !showFullAddr ? ` title="${nameStr}"` : "";

          // Color palette: up to 100 entries get 100 distinct colors (per list).
          const c = paletteForIndex(i);
          const styleAttr =
            colorMode === "text"
              ? ` style="--addrColor:${c.text};"`
              : colorMode === "bg"
                ? ` style="--addrBg:${c.bg};"`
                : "";

          const entryStyleAttr =
            colorMode === "row"
              ? ` style="--rowBg:${c.rowBg};--rowBg2:${c.rowBg2};--rowBorder:${c.rowBorder};--rowGlow:${c.rowGlow};"`
              : "";

          const addrClasses = [
            "addr",
            isFullAddr ? "addrFull" : "",
            colorMode === "text" ? "addrColor" : "",
            colorMode === "bg" ? "addrBg" : "",
            isFullAddr && showFullAddr ? "addrBreak" : ""
          ].filter(Boolean).join(" ");

          return `
            <div class="entry${colorMode === "row" ? " entryRow" : ""}"${entryStyleAttr}>
              <div class="left">
                <div class="rankBadge">#${i + 1}</div>
                <div class="${addrClasses}"${titleAttr}${styleAttr}>${display}</div>
              </div>
              <div class="points">${fmtPts(x.pts)}</div>
            </div>
          `;
        })
      );
      return rows.join("");
    };

    const weeklyHtml = await renderList(weeklyTop, { colorMode: "text" });
        const winnersHtml =
      lastWinners.length === 0
        ? `<div class="copy">No winners data found for last week.</div>`
        : `<div class="boardList">${await renderList(lastWinners, { showFullAddr: true, colorMode: "row" })}</div>`;

    $("#boards").innerHTML = `
      <div class="board">
        <div class="boardTitle"><div>Weekly (since ${weekLabel} UTC) <span class="weekCountdownWrap">(<canvas id="weekCountdownBoardsSeg" class="segCanvas" aria-label="Week remaining"></canvas>)</span></div><div>Top 100</div></div>
        <div class="boardList">${weeklyHtml || `<div class="copy">No entries yet.</div>`}</div>
        <div class="subcopy">
          ${
            account
              ? yourWeeklyRank
                ? yourWeeklyRank <= 100
                  ? `You: #${yourWeeklyRank} (${fmtPts(yourWeeklyPts)})`
                  : `You: #${yourWeeklyRank} (${fmtPts(yourWeeklyPts)}) — outside top 100`
                : `No on-chain points found for your address this week yet.`
              : "Connect wallet to see your rank."
          }
        </div>
      </div>

      <div class="board winners">
        <div class="boardTitle"><div>Last week (since ${lastWeekLabel} UTC)</div><div>Top 100</div></div>
        ${winnersHtml}
      </div>
    `;

    startWeekCountdown();
  } catch (e) {
    $("#boards").innerHTML = `<div class="copy">Could not load on-chain logs. Try Refresh. ${
      e?.message ? `<br/><span class="mono">${String(e.message)}</span>` : ""
    }</div>`;
  } finally {
    boardsInFlight = false;
  }
}

// =====================================================
// Canvas sizing
// =====================================================
const ctx = els.c.getContext("2d");

function resize() {
  const wrap = els.c.parentElement;
  const w = Math.floor(wrap.clientWidth);
  const h = Math.floor(wrap.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  els.c.width = Math.floor(w * dpr);
  els.c.height = Math.floor(h * dpr);
  els.c.style.width = `${w}px`;
  els.c.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// =====================================================
// Render + update
// =====================================================
function renderHud() {
  els.runScore.textContent = String(Math.floor(game.runScore));
  els.coins.textContent = String(Math.floor(profile.coins));
  els.bankPoints.textContent = String(Math.floor(profile.bankPoints));
  els.boost.textContent = boostCountdownText() + powerupCountdownText();
}

function laneGeometry() {
  const wrap = els.c;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  const roadW = Math.min(360, w * 0.78);
  const roadH = h * 0.86;
  const roadX = (w - roadW) / 2;
  const roadY = (h - roadH) / 2 + 6;

  const lanes = 4;
  const laneW = roadW / lanes;

  return { w, h, roadX, roadY, roadW, roadH, lanes, laneW };
}

function laneCenterX(g, laneIndex) {
  return g.roadX + g.laneW * (laneIndex + 0.5);
}

function spawnObstacle() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const size = Math.max(36, Math.min(56, g.laneW * 0.55));
  const w = Math.max(28, size * 0.82);
  const h = Math.max(40, size * 1.18);

  const ENEMY_COLORS = [
    "rgba(255,80,120,0.95)",
    "rgba(255,188,64,0.95)",
    "rgba(160,110,255,0.95)",
    "rgba(60,220,160,0.95)",
    "rgba(90,190,255,0.95)"
  ];
  const color = ENEMY_COLORS[randInt(0, ENEMY_COLORS.length - 1)];

  game.obstacles.push({ lane, y: g.roadY - h - 10, size, w, h, color });
}

function spawnCoin() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const x = laneCenterX(g, lane);

  // Normal coin (+1) + bonus coins (5x/10x/100x)
  const r = 10;
  let kind = "coin";
  let value = 1;

  const roll = Math.random();
  // 8% => 5x, 1.5% => 10x, 0.5% => 100x
  if (roll < 0.08) {
    kind = "bonus";
    value = 5;
  } else if (roll < 0.095) {
    kind = "bonus";
    value = 10;
  } else if (roll < 0.10) {
    kind = "bonus";
    value = 100;
  }

  game.coins.push({ lane, x, y: g.roadY - 24, r, kind, value });
}

function spawnPowerUp() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const x = laneCenterX(g, lane);
  const y = g.roadY - 28;

  // Weighted random selection
  const roll = Math.random();
  // 40% magnet, 35% slow, 15% shield, 10% double-lane
  let kind = "magnet";
  if (roll < 0.40) kind = "magnet";
  else if (roll < 0.75) kind = "slow";
  else if (roll < 0.90) kind = "shield";
  else kind = "dbl";

  game.coins.push({ lane, x, y, r: 12, kind, value: 0 });
}

// NOTE: Game powerups use performance.now() timebase (monotonic)
function isMagnetOn(now = performance.now()) {
  return game.magnetUntil && now < game.magnetUntil;
}
function isSlowOn(now = performance.now()) {
  return game.slowUntil && now < game.slowUntil;
}
function isShieldOn(now = performance.now()) {
  return game.shieldUntil && now < game.shieldUntil;
}
function isDoubleLaneOn(now = performance.now()) {
  return game.dblUntil && now < game.dblUntil;
}

function powerupCountdownText(now = performance.now()) {
  const parts = [];
  const sec = (ms) => Math.max(0, Math.ceil(ms / 1000));
  if (isMagnetOn(now)) parts.push(`Mag ${sec(game.magnetUntil - now)}s`);
  if (isSlowOn(now)) parts.push(`Slow ${sec(game.slowUntil - now)}s`);
  if (isShieldOn(now)) parts.push(`Shield ${sec(game.shieldUntil - now)}s`);
  if (isDoubleLaneOn(now)) parts.push(`Jump2 ${sec(game.dblUntil - now)}s`);
  return parts.length ? " | " + parts.join(" | ") : "";
}


function rectsOverlap(a, b) {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

function update(dt) {
  applyDecay();
  computeBoost();

  if (game.over) return;

  game.t += dt;
  game.speed = Math.min(3.2, game.speed + dt * 0.03);

  game.runScore += dt * (8 + game.speed * 5) * profile.boostMult;

  const now = performance.now();

  if (now - game.lastSpawnAt > 650 - game.speed * 80) {
    game.lastSpawnAt = now;
    spawnObstacle();
  }

  // Coins: get a little more frequent as speed increases so long runs still feel rewarding
  const coinInterval = Math.max(700, 1200 - game.speed * 140);
  if (now - game.lastCoinAt > coinInterval) {
    game.lastCoinAt = now;
    // keep some RNG so it doesn't become a wall of coins
    if (Math.random() < 0.82) spawnCoin();
  }

  // Powerups spawn a bit slower & rarer than normal coins
  // + "pity" timer: if you survive a long time and RNG is unlucky, we still force a powerup occasionally.
  const powerInterval = Math.max(2300, 3500 - game.speed * 220); // gets slightly faster later
  if (now - game.lastPowerAt > powerInterval) {
    game.lastPowerAt = now;

    const sinceSpawn = now - (game.lastPowerSpawnedAt || 0);
    const force = sinceSpawn > 9000; // guarantee at least 1 powerup every ~9s
    const chance = 0.33; // baseline

    if (force || Math.random() < chance) {
      spawnPowerUp();
      game.lastPowerSpawnedAt = now;
    }
  }

  const g = laneGeometry();

  // collision rect for the player (consistent with drawn car)
  const carW = Math.max(36, Math.min(60, g.laneW * 0.62));
  const carH = carW * 1.30;
  const carX = laneCenterX(g, game.lane) - carW / 2;
  const carY = g.roadY + g.roadH - carH - 18;
  const carRect = { x: carX, y: carY, w: carW, h: carH };

  const obsSpeed = (220 + game.speed * 90) * (isSlowOn(now) ? 0.55 : 1.0) * dt;
  for (const o of game.obstacles) o.y += obsSpeed;

  const coinSpeed = (190 + game.speed * 70) * dt;
  const carCx = carRect.x + carRect.w / 2;
  const carCy = carRect.y + carRect.h / 2;

  for (const c of game.coins) {
    // Base down movement for everything collectible
    c.y += coinSpeed;

    // Magnet only pulls coins/bonus coins (not powerups)
    if (isMagnetOn(now) && (c.kind === "coin" || c.kind === "bonus")) {
      const dx = carCx - (c.x ?? laneCenterX(g, c.lane));
      const dy = carCy - c.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const pull = 520 * dt; // px per second scaled by dt
      const step = Math.min(pull, dist);
      const ux = dx / dist;
      const uy = dy / dist;
      c.x = (c.x ?? laneCenterX(g, c.lane)) + ux * step;
      c.y = c.y + uy * step * 0.65;
    }
  }

  // ✅ collisions (shield-aware)
  // If shield is active: you DON'T die on crash; we just "bounce" the obstacle away.
  const shieldActive = isShieldOn(now);
  const keptObstacles = [];
  for (const o of game.obstacles) {
    const ow = o.w ?? o.size;
    const oh = o.h ?? o.size;
    const ox = laneCenterX(g, o.lane) - ow / 2;
    const oy = o.y;
    const r = { x: ox, y: oy, w: ow, h: oh };

    if (rectsOverlap(carRect, r)) {
      if (shieldActive) {
        // shield eats the collision (no game over)
        vibrate([18, 40, 18]);
        toast("🛡 Shield blocked a crash!", 650);
        // don't keep this obstacle to avoid repeated overlap in next frames
        continue;
      }

      crashVibe();
      game.over = true;
      stopBgm();
      toast("Crash! Save or restart", 2200);
      break;
    }

    keptObstacles.push(o);
  }

  // If we didn't die, update obstacle list (removes ones that hit shield)
  if (!game.over) game.obstacles = keptObstacles;

  // coin pickup
  const keptCoins = [];
  for (const c of game.coins) {
    const cx = c.x ?? laneCenterX(g, c.lane);
    const cy = c.y;
    const dx = carRect.x + carRect.w / 2 - cx;
    const dy = carRect.y + carRect.h / 2 - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < carRect.w * 0.45 + c.r) {
      if (c.kind === "coin" || c.kind === "bonus") {
        profile.coins += c.value || 1;
        playCoinSfx();
        persistProfile();
        continue;
      }
      // Powerups
      if (c.kind === "magnet") {
        game.magnetUntil = now + 7000;
        toast("🧲 Magnet ON! Coins will pull to you.");
        continue;
      }
      if (c.kind === "slow") {
        game.slowUntil = now + 6500;
        toast("🐢 Slow motion! Enemies are slower.");
        continue;
      }
      if (c.kind === "shield") {
        game.shieldUntil = now + 20000;
        toast("🛡 Shield ON! 20s no-crash.");
        continue;
      }
      if (c.kind === "dbl") {
        game.dblUntil = now + 9000;
        toast("⏩ Double-lane move ON! 9s.");
        continue;
      }
      continue;
    }
    keptCoins.push(c);
  }
  game.coins = keptCoins;

  game.obstacles = game.obstacles.filter((o) => o.y < g.roadY + g.roadH + 80);
  game.coins = game.coins.filter((c) => c.y < g.roadY + g.roadH + 60);
}

function drawRoundedRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}


function drawCarTopDown(x, y, w, h, bodyColor) {
  // Illustrated top-down car (close to your reference). Render-only.
  // IMPORTANT: Does not touch gameplay logic.
  ctx.save();

  // Safety: if sizes are weird, bail gracefully
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
    ctx.restore();
    return;
  }

  // Helpers
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const rr = clamp(w * 0.34, 6, 22);
  const outline = clamp(w * 0.06, 1.2, 5);

  // Slight inset so it fits lanes cleanly
  const bx = x + w * 0.06;
  const by = y + h * 0.03;
  const bw = w * 0.88;
  const bh = h * 0.94;

  // --- soft shadow ---
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  // (no ellipse) use a big rounded-rect shadow for maximum WebView compatibility
  drawRoundedRect(x + w * 0.10, y + h * 0.08, w * 0.80, h * 0.86, Math.max(10, w * 0.40));
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- body gradient (subtle) ---
  // Keep it simple + compatible: base color plus edge shading.
  const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  // Edge shading only (NO center stripe / dag)
  // Keep the center the same body color so it never looks split.
  grad.addColorStop(0, "rgba(0,0,0,0.22)");
  grad.addColorStop(0.16, String(bodyColor || "#ff3b5c"));
  grad.addColorStop(0.50, String(bodyColor || "#ff3b5c"));
  grad.addColorStop(0.84, String(bodyColor || "#ff3b5c"));
  grad.addColorStop(1, "rgba(0,0,0,0.24)");

  // Body fill
  ctx.fillStyle = grad;
  drawRoundedRect(bx, by, bw, bh, rr);
  ctx.fill();

  // Outline (dark) — makes it look like a real car, not a box
  ctx.lineWidth = outline;
  ctx.strokeStyle = "rgba(8,10,18,0.55)";
  ctx.stroke();

  // Inner highlight border (thin)
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = Math.max(1, outline * 0.5);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  drawRoundedRect(bx + bw * 0.02, by + bh * 0.02, bw * 0.96, bh * 0.96, clamp(rr * 0.86, 5, 18));
  ctx.stroke();
  ctx.globalAlpha = 1;

  // --- windshield (front) ---
  const wx = bx + bw * 0.18;
  const ww = bw * 0.64;
  const wy = by + bh * 0.16;
  const wh = bh * 0.26;

  ctx.fillStyle = "rgba(10,18,38,0.92)";
  ctx.beginPath();
  ctx.moveTo(wx + ww * 0.10, wy);
  ctx.lineTo(wx + ww * 0.90, wy);
  ctx.quadraticCurveTo(wx + ww, wy + wh * 0.10, wx + ww * 0.95, wy + wh);
  ctx.lineTo(wx + ww * 0.05, wy + wh);
  ctx.quadraticCurveTo(wx, wy + wh * 0.10, wx + ww * 0.10, wy);
  ctx.closePath();
  ctx.fill();

  // windshield highlight
  ctx.globalAlpha = 0.18;
  const wgl = ctx.createLinearGradient(wx, wy, wx + ww * 0.7, wy + wh);
  wgl.addColorStop(0, "rgba(255,255,255,0.85)");
  wgl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = wgl;
  ctx.beginPath();
  ctx.moveTo(wx + ww * 0.16, wy + wh * 0.10);
  ctx.lineTo(wx + ww * 0.52, wy + wh * 0.10);
  ctx.lineTo(wx + ww * 0.44, wy + wh * 0.92);
  ctx.lineTo(wx + ww * 0.12, wy + wh * 0.92);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- rear window ---
  const rx = bx + bw * 0.22;
  const rw = bw * 0.56;
  const ry = by + bh * 0.64;
  const rh = bh * 0.20;
  ctx.fillStyle = "rgba(10,18,38,0.90)";
  drawRoundedRect(rx, ry, rw, rh, clamp(rw * 0.22, 6, 16));
  ctx.fill();

  // --- side dark panels ---
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = "rgba(10,18,38,0.70)";
  const sx = bx + bw * 0.08;
  const sy = by + bh * 0.30;
  const sw = bw * 0.20;
  const sh = bh * 0.38;
  drawRoundedRect(sx, sy, sw, sh, clamp(sw * 0.55, 6, 18));
  drawRoundedRect(bx + bw - (bw * 0.08) - sw, sy, sw, sh, clamp(sw * 0.55, 6, 18));
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- hood highlights (NO center stripe) ---
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  drawRoundedRect(bx + bw * 0.20, by + bh * 0.12, bw * 0.09, bh * 0.26, clamp(bw * 0.12, 6, 16));
  drawRoundedRect(bx + bw * 0.71, by + bh * 0.14, bw * 0.07, bh * 0.22, clamp(bw * 0.10, 6, 14));
  ctx.fill();
  ctx.globalAlpha = 1;

  // tail lights
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  const lr = Math.max(1.6, w * 0.042);
  ctx.beginPath();
  ctx.arc(bx + bw * 0.24, by + bh * 0.92, lr, 0, Math.PI * 2);
  ctx.arc(bx + bw * 0.76, by + bh * 0.92, lr, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

function drawPlayerCarPremium(x, y, w, h) {
  // Player car: same car style with a subtle glow ring (render-only).
  ctx.save();

  // Soft glow ring (avoid heavy shadowBlur which can be slow / inconsistent)
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = "rgba(120,210,255,0.8)";
  ctx.lineWidth = Math.max(2, w * 0.06);
  drawRoundedRect(x + w * 0.04, y + h * 0.02, w * 0.92, h * 0.96, Math.max(10, w * 0.32));
  ctx.stroke();
  ctx.globalAlpha = 1;

  // IMPORTANT: do not reference any external/global "playerColor" here.
  // The original project didn't define it, and Mini App WebViews will throw
  // a ReferenceError that stops the render loop (cars disappear).
  const PLAYER_BODY = "rgba(90,190,255,0.97)";
  drawCarTopDown(x, y, w, h, PLAYER_BODY);

  ctx.restore();
}

function render() {
  const g = laneGeometry();

  ctx.clearRect(0, 0, g.w, g.h);

  const grd = ctx.createRadialGradient(g.w / 2, g.h / 2, 40, g.w / 2, g.h / 2, g.w);
  grd.addColorStop(0, "rgba(0,0,0,0.0)");
  grd.addColorStop(1, "rgba(0,0,0,0.65)");

  ctx.fillStyle = "#0b0b10";
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, g.w, g.h);

  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "rgba(20,20,28,0.9)";
  drawRoundedRect(g.roadX, g.roadY, g.roadW, g.roadH, 26);
  ctx.fill();


  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 18]);
  for (let i = 1; i < g.lanes; i++) {
    const x = g.roadX + g.laneW * i;
    ctx.beginPath();
    ctx.moveTo(x, g.roadY + 18);
    ctx.lineTo(x, g.roadY + g.roadH - 18);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const o of game.obstacles) {
    const ow = o.w ?? o.size;
    const oh = o.h ?? o.size;
    const x = laneCenterX(g, o.lane) - ow / 2;
    const y = o.y;
    drawCarTopDown(x, y, ow, oh, o.color ?? "rgba(255,80,120,0.95)");
  }

  for (const c of game.coins) {
    const x = c.x ?? laneCenterX(g, c.lane);
    const y = c.y;

    ctx.beginPath();

    // Visual styles per kind
    if (c.kind === "coin") ctx.fillStyle = "rgba(255,214,86,0.95)";
    else if (c.kind === "bonus") ctx.fillStyle = "rgba(187,115,255,0.95)";
    else if (c.kind === "magnet") ctx.fillStyle = "rgba(90,190,255,0.95)";
    else if (c.kind === "slow") ctx.fillStyle = "rgba(120,255,210,0.95)";
    else if (c.kind === "shield") ctx.fillStyle = "rgba(110,255,140,0.95)";
    else if (c.kind === "dbl") ctx.fillStyle = "rgba(255,170,70,0.95)";
    else ctx.fillStyle = "rgba(255,214,86,0.95)";

    ctx.arc(x, y, c.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();

    if (c.kind !== "coin") {
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.font = `bold ${Math.max(10, c.r + 2)}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let label = "";
      if (c.kind === "bonus") label = `${c.value}x`;
      else if (c.kind === "magnet") label = "M";
      else if (c.kind === "slow") label = "S";
      else if (c.kind === "shield") label = "L";
      else if (c.kind === "dbl") label = "2";
      ctx.fillText(label, x, y + 0.5);
    }
  }

  const carW = Math.max(36, Math.min(60, g.laneW * 0.62));
  const carH = carW * 1.30;
  const carX = laneCenterX(g, game.lane) - carW / 2;
  const carY = g.roadY + g.roadH - carH - 18;
  drawPlayerCarPremium(carX, carY, carW, carH);

  // Live shield ball/aura on the player's car
  if (isShieldOn()) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(110,255,140,0.85)";
    ctx.lineWidth = 6;
    ctx.arc(carX + carW / 2, carY + carH / 2, Math.max(carW, carH) * 0.62, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.20;
    ctx.fillStyle = "rgba(110,255,140,0.85)";
    ctx.beginPath();
    ctx.arc(carX + carW / 2, carY + carH / 2, Math.max(carW, carH) * 0.60, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Magnet aura (subtle)
  if (isMagnetOn()) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "rgba(90,190,255,0.85)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(carX + carW / 2, carY + carH / 2, Math.max(carW, carH) * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ✅ Premium crash overlay (2-line + animation)
if (game.over) {
  // detect first frame of game-over to start animation
  if (!wasGameOver) crashAnimStart = performance.now();
  wasGameOver = true;

  const now = performance.now();
  const t = (now - crashAnimStart) / 1000;

  // appear (0->1), then gentle pulse
  const appear = Math.min(1, t / 0.28);
  const ease = 1 - Math.pow(1 - appear, 3);           // easeOutCubic
  const pulse = 0.5 + 0.5 * Math.sin((t - 0.3) * 2.2);
  const glow = 0.10 + pulse * 0.18;

  const boxW = g.roadW - 32;
  const boxH = 100;
  const boxX = g.roadX + 16;
  const boxY = g.roadY + g.roadH * 0.38;

  // slight slide-up + tiny scale
  const yOff = (1 - ease) * 14;
  const scale = 0.985 + ease * 0.015;

  ctx.save();

  const cx = boxX + boxW / 2;
  const cy = boxY + boxH / 2;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  ctx.globalAlpha = 0.10 + ease * 0.90;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  drawRoundedRect(boxX, boxY + yOff, boxW, boxH, 18);
  ctx.fill();

  // premium border glow
  ctx.globalAlpha = ease;
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = `rgba(255,255,255,${0.08 + glow})`;
  ctx.shadowBlur = 18;
  ctx.shadowColor = `rgba(255,77,109,${0.18 + glow})`;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // centered 2-line text
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.globalAlpha = ease;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.font = "800 20px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillText("Crash!", boxX + boxW / 2, boxY + yOff + 40);

  ctx.globalAlpha = 0.85 * ease;
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillText("Tap 💾Save to Saved points", boxX + boxW / 2, boxY + yOff + 64);
  ctx.fillText("Tap the panel to restart", boxX + boxW / 2, boxY + yOff + 82);

  ctx.restore();

  els.c.style.cursor = "pointer";
} else {
  wasGameOver = false;          // reset animation state
  els.c.style.cursor = "default";
}


  ctx.restore();
  renderHud();
}

// Restart on tap when over
els.c.addEventListener(
  "pointerdown",
  (e) => {
    ensureAudioUnlocked();
    if (!game.over) return;
    e.preventDefault();
    e.stopPropagation();
    resetRun();
  },
  { passive: false }
);

// Main loop
function tick(ts) {
  const dt = Math.min(0.033, (ts - game.lastFrame) / 1000);
  game.lastFrame = ts;
  update(dt);
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Initial status
renderStatus();
renderHud();
