import { Router } from 'express';

import { getHealth } from '../controllers/products.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', getHealth);
