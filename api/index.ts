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

// Root route
app.get('/', (_req, res) => {
  res.json({ message: 'Welcome to the Maison Materiau API!' });
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