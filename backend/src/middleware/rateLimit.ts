/**
 * Лимиты частоты запросов.
 *
 * Работают поверх app.set('trust proxy', 1): за Nginx реальный адрес клиента
 * приходит в X-Forwarded-For. Значение ровно 1, а не true — при true заголовок
 * можно подделать и обойти лимит, а без него все запросы выглядят как 127.0.0.1
 * и один спамер блокирует вообще всех.
 */

import rateLimit, { type Options } from 'express-rate-limit';

import { logger } from '../lib/logger.js';

function makeLimiter(name: string, windowMs: number, limit: number, message: string) {
	const options: Partial<Options> = {
		windowMs,
		limit,
		standardHeaders: 'draft-7',
		legacyHeaders: false,
		handler: (req, res) => {
			// Логируем факт, но не тело запроса.
			logger.warn('Сработал лимит частоты', { limiter: name, path: req.path });
			res.status(429).json({ ok: false, error: message });
		},
	};

	return rateLimit(options);
}

/**
 * Форма обратной связи — самое чувствительное место: каждый успешный запрос
 * превращается в письмо. Пять отправок за 15 минут с одного адреса — потолок,
 * которого живому человеку хватает с запасом.
 */
export const contactLimiter = makeLimiter(
	'contact',
	15 * 60 * 1000,
	5,
	'Слишком много обращений. Попробуйте ещё раз через несколько минут.',
);

/**
 * Каталог отдаётся из памяти, поэтому лимит щедрый — он защищает
 * не Маркет (туда запрос пользователя не идёт), а сам сервер от абьюза.
 */
export const productsLimiter = makeLimiter(
	'products',
	60 * 1000,
	60,
	'Слишком много запросов каталога.',
);

/** Общий потолок на все маршруты. */
export const globalLimiter = makeLimiter(
	'global',
	60 * 1000,
	300,
	'Слишком много запросов.',
);
