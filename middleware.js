import { next } from '@vercel/functions';

export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';
  const keyFromUrl = url.searchParams.get('key');

  if (!maintenanceMode) {
    return next();
  }

  if (url.pathname === '/maintenance.html') {
    return next();
  }

  if (bypassKey && keyFromUrl === bypassKey) {
    return next();
  }

  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
