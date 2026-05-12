import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import {
  getReviewEligibility,
  createReview,
  getAdminReviews,
  deleteReview,
} from '../controllers/reviewController';

const router = Router();

router.get('/eligibility/:productId', authMiddleware, getReviewEligibility);
router.post('/', authMiddleware, createReview);
router.get('/admin', authMiddleware, adminMiddleware, getAdminReviews);
router.delete('/:id', authMiddleware, adminMiddleware, deleteReview);

export default router;
