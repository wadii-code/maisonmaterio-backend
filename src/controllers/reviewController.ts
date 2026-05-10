import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { z } from 'zod';

const reviewSchema = z.object({
  product_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(10).max(2000),
});

export async function getReviewEligibility(req: Request, res: Response): Promise<void> {
  try {
    const { productId } = req.params;
    const userId = req.user!.id;

    // Has the user purchased this product in a delivered order?
    const { data: orders } = await supabaseAdmin
      .from('order_items')
      .select('id, orders!inner(status, user_id)')
      .eq('product_id', productId)
      .eq('orders.user_id', userId)
      .in('orders.status', ['shipped', 'delivered']);

    const has_purchased = (orders?.length ?? 0) > 0;

    // Has the user already reviewed?
    const { data: existingReview } = await supabaseAdmin
      .from('reviews')
      .select('id')
      .eq('product_id', productId)
      .eq('user_id', userId)
      .maybeSingle();

    const has_reviewed = !!existingReview;

    res.json({
      can_review: has_purchased && !has_reviewed,
      has_purchased,
      has_reviewed,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check review eligibility' });
  }
}

export async function createReview(req: Request, res: Response): Promise<void> {
  try {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { product_id, rating, comment } = parsed.data;
    const userId = req.user!.id;

    // Verify purchase
    const { data: orders } = await supabaseAdmin
      .from('order_items')
      .select('id, orders!inner(status, user_id)')
      .eq('product_id', product_id)
      .eq('orders.user_id', userId)
      .in('orders.status', ['shipped', 'delivered']);

    if (!orders || orders.length === 0) {
      res.status(403).json({ error: 'You can review this product once it has been shipped or delivered.' });
      return;
    }

    // Check existing
    const { data: existing } = await supabaseAdmin
      .from('reviews')
      .select('id')
      .eq('product_id', product_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      res.status(409).json({ error: 'You have already reviewed this product' });
      return;
    }

    // Insert review
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .insert({
        product_id,
        user_id: userId,
        rating,
        comment,
        // Ensure admin listing can see the new review even if the DB expects a value
        status: 'active',
      })
      .select()
      .single();

    if (error) throw error;

    // Recompute aggregates on product
    const { data: allReviews } = await supabaseAdmin
      .from('reviews')
      .select('rating')
      .eq('product_id', product_id);

    const reviewList = allReviews ?? [];
    const avgRating = reviewList.length > 0
      ? reviewList.reduce((sum, r) => sum + r.rating, 0) / reviewList.length
      : 0;

    await supabaseAdmin
      .from('products')
      .update({ rating: Number(avgRating.toFixed(2)), review_count: reviewList.length })
      .eq('id', product_id);

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create review' });
  }
}

export async function getAdminReviews(_req: Request, res: Response): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select('*, profiles(full_name, avatar_url), products(name, images)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
}

export async function deleteReview(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { data: review } = await supabaseAdmin
      .from('reviews')
      .select('product_id')
      .eq('id', id)
      .single();

    const { error } = await supabaseAdmin.from('reviews').delete().eq('id', id);
    if (error) throw error;

    if (review) {
      const { data: remaining } = await supabaseAdmin
        .from('reviews')
        .select('rating')
        .eq('product_id', review.product_id);

      const list = remaining ?? [];
      const avg = list.length > 0 ? list.reduce((s, r) => s + r.rating, 0) / list.length : 0;
      await supabaseAdmin
        .from('products')
        .update({ rating: Number(avg.toFixed(2)), review_count: list.length })
        .eq('id', review.product_id);
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete review' });
  }
}
