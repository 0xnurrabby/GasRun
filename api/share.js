// Vercel Serverless Function: /api/share
// Generates a shareable HTML page with Farcaster Mini App embed meta tags.
// This lets users share a personalized "stat card" link in a cast.

const HOME_URL = "https://gasrun.vercel.app/";
const OG_IMAGE = `${HOME_URL}assets/embed-3x2.png`;
const SPLASH = `${HOME_URL}assets/splash-200.png`;

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return x.toLocaleString("en-US");
}

export default function handler(req, res) {
  const { week = "", rank = "", pts = "", addr = "" } = req.query || {};

  const prettyRank = rank ? `#${rank}` : "—";
  const prettyPts = fmt(pts);
  const shortAddr =
    typeof addr === "string" && addr.startsWith("0x") && addr.length >= 10
      ? `${addr.slice(0, 6)}…${addr.slice(-4)}`
      : "";

  const title = rank
    ? `GasRun • Weekly Rank ${prettyRank}`
    : `GasRun • Weekly Stats`;
  const description = rank
    ? `I scored ${prettyPts} points this week (${prettyRank}). Can you beat me?`
    : `Run, collect coins, and save points on Base.`;

  // Deep link back into the game (safe even if the app ignores params).
  const launchUrl = `${HOME_URL}?from=share&week=${encodeURIComponent(
    String(week || "")
  )}&rank=${encodeURIComponent(String(rank || ""))}&pts=${encodeURIComponent(
    String(pts || "")
  )}`;

  const miniapp = {
    version: "1",
    imageUrl: OG_IMAGE,
    button: {
      title: "Play GasRun",
      action: {
        type: "launch_miniapp",
        url: launchUrl,
        name: "GasRun",
        splashImageUrl: SPLASH,
        splashBackgroundColor: "#0f0f14",
      },
    },
  };

  // Backward compatibility
  const frame = {
    ...miniapp,
    button: {
      ...miniapp.button,
      action: { ...miniapp.button.action, type: "launch_frame" },
    },
  };

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />

    <title>${esc(title)}</title>

    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:image" content="${esc(OG_IMAGE)}" />
    <meta property="og:url" content="${esc(HOME_URL)}" />
    <meta property="og:type" content="website" />

    <meta name="fc:miniapp" content='${esc(JSON.stringify(miniapp))}' />
    <meta name="fc:frame" content='${esc(JSON.stringify(frame))}' />

    <style>
      @font-face{
        font-family: "AmericanCaptainPatrius";
        src: url("${HOME_URL}assets/fonts/AmericanCaptainPatrius02FRE.ttf") format("truetype");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      body{font-family:"AmericanCaptainPatrius", system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
    </style>
  </head>
  <body style="margin:0;background:#0f0f14;color:#eaeaea;">
    <main style="max-width:720px;margin:0 auto;padding:28px;">
      <h1 style="margin:0 0 10px;font-size:24px;">GasRun Weekly Stats</h1>
      <p style="margin:0 0 18px;opacity:.9;">${esc(description)}</p>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 22px;">
        <div style="padding:12px 14px;border-radius:12px;background:#171a22;min-width:180px;">
          <div style="opacity:.75;font-size:12px;margin-bottom:6px;">Rank</div>
          <div style="font-size:20px;font-weight:700;">${esc(prettyRank)}</div>
        </div>
        <div style="padding:12px 14px;border-radius:12px;background:#171a22;min-width:180px;">
          <div style="opacity:.75;font-size:12px;margin-bottom:6px;">Points</div>
          <div style="font-size:20px;font-weight:700;">${esc(prettyPts)}</div>
        </div>
        ${
          shortAddr
            ? `<div style="padding:12px 14px;border-radius:12px;background:#171a22;min-width:220px;">
                <div style="opacity:.75;font-size:12px;margin-bottom:6px;">Wallet</div>
                <div style="font-size:16px;font-weight:650;letter-spacing:.2px;">${esc(shortAddr)}</div>
              </div>`
            : ""
        }
      </div>

      <a href="${esc(launchUrl)}" style="display:inline-block;background:#2a7cff;color:white;text-decoration:none;padding:12px 16px;border-radius:12px;font-weight:700;">
        Play GasRun
      </a>

      <p style="margin:18px 0 0;opacity:.7;font-size:12px;">
        If you’re seeing this page in a browser, open it in a Farcaster client or Base App to view the embed.
      </p>
    </main>
  </body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Keep this page cacheable but not too sticky (embeds cache anyway at cast-time).
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(html);
}
