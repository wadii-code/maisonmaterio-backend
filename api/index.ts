import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import productRoutes from '../src/routes/products';
import orderRoutes from '../src/routes/orders';
import reviewRoutes from '../src/routes/reviews';
import customerRoutes from '../src/routes/customers';
import adminRoutes from '../src/routes/admins';
import { categoryRouter, roomRouter } from '../src/routes/categories';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

// Security middleware
app.use(helmet());

// CORS — explicit allow-list of every storefront origin that may call this API.
// Adding the custom domain (with and without `www`) plus the Vercel preview URLs.
// Additional origins can be added at runtime via the `FRONTEND_URL` env var
// (comma-separated for multiple values).
const allowedOrigins = new Set<string>([
  'http://localhost:5173',
  'http://localhost:4173',
  'https://maisonmaterio-frontend.vercel.app',
  'https://maisonmateriau.com',
  'https://www.maisonmateriau.com',
  ...(process.env.FRONTEND_URL?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
]);

app.use(cors({
  origin: (origin, callback) => {
    // Allow no-origin requests (curl, server-to-server, health checks).
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    // Also accept any *.vercel.app preview URL for this project so PR previews work.
    if (/\.vercel\.app$/.test(new URL(origin).hostname)) return callback(null, true);
    console.warn('[cors] rejected origin:', origin);
    return callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
  },
  credentials: true,
}));

// Rate limiting
app.use('/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests, please try again later.',
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'swipo-api' });
});

// Primary public site URL (used to forward misrouted auth links to the frontend).
// FRONTEND_URL may be a comma-separated list; take the first entry.
const SITE_URL =
  (process.env.FRONTEND_URL?.split(',').map(s => s.trim()).filter(Boolean)[0]) ??
  'https://www.maisonmateriau.com';

// Root route.
// Safety net for password-recovery links: if Supabase's "Site URL" is (mis)configured
// to point at this API, the reset link lands here. The recovery token lives in the URL
// *fragment* (#access_token=...&type=recovery), which browsers DON'T send to the server —
// so for browser navigations we return a tiny HTML page whose JS inspects the fragment/query
// and forwards the user (token preserved) to the real frontend reset page.
// API clients (Accept: application/json, curl, etc.) still get the JSON welcome.
app.get('/', (req, res) => {
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if (!wantsHtml) {
    res.json({ message: 'Welcome to the Maison Materiau API!' });
    return;
  }

  const target = `${SITE_URL.replace(/\/$/, '')}/auth?mode=reset`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maison Materiau</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#faf8f5;color:#1a1a1a}.b{text-align:center}a{color:#f5a623;font-weight:700}</style>
</head><body><div class="b"><p>Redirection…</p><p><a id="l" href="${target}">Continuer vers Maison Materiau</a></p></div>
<script>(function(){
  var hash = window.location.hash || '';            // e.g. #access_token=...&type=recovery
  var search = window.location.search || '';        // e.g. ?code=... or ?error_description=...
  var isRecovery = /type=recovery|access_token=|token_hash=|[?&]code=|error_description=/.test(hash + search);
  var base = ${JSON.stringify(target)};             // .../auth?mode=reset
  // base already has a query string, so extra query params are appended with '&'.
  var extraQuery = search ? '&' + search.replace(/^[?]/, '') : '';
  var dest = base + extraQuery + hash;
  window.location.replace(isRecovery ? dest : ${JSON.stringify(SITE_URL)});
})();</script></body></html>`);
});

app.use((req, res, next) => {
  if (req.path === '/products' || req.path.startsWith('/products/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/products', productRoutes);
app.use('/categories', categoryRouter);
app.use('/rooms', roomRouter);

app.use('/orders', orderRoutes);
app.use('/reviews', reviewRoutes);
app.use('/customers', customerRoutes);
app.use('/admins', adminRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Maison Materio API running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV ?? 'development'}`);
});

export default app;