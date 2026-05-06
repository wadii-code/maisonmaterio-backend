import { Router } from 'express';
import { getCategories, getRooms } from '../controllers/categoryController';

const router = Router();

router.get('/', getCategories);

export { router as categoryRouter };

export const roomRouter = Router();
roomRouter.get('/', getRooms);
