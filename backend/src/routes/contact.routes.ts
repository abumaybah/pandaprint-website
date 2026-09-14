import { Router } from 'express';

import { postContact } from '../controllers/contact.controller.js';
import { contactLimiter } from '../middleware/rateLimit.js';

export const contactRouter = Router();

contactRouter.post('/contact', contactLimiter, postContact);
