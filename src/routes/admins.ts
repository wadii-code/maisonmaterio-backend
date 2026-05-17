import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { superAdminMiddleware } from '../middleware/admin';
import { supabaseAdmin } from '../config/supabase';
import { z } from 'zod';

const router = Router();

// All routes require super_admin.
router.use(authMiddleware, superAdminMiddleware);

const VALID_ROLES = ['super_admin', 'sub_admin'] as const;

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  full_name: z.string().min(1).max(120),
  role: z.enum(VALID_ROLES).default('sub_admin'),
});

const updateSchema = z.object({
  full_name: z.string().min(1).max(120).optional(),
  role: z.enum(VALID_ROLES).optional(),
  password: z.string().min(8).optional(),
});

/** GET /admins — list every admin (super + sub). */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, avatar_url, phone, created_at')
      .in('role', ['super_admin', 'sub_admin', 'admin'])
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with email + product count
    const ids = (profiles ?? []).map(p => p.id);
    const [{ data: usersList }, { data: productRows }] = await Promise.all([
      supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
      supabaseAdmin.from('products').select('id, created_by').in('created_by', ids),
    ]);

    const emailByUserId = new Map<string, string>();
    (usersList?.users ?? []).forEach(u => { if (u.id && u.email) emailByUserId.set(u.id, u.email); });

    const productCountByUser = new Map<string, number>();
    (productRows ?? []).forEach(p => {
      productCountByUser.set(p.created_by, (productCountByUser.get(p.created_by) ?? 0) + 1);
    });

    const enriched = (profiles ?? []).map(p => ({
      ...p,
      email: emailByUserId.get(p.id) ?? null,
      product_count: productCountByUser.get(p.id) ?? 0,
    }));

    res.json(enriched);
  } catch (err: any) {
    console.error('[admins] list error:', err?.message);
    res.status(500).json({ error: 'Failed to list admins' });
  }
});

/** POST /admins — create a new admin (super_admin or sub_admin). */
router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }
    const { email, password, full_name, role } = parsed.data;

    // Step 1 — create the auth user with email pre-confirmed so they can sign in immediately.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (createErr || !created.user) {
      const msg = createErr?.message ?? 'Failed to create user';
      // Friendly error if the email is already taken.
      if (msg.toLowerCase().includes('already')) {
        res.status(409).json({ error: 'Un compte avec cet e-mail existe déjà.' });
        return;
      }
      res.status(400).json({ error: msg });
      return;
    }

    const userId = created.user.id;

    // Step 2 — UPSERT the profile with the requested role. The `handle_new_user` trigger
    // (if installed) normally fires synchronously inside the previous auth.users INSERT and
    // creates a row with role='customer'. Our upsert overwrites it.
    const { error: upsertErr } = await supabaseAdmin
      .from('profiles')
      .upsert(
        { id: userId, full_name, role, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      );

    if (upsertErr) {
      console.error('[admins] upsert error:', upsertErr.message);
      // Roll back the auth user so we don't leave an orphaned account.
      await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
      res.status(500).json({ error: 'Failed to assign role: ' + upsertErr.message });
      return;
    }

    // Step 3 — verify the role actually stuck (defense against trigger races
    // or future RLS surprises). If not, force it with an explicit UPDATE.
    const { data: check } = await supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();

    if (!check || check.role !== role) {
      console.warn('[admins] role mismatch after upsert, forcing update.', check?.role, '→', role);
      const { error: forceErr } = await supabaseAdmin
        .from('profiles')
        .update({ role, full_name, updated_at: new Date().toISOString() })
        .eq('id', userId);
      if (forceErr) {
        console.error('[admins] force update failed:', forceErr.message);
        await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
        res.status(500).json({ error: 'Failed to set admin role: ' + forceErr.message });
        return;
      }
    }

    // Step 4 — return the freshly-stored row so the UI shows the right state.
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, created_at, avatar_url, phone')
      .eq('id', userId)
      .single();

    console.log(`[admins] created ${role}: ${email} (${userId})`);
    res.status(201).json({ ...profile, email });
  } catch (err: any) {
    console.error('[admins] create error:', err?.message, err);
    res.status(500).json({ error: err?.message ?? 'Failed to create admin' });
  }
});

/** PUT /admins/:id — update name, role, or password. Cannot self-demote. */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }
    const { full_name, role, password } = parsed.data;

    // A super_admin cannot demote themselves — would lock them out.
    if (id === req.user!.id && role && role !== 'super_admin' && role !== 'admin') {
      res.status(400).json({ error: 'You cannot change your own role.' });
      return;
    }

    if (password) {
      const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
      if (pwErr) {
        res.status(400).json({ error: pwErr.message });
        return;
      }
    }

    const profileUpdates: Record<string, any> = {};
    if (full_name !== undefined) profileUpdates.full_name = full_name;
    if (role !== undefined) profileUpdates.role = role;

    let profile: any = null;
    if (Object.keys(profileUpdates).length > 0) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .update(profileUpdates)
        .eq('id', id)
        .select()
        .single();
      if (error || !data) {
        res.status(404).json({ error: 'Admin not found' });
        return;
      }
      profile = data;
    } else {
      const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', id).maybeSingle();
      profile = data;
    }

    res.json(profile);
  } catch (err: any) {
    console.error('[admins] update error:', err?.message);
    res.status(500).json({ error: 'Failed to update admin' });
  }
});

/** DELETE /admins/:id — remove the admin account entirely. */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (id === req.user!.id) {
      res.status(400).json({ error: 'You cannot delete your own account.' });
      return;
    }

    // Unlink their products from them so they're not orphaned by FK cascade.
    // (The FK is ON DELETE SET NULL, so this is already safe — kept here as a
    //  defensive no-op for clarity.)
    await supabaseAdmin.from('products').update({ created_by: null }).eq('created_by', id);

    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authErr) {
      // Profile row is removed via ON DELETE CASCADE from auth.users when auth deletes succeed,
      // but if it fails we still try to nuke the profile row.
      await supabaseAdmin.from('profiles').delete().eq('id', id);
      res.status(500).json({ error: authErr.message });
      return;
    }

    res.status(204).send();
  } catch (err: any) {
    console.error('[admins] delete error:', err?.message);
    res.status(500).json({ error: 'Failed to delete admin' });
  }
});

export default router;
