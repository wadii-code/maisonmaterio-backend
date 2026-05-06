import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import productRoutes from './routes/products';
import orderRoutes from './routes/orders';
import reviewRoutes from './routes/reviews';
import customerRoutes from './routes/customers';
import { categoryRouter, roomRouter } from './routes/categories';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}));

// Rate limiting
app.use('/api/', rateLimit({
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

// API routes
// NOTE: Do NOT use app.get() cache headers here because productRoutes handles
// GET /api/products internally (app.get runs only when no other handler matches).
app.use((req, res, next) => {
  if (req.path === '/api/products' || req.path.startsWith('/api/products/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRouter);
app.use('/api/rooms', roomRouter);

app.use('/api/orders', orderRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/customers', customerRoutes);

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
  console.log(`🚀 SWIPO API running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV ?? 'development'}`);
});

export default app;
