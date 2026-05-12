import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getRooms,
} from '../controllers/categoryController';

const router = Router();

router.get('/', getCategories);
router.post('/', authMiddleware, adminMiddleware, createCategory);
router.put('/:id', authMiddleware, adminMiddleware, updateCategory);
router.delete('/:id', authMiddleware, adminMiddleware, deleteCategory);

export { router as categoryRouter };

export const roomRouter = Router();
roomRouter.get('/', getRooms);
