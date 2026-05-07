import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { z } from 'zod';

const productSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().min(1),
  price: z.number().positive(),
  discount_price: z.number().positive().optional().nullable(),
  category_id: z.string().uuid(),
  room_id: z.string().uuid().optional().nullable(),
  material: z.string().optional().nullable(),
  dimensions: z.string().optional().nullable(),
  stock: z.number().int().min(0),
  status: z.enum(['active', 'inactive']).default('active'),
  images: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  colors: z.array(z.object({
    name: z.string().min(1),
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex must be #RRGGBB'),
    price_delta: z.number().default(0),
  })).default([]),
});

export async function getProducts(req: Request, res: Response): Promise<void> {
  try {
    const {
      page = '1',
      limit = '12',
      category,
      room,
      min_price,
      max_price,
      tags,
      sort = 'created_at',
      order = 'desc',
      search,
      status,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string)));
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = supabaseAdmin
      .from('products')
      .select('*, categories(name, slug), rooms(name, slug)', { count: 'exact' });

    // Non-admins only see active products
    if (!req.user || req.user.role !== 'admin') {
      query = query.eq('status', 'active');
    } else if (status) {
      query = query.eq('status', status as string);
    }

    if (category) query = query.eq('categories.slug', category as string);
    if (room) query = query.eq('rooms.slug', room as string);
    if (min_price) query = query.gte('price', parseFloat(min_price as string));
    if (max_price) query = query.lte('price', parseFloat(max_price as string));
    if (tags) {
      const tagArr = (tags as string).split(',');
      query = query.overlaps('tags', tagArr);
    }
    if (search) query = query.ilike('name', `%${search}%`);

    const validSortFields = ['created_at', 'price', 'rating', 'review_count', 'name'];
    const sortField = validSortFields.includes(sort as string) ? (sort as string) : 'created_at';
    query = query.order(sortField, { ascending: order === 'asc' });
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) throw error;

    res.json({
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / limitNum),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    // Fetch product with category & room joins (these have proper FKs)
    const { data: product, error } = await supabaseAdmin
      .from('products')
      .select('*, categories(name, slug), rooms(name, slug)')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[getProduct] query error:', error);
      res.status(500).json({ error: 'Failed to fetch product', details: error.message });
      return;
    }

    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    if (product.status === 'inactive' && (!req.user || req.user.role !== 'admin')) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Fetch reviews separately (no implicit FK between reviews.user_id and profiles)
    const { data: reviews } = await supabaseAdmin
      .from('reviews')
      .select('id, rating, comment, created_at, user_id')
      .eq('product_id', id)
      .order('created_at', { ascending: false });

    let reviewsWithProfiles: any[] = [];
    if (reviews && reviews.length > 0) {
      const userIds = [...new Set(reviews.map(r => r.user_id))];
      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', userIds);

      const profileMap = new Map((profiles ?? []).map(p => [p.id, p]));
      reviewsWithProfiles = reviews.map(r => ({
        ...r,
        profiles: profileMap.get(r.user_id) ?? { full_name: 'Anonymous', avatar_url: null },
      }));
    }

    res.json({ ...product, reviews: reviewsWithProfiles });
  } catch (err: any) {
    console.error('[getProduct] unexpected error:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  try {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const productData = parsed.data;
    if (!productData.slug) {
      productData.slug = productData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    }

    const { data, error } = await supabaseAdmin
      .from('products')
      .insert(productData)
      .select()
      .single();

    if (error) throw error;

    // Update category product count
    await supabaseAdmin.rpc('increment_category_count', { cat_id: productData.category_id });

    res.status(201).json(data);
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Product with this slug already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create product' });
  }
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const parsed = productSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
}

export async function deleteProduct(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('products').delete().eq('id', id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
}

export async function bulkUpdateProducts(req: Request, res: Response): Promise<void> {
  try {
    const { ids, action, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array required' });
      return;
    }

    if (action === 'delete') {
      const { error } = await supabaseAdmin.from('products').delete().in('id', ids);
      if (error) throw error;
      res.json({ message: `${ids.length} products deleted` });
    } else if (action === 'status' && status) {
      const { error } = await supabaseAdmin
        .from('products')
        .update({ status, updated_at: new Date().toISOString() })
        .in('id', ids);
      if (error) throw error;
      res.json({ message: `${ids.length} products updated` });
    } else {
      res.status(400).json({ error: 'Invalid bulk action' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Bulk operation failed' });
  }
}
