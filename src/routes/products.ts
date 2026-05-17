import { Router } from 'express';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { anyAdminMiddleware, superAdminMiddleware } from '../middleware/admin';
import {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkUpdateProducts,
} from '../controllers/productController';

const router = Router();

router.get('/', optionalAuth, getProducts);
router.get('/:id', optionalAuth, getProduct);

// Sub-admins can create products (they'll be auto-stamped as the creator).
router.post('/', authMiddleware, anyAdminMiddleware, createProduct);

// Bulk operations are super-admin-only — they affect rows owned by anybody.
router.put('/bulk', authMiddleware, superAdminMiddleware, bulkUpdateProducts);

// Update/delete is open to any admin; the controller enforces ownership for sub-admins.
router.put('/:id', authMiddleware, anyAdminMiddleware, updateProduct);
router.delete('/:id', authMiddleware, anyAdminMiddleware, deleteProduct);

export default router;
