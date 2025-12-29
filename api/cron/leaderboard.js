// Vercel Cron: /api/cron/leaderboard
// Keeps leaderboard cache warm. Configure in vercel.json "crons".
// This endpoint simply forwards to /api/leaderboard?refresh=1&names=0.

module.exports = async function handler(req, res) {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const url = `${proto}://${host}/api/leaderboard?refresh=1&names=0`;

    const r = await fetch(url, { headers: { "user-agent": "vercel-cron" }, cache: "no-store" });
    const text = await r.text();

    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(
      JSON.stringify({
        ok: r.ok,
        status: r.status,
        forwarded: "/api/leaderboard?refresh=1&names=0",
        body: (() => { try { return JSON.parse(text); } catch (_) { return text; } })(),
      })
    );
  } catch (e) {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
};
