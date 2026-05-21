import { Router } from 'express';
import { authMiddleware, optionalAuth } from '../middleware/auth';
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
// Guest checkout allowed — optionalAuth attaches req.user if a token is present,
// otherwise the order is created as a guest (user_id = null).
router.post('/', optionalAuth, createOrder);
// Customers can cancel their own pending orders; admins can change anything.
// Authorization is enforced inside the controller.
router.put('/:id/status', authMiddleware, updateOrderStatus);

export default router;
