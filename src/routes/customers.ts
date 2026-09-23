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

// Revenue days are Casablanca calendar days, whatever TZ the server runs in
// (Vercel is UTC, local dev is UTC+1).
const SHOP_TZ = 'Africa/Casablanca';
const shopDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const toShopDay = (d: Date) => shopDay.format(d); // YYYY-MM-DD
const DAY_MS = 86_400_000;

router.get('/revenue', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { period = '7d' } = req.query;
    const monthly = period === '12m';
    const today = toShopDay(new Date());
    const todayUtc = new Date(`${today}T00:00:00Z`);

    // Build the bucket keys, oldest first, always ending with today / this month.
    const keys: string[] = [];
    if (monthly) {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth() - i, 1));
        keys.push(d.toISOString().slice(0, 7));
      }
    } else {
      const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;
      for (let i = days - 1; i >= 0; i--) {
        keys.push(new Date(todayUtc.getTime() - i * DAY_MS).toISOString().slice(0, 10));
      }
    }
    const buckets: Record<string, number> = Object.fromEntries(keys.map(k => [k, 0]));

    // One day of slack covers the TZ offset; the bucket check below trims the edge.
    const firstDay = monthly ? `${keys[0]}-01` : keys[0];
    const since = new Date(new Date(`${firstDay}T00:00:00Z`).getTime() - DAY_MS);

    // Same rule as dashboard total: only shipped or delivered orders count.
    const REVENUE_STATUSES = ['shipped', 'delivered'];
    const [{ data, error }, { data: lastSale, error: lastError }] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('total_amount, created_at, status')
        .gte('created_at', since.toISOString())
        .in('status', REVENUE_STATUSES)
        .order('created_at', { ascending: true }),
      // Lets the chart say when the last sale was when a period is empty.
      supabaseAdmin
        .from('orders')
        .select('created_at')
        .in('status', REVENUE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (error) throw error;
    if (lastError) throw lastError;

    for (const order of data ?? []) {
      const day = toShopDay(new Date(order.created_at));
      const key = monthly ? day.slice(0, 7) : day;
      if (key in buckets) buckets[key] += Number(order.total_amount);
    }

    const series = Object.entries(buckets).map(([date, revenue]) => ({ date, revenue }));
    res.json({
      series,
      total: series.reduce((s, p) => s + p.revenue, 0),
      last_sale_date: lastSale ? toShopDay(new Date(lastSale.created_at)) : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch revenue' });
  }
});

export default router;
