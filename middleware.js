export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';

  const keyFromUrl = url.searchParams.get('key');
  const cookies = request.headers.get('cookie') || '';
  const hasBypassCookie = cookies.includes('maint_bypass=1');

  // maintenance off হলে কিছু করবি না
  if (!maintenanceMode) {
    return fetch(request);
  }

  // maintenance page, favicon, assets allow
  if (
    url.pathname === '/maintenance.html' ||
    url.pathname === '/favicon.ico' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/.well-known/') ||
    url.pathname.startsWith('/api/')
  ) {
    return fetch(request);
  }

  // আগে cookie থাকলে allow
  if (hasBypassCookie) {
    return fetch(request);
  }

  // key মিললে cookie set করে main site এ ঢুকতে দে
  if (bypassKey && keyFromUrl === bypassKey) {
    const cleanUrl = new URL(request.url);
    cleanUrl.searchParams.delete('key');

    return new Response(null, {
      status: 302,
      headers: {
        Location: cleanUrl.toString(),
        'Set-Cookie':
          'maint_bypass=1; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax',
      },
    });
  }

  // বাকি সবাই maintenance page
  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
