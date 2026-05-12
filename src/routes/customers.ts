import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { supabaseAdmin } from '../config/supabase';

const router = Router();

router.get('/', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get order stats per customer
    const userIds = (profiles ?? []).map(p => p.id);
    const { data: orderStats } = await supabaseAdmin
      .from('orders')
      .select('user_id, total_amount, status, payment_status')
      .in('user_id', userIds);

    const COUNTED_STATUSES = ['shipped', 'delivered'];
    const stats = (orderStats ?? []).reduce<Record<string, { orders: number; spent: number }>>((acc, o) => {
      if (!acc[o.user_id]) acc[o.user_id] = { orders: 0, spent: 0 };
      acc[o.user_id].orders += 1;
      if (COUNTED_STATUSES.includes(o.status)) acc[o.user_id].spent += Number(o.total_amount);
      return acc;
    }, {});

    const enriched = (profiles ?? []).map(p => ({
      ...p,
      total_orders: stats[p.id]?.orders ?? 0,
      total_spent: stats[p.id]?.spent ?? 0,
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

router.get('/revenue', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { period = '7d' } = req.query;
    const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // Same rule as dashboard total: only shipped or delivered orders count.
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('total_amount, created_at, status')
      .gte('created_at', since.toISOString())
      .in('status', ['shipped', 'delivered'])
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Bucket by day
    const buckets: Record<string, number> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const order of data ?? []) {
      const day = order.created_at.slice(0, 10);
      if (day in buckets) buckets[day] += Number(order.total_amount);
    }

    const series = Object.entries(buckets).map(([date, revenue]) => ({ date, revenue }));
    res.json({ series, total: series.reduce((s, p) => s + p.revenue, 0) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch revenue' });
  }
});

export default router;
