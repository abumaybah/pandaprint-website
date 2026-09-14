import { Router } from 'express';

import { getProducts } from '../controllers/products.controller.js';
import { productsLimiter } from '../middleware/rateLimit.js';

export const productsRouter = Router();

productsRouter.get('/products', productsLimiter, getProducts);
