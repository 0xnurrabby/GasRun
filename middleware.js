export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';
  const keyFromUrl = url.searchParams.get('key');

  // Maintenance off -> main site
  if (!maintenanceMode) {
    return fetch(request);
  }

  // Maintenance page itself -> allow
  if (url.pathname === '/maintenance.html') {
    return fetch(request);
  }

  // Secret key diye bypass
  if (bypassKey && keyFromUrl === bypassKey) {
    return fetch(request);
  }

  // Sobai maintenance page dekhbe
  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
