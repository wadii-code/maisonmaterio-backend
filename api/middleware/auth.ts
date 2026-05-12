import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    console.warn('[auth] Missing Authorization header on', req.method, req.path);
    res.status(401).json({ error: 'Missing or invalid authorization header. Make sure you are signed in.' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    console.warn('[auth] Token rejected on', req.method, req.path, '— reason:', error?.message ?? 'no user returned');
    res.status(401).json({
      error: 'Invalid or expired session. Please sign out and sign in again.',
      detail: error?.message,
    });
    return;
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  req.user = {
    id: user.id,
    email: user.email!,
    role: profile?.role ?? 'customer',
  };

  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.split(' ')[1];
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);

  if (user) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email!,
      role: profile?.role ?? 'customer',
    };
  }

  next();
}
