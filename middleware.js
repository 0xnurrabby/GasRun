export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';
  const keyFromUrl = url.searchParams.get('key');

  if (!maintenanceMode) {
    return;
  }

  // maintenance page allow
  if (url.pathname === '/maintenance.html') {
    return;
  }

  // secret key মিললে ঢুকতে দাও
  if (bypassKey && keyFromUrl === bypassKey) {
    return;
  }

  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
