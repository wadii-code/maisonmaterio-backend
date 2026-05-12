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

const customizationSchema = z.object({
  color: z.object({
    name: z.string().min(1).max(50),
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).optional(),
  unitPrice: z.number().nonnegative().nullable().optional(),
}).passthrough().optional();

const createOrderSchema = z.object({
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    customization: customizationSchema,
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
      .select('*, order_items(*, products(name, images, price, slug)), profiles!orders_user_id_fkey(full_name, id, phone)', { count: 'exact' });

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
      .select('*, order_items(*, products(name, images, price, slug)), profiles!orders_user_id_fkey(full_name, id, phone)')
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

    // Fetch product prices/colors and check stock. We re-derive prices on the server
    // so a tampered client can't pay less than the real price.
    const productIds = items.map(i => i.product_id);
    const { data: products, error: productsError } = await supabaseAdmin
      .from('products')
      .select('id, name, price, discount_price, stock, status, colors')
      .in('id', productIds)
      .eq('status', 'active');

    if (productsError) throw productsError;
    if (!products || products.length !== productIds.length) {
      res.status(400).json({ error: 'One or more products not found or inactive' });
      return;
    }

    // Aggregate quantity per product (a single product can appear twice in different colors)
    const totalQtyByProduct = new Map<string, number>();
    for (const item of items) {
      totalQtyByProduct.set(
        item.product_id,
        (totalQtyByProduct.get(item.product_id) ?? 0) + item.quantity,
      );
    }

    // Validate stock based on aggregated qty
    for (const [productId, qty] of totalQtyByProduct) {
      const product = products.find(p => p.id === productId);
      if (!product || product.stock < qty) {
        res.status(400).json({ error: `Insufficient stock for product ${product?.name ?? productId}` });
        return;
      }
    }

    // Compute server-trusted unit price per line including color delta
    const lineUnitPrice = (item: typeof items[number]): { unit: number; matchedColor?: { name: string; hex: string; price_delta: number } } => {
      const product = products.find(p => p.id === item.product_id)!;
      const base = product.discount_price ?? product.price;
      const requestedHex = item.customization?.color?.hex;
      if (!requestedHex) return { unit: Number(base) };
      const colors: Array<{ name: string; hex: string; price_delta: number }> = (product.colors as any) ?? [];
      const matched = colors.find(c => c.hex.toLowerCase() === requestedHex.toLowerCase());
      // If the client claimed a color that doesn't exist on the product, ignore the delta
      const delta = matched?.price_delta ?? 0;
      return { unit: Number(base) + Number(delta), matchedColor: matched };
    };

    // Calculate total from server-derived unit prices
    const total_amount = items.reduce((sum, item) => {
      const { unit } = lineUnitPrice(item);
      return sum + unit * item.quantity;
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

    // Create order items, persisting customization for traceability
    const orderItems = items.map(item => {
      const { unit, matchedColor } = lineUnitPrice(item);
      const customizationToStore = matchedColor
        ? { color: { name: matchedColor.name, hex: matchedColor.hex } }
        : null;
      return {
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price_at_time: unit,
        customization: customizationToStore,
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
    const { status, notes, payment_status } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const validPaymentStatuses = ['pending', 'paid', 'failed', 'refunded'];
    if (payment_status && !validPaymentStatuses.includes(payment_status)) {
      res.status(400).json({ error: 'Invalid payment status' });
      return;
    }

    // Load the existing order to enforce authorization rules
    const { data: existing, error: loadErr } = await supabaseAdmin
      .from('orders')
      .select('id, user_id, status')
      .eq('id', id)
      .single();

    if (loadErr || !existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const isAdmin = req.user!.role === 'admin';
    const isOwner = existing.user_id === req.user!.id;

    // Customer rules: can only cancel their own pending order; cannot change payment_status.
    if (!isAdmin) {
      if (!isOwner) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (payment_status) {
        res.status(403).json({ error: 'Only admins can change payment status' });
        return;
      }
      if (status !== 'cancelled' || existing.status !== 'pending') {
        res.status(403).json({ error: 'You can only cancel an order while it is still pending.' });
        return;
      }
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (payment_status && isAdmin) updates.payment_status = payment_status;

    // Auto-flip payment_status to 'paid' when admin marks COD order as delivered
    // (unless they explicitly passed a different payment_status).
    if (isAdmin && status === 'delivered' && !payment_status) {
      updates.payment_status = 'paid';
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Failed to update order status' });
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

    // Revenue rule: only shipped or delivered orders count.
    const [revenueResult, ordersResult, pendingResult, lowStockResult, recentOrdersResult] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('total_amount')
        .eq('payment_status', 'paid'),
      supabaseAdmin.from('orders').select('id', { count: 'exact' }).gte('created_at', today.toISOString()),
      supabaseAdmin.from('orders').select('id', { count: 'exact' }).eq('status', 'pending'),
      supabaseAdmin.from('products').select('id', { count: 'exact' }).lt('stock', 10).eq('status', 'active'),
      supabaseAdmin.from('orders').select('*, profiles!orders_user_id_fkey(full_name)').order('created_at', { ascending: false }).limit(5),
    ]);

    const totalRevenue = (revenueResult.data ?? [])
      .reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0);

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