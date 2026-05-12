import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { optionalAuth } from '../middleware/auth';
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
router.post('/', authMiddleware, adminMiddleware, createProduct);
router.put('/bulk', authMiddleware, adminMiddleware, bulkUpdateProducts);
router.put('/:id', authMiddleware, adminMiddleware, updateProduct);
router.delete('/:id', authMiddleware, adminMiddleware, deleteProduct);

export default router;
