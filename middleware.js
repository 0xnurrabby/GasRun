import { NextResponse } from 'next/server';

export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || '';
  const keyFromUrl = url.searchParams.get('key');

  if (!maintenanceMode) {
    return NextResponse.next();
  }

  // maintenance page itself allow
  if (url.pathname === '/maintenance.html') {
    return NextResponse.next();
  }

  // static assets allow
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // secret key diye bypass
  if (bypassKey && keyFromUrl === bypassKey) {
    return NextResponse.next();
  }

  return Response.redirect(new URL('/maintenance.html', request.url), 307);
}
