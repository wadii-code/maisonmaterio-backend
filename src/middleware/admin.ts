import { Request, Response, NextFunction } from 'express';

export type AdminRole = 'admin' | 'super_admin' | 'sub_admin';

export function isSuperAdmin(role?: string | null): boolean {
  // 'admin' is the legacy name for super_admin and is treated identically.
  return role === 'super_admin' || role === 'admin';
}

export function isAnyAdmin(role?: string | null): boolean {
  return isSuperAdmin(role) || role === 'sub_admin';
}

/**
 * Allows super_admin (and the legacy 'admin' role). Sub-admins are rejected.
 * Use this on every endpoint that touches global settings, customers, other admins, etc.
 */
export function superAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isSuperAdmin(req.user.role)) {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  next();
}

/**
 * Allows any admin role (super_admin OR sub_admin). Use this on endpoints
 * where ownership filtering happens inside the controller.
 */
export function anyAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isAnyAdmin(req.user.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Legacy name kept so existing routes keep compiling. Behaves like super_admin —
 * the most restrictive of the two so nothing is accidentally weakened.
 */
export const adminMiddleware = superAdminMiddleware;
