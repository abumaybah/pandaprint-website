/**
 * Access-лог.
 *
 * Пишем метод, путь, код ответа и длительность. Тело запроса не логируется
 * никогда: в нём могут быть имя, контакт и текст обращения пользователя.
 * Строка запроса тоже не пишется — только path, без query.
 */

import type { RequestHandler } from 'express';

import { logger } from '../lib/logger.js';

export const requestLogger: RequestHandler = (req, res, next) => {
	const startedAt = process.hrtime.bigint();

	res.on('finish', () => {
		const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

		logger.info('request', {
			method: req.method,
			path: req.path,
			status: res.statusCode,
			durationMs: Math.round(durationMs),
		});
	});

	next();
};
