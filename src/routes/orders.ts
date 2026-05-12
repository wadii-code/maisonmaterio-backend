import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import {
  getOrders,
  getOrder,
  createOrder,
  updateOrderStatus,
  getDashboardStats,
} from '../controllers/orderController';

const router = Router();

router.get('/dashboard-stats', authMiddleware, adminMiddleware, getDashboardStats);
router.get('/', authMiddleware, getOrders);
router.get('/:id', authMiddleware, getOrder);
router.post('/', authMiddleware, createOrder);
// Customers can cancel their own pending orders; admins can change anything.
// Authorization is enforced inside the controller.
router.put('/:id/status', authMiddleware, updateOrderStatus);

export default router;
