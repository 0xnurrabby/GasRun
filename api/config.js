export default function handler(req, res) {
  // NOTE:
  // - The paymaster URL is not a secret, but keeping it in an env var makes it easy to change
  //   without redeploying the front-end bundle.
  // - In Vercel, set either CDP_PAYMASTER_URL or PAYMASTER_URL.
  // If env vars are not showing up on a given deployment (common when a domain is
  // still pointing to an older build), we provide a safe fallback.
  // You can remove the fallback once `/api/config` shows `envDetected.cdp=true`.
  const FALLBACK_PAYMASTER_URL =
    "https://api.developer.coinbase.com/rpc/v1/base/61Hyvt0kHZcKUWlwCqJdKIXiy2KWrp10";

  const paymasterUrl = (
    process.env.CDP_PAYMASTER_URL ||
    process.env.PAYMASTER_URL ||
    FALLBACK_PAYMASTER_URL ||
    ""
  ).trim();

  const envDetected = {
    vercelEnv: process.env.VERCEL_ENV || null,
    cdp: Boolean(process.env.CDP_PAYMASTER_URL),
    paymaster: Boolean(process.env.PAYMASTER_URL),
  };

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, paymasterUrl, envDetected });
}
