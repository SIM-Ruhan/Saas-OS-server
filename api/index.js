import app from '../index.js';

// Keep the original Express route if the Vercel rewrite exposes only /api.
export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.searchParams.get('__route');
  if (route !== null && (url.pathname === '/api' || url.pathname === '/api/index')) {
    url.pathname = `/${route.replace(/^\/+/, '')}`;
    url.searchParams.delete('__route');
    req.url = `${url.pathname}${url.search}`;
  }
  return app(req, res);
}
