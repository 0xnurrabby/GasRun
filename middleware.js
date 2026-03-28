export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';
  const keyFromUrl = url.searchParams.get('key');
  const hasBypassCookie = request.headers
    .get('cookie')
    ?.includes('maint_bypass=1');

  if (!maintenanceMode) {
    return;
  }

  if (url.pathname === '/maintenance.html') {
    return;
  }

  if (bypassKey && keyFromUrl === bypassKey) {
    url.searchParams.delete('key');
    const response = Response.redirect(url, 302);
    response.headers.append(
      'Set-Cookie',
      'maint_bypass=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200'
    );
    return response;
  }

  if (hasBypassCookie) {
    return;
  }

  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
