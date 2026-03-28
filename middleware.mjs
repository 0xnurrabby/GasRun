export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';
  const keyFromUrl = url.searchParams.get('key');
  const hasBypassCookie = request.headers.get('cookie')?.includes('maint_bypass=1');

  // maintenance বন্ধ থাকলে normal site
  if (!maintenanceMode) {
    return;
  }

  // maintenance page নিজে block হবে না
  if (url.pathname === '/maintenance.html') {
    return;
  }

  // key দিয়ে ঢুকলে cookie set করে দাও
  if (bypassKey && keyFromUrl === bypassKey) {
    url.searchParams.delete('key');

    const response = Response.redirect(url, 302);
    response.headers.append(
      'Set-Cookie',
      'maint_bypass=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200'
    );
    return response;
  }

  // cookie থাকলে allow
  if (hasBypassCookie) {
    return;
  }

  // সবাইকে maintenance page এ পাঠাও
  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
