import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { z } from 'zod';

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const categorySchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(80).optional(),
  image_url: z.string().url().optional().nullable(),
  icon_url: z.string().url().optional().nullable(),
});

export async function getCategories(_req: Request, res: Response): Promise<void> {
  try {
    // Always return a fresh count of active products per category
    const { data: cats, error } = await supabaseAdmin
      .from('categories')
      .select('*')
      .order('name');
    if (error) throw error;

    // Update product_count to reflect actual count of active products
    const { data: counts } = await supabaseAdmin
      .from('products')
      .select('category_id')
      .eq('status', 'active');
    const countMap = (counts ?? []).reduce<Record<string, number>>((acc, p) => {
      acc[p.category_id] = (acc[p.category_id] ?? 0) + 1;
      return acc;
    }, {});

    const enriched = (cats ?? []).map(c => ({ ...c, product_count: countMap[c.id] ?? 0 }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }
    const payload = { ...parsed.data, slug: parsed.data.slug ?? slugify(parsed.data.name) };
    const { data, error } = await supabaseAdmin
      .from('categories')
      .insert(payload)
      .select()
      .single();
    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'A category with that slug already exists' });
        return;
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create category' });
  }
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const parsed = categorySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed' });
      return;
    }
    const payload: any = { ...parsed.data };
    if (parsed.data.name && !parsed.data.slug) payload.slug = slugify(parsed.data.name);
    const { data, error } = await supabaseAdmin
      .from('categories')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update category' });
  }
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    // Reject if products exist in this category
    const { count } = await supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', id);
    if ((count ?? 0) > 0) {
      res.status(409).json({
        error: `Cannot delete: ${count} product(s) still belong to this category. Move or delete them first.`,
      });
      return;
    }

    const { error } = await supabaseAdmin.from('categories').delete().eq('id', id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
}

export async function getRooms(_req: Request, res: Response): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('*')
      .order('name');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
}
