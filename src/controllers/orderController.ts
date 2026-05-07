import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { z } from 'zod';

const shippingAddressSchema = z.object({
  full_name: z.string().min(1),
  address_line1: z.string().min(1),
  address_line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postal_code: z.string().min(1),
  country: z.string().min(1),
  phone: z.string().optional(),
});

const createOrderSchema = z.object({
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    customization: z.record(z.string()).optional(),
  })).min(1),
  shipping_address: shippingAddressSchema,
  payment_method: z.literal('cod').default('cod'),
});

export async function getOrders(req: Request, res: Response): Promise<void> {
  try {
    const { page = '1', limit = '20', status, payment_status } = req.query;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = supabaseAdmin
      .from('orders')
      .select('*, order_items(*, products(name, images, price, slug)), profiles!orders_user_id_fkey(full_name, id)', { count: 'exact' });

    // Customers only see their own orders
    if (req.user!.role !== 'admin') {
      query = query.eq('user_id', req.user!.id);
    }

    if (status) query = query.eq('status', status as string);
    if (payment_status) query = query.eq('payment_status', payment_status as string);

    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) {
      console.error('[orders] getOrders error:', error.message, error.details, error.hint);
      throw error;
    }

    res.json({
      data,
      pagination: { page: pageNum, limit: limitNum, total: count ?? 0, pages: Math.ceil((count ?? 0) / limitNum) },
    });
  } catch (err: any) {
    console.error('[orders] getOrders caught:', err?.message);
    res.status(500).json({ error: 'Failed to fetch orders', detail: err?.message });
  }
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    let query = supabaseAdmin
      .from('orders')
      .select('*, order_items(*, products(name, images, price, slug)), profiles!orders_user_id_fkey(full_name, id)')
      .eq('id', id);

    if (req.user!.role !== 'admin') {
      query = query.eq('user_id', req.user!.id);
    }

    const { data, error } = await query.single();
    if (error || !data) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
}

export async function createOrder(req: Request, res: Response): Promise<void> {
  try {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { items, shipping_address } = parsed.data;

    // Fetch product prices and check stock
    const productIds = items.map(i => i.product_id);
    const { data: products, error: productsError } = await supabaseAdmin
      .from('products')
      .select('id, name, price, discount_price, stock, status')
      .in('id', productIds)
      .eq('status', 'active');

    if (productsError) throw productsError;
    if (!products || products.length !== productIds.length) {
      res.status(400).json({ error: 'One or more products not found or inactive' });
      return;
    }

    // Validate stock
    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);
      if (!product || product.stock < item.quantity) {
        res.status(400).json({ error: `Insufficient stock for product ${product?.name ?? item.product_id}` });
        return;
      }
    }

    // Calculate total
    const total_amount = items.reduce((sum, item) => {
      const product = products.find(p => p.id === item.product_id)!;
      const price = product.discount_price ?? product.price;
      return sum + price * item.quantity;
    }, 0);

    // Create order
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: req.user!.id,
        status: 'pending',
        total_amount,
        shipping_address,
        payment_status: 'pending',
        payment_method: 'cod',
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // Create order items
    const orderItems = items.map(item => {
      const product = products.find(p => p.id === item.product_id)!;
      return {
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price_at_time: product.discount_price ?? product.price,
      };
    });

    const { error: itemsError } = await supabaseAdmin.from('order_items').insert(orderItems);
    if (itemsError) throw itemsError;

    // Decrement stock
    for (const item of items) {
      await supabaseAdmin.rpc('decrement_stock', {
        product_id: item.product_id,
        amount: item.quantity,
      });
    }

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create order' });
  }
}

export async function updateOrderStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status, notes, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order status' });
  }
}

export async function getDashboardStats(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [revenueResult, ordersResult, pendingResult, lowStockResult, recentOrdersResult] = await Promise.all([
      supabaseAdmin.from('orders').select('total_amount').eq('payment_status', 'paid'),
      supabaseAdmin.from('orders').select('id', { count: 'exact' }).gte('created_at', today.toISOString()),
      supabaseAdmin.from('orders').select('id', { count: 'exact' }).eq('status', 'pending'),
      supabaseAdmin.from('products').select('id', { count: 'exact' }).lt('stock', 10).eq('status', 'active'),
      supabaseAdmin.from('orders').select('*, profiles!orders_user_id_fkey(full_name)').order('created_at', { ascending: false }).limit(5),
    ]);

    const totalRevenue = (revenueResult.data ?? []).reduce((sum, o) => sum + (o.total_amount ?? 0), 0);

    res.json({
      total_revenue: totalRevenue,
      orders_today: ordersResult.count ?? 0,
      pending_orders: pendingResult.count ?? 0,
      low_stock_items: lowStockResult.count ?? 0,
      recent_orders: recentOrdersResult.data ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
}

export async function createPaymentIntent(req: Request, res: Response): Promise<void> {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey || stripeKey.startsWith('sk_test_your')) {
      res.status(503).json({ error: 'Payment processing not configured' });
      return;
    }

    const { amount } = req.body;
    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'Valid amount required' });
      return;
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' as any });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { user_id: req.user!.id },
    });

    res.json({ client_secret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
}
