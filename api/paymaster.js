// Vercel Serverless Function: /api/paymaster
// Simple JSON-RPC proxy to protect your CDP Paymaster & Bundler endpoint URL.
// Set env var: PAYMASTER_AND_BUNDLER_ENDPOINT = https://api.developer.coinbase.com/rpc/v1/base/<YOUR_KEY>
//
// This endpoint is meant to be used as the `capabilities.paymasterService.url` in wallet_sendCalls.

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).send('Method Not Allowed');
    return;
  }

  const target = process.env.PAYMASTER_AND_BUNDLER_ENDPOINT;
  if (!target) {
    res.status(500).json({
      error: 'Missing PAYMASTER_AND_BUNDLER_ENDPOINT env var on the server.',
    });
    return;
  }

  // Read body as text to preserve exact JSON-RPC payload
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const bodyToSend = rawBody && rawBody !== '{}' ? rawBody : await readRawBody(req);

  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: bodyToSend,
    });

    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    // Prevent caching JSON-RPC responses
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  } catch (e) {
    res.status(502).json({
      error: 'Failed to reach CDP Paymaster endpoint',
      message: String(e?.message || e),
    });
  }
}
