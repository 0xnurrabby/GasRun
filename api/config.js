export default function handler(req, res) {
  // NOTE:
  // - The paymaster URL is not a secret, but keeping it in an env var makes it easy to change
  //   without redeploying the front-end bundle.
  // - In Vercel, set either CDP_PAYMASTER_URL or PAYMASTER_URL.
  const paymasterUrl = (process.env.CDP_PAYMASTER_URL || process.env.PAYMASTER_URL || "").trim();

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, paymasterUrl });
}
