/**
 * Сборка Express-приложения.
 *
 * Приложение отдаёт только JSON API. Статику (index.html, style.css, script.js,
 * картинки) раздаёт Nginx — Node этим не занимается.
 */

import cors, { type CorsOptions } from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { contactRouter } from './routes/contact.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { productsRouter } from './routes/products.routes.js';

const corsOptions: CorsOptions = {
	origin(origin, callback) {
		// Запросы без Origin — это не браузер (curl, мониторинг, серверные проверки).
		// CORS их всё равно не защищает, поэтому пропускаем.
		if (!origin) {
			callback(null, true);
			return;
		}

		// Разбираем через URL, чтобы сравнивать нормализованные источники:
		// список в .env уже приведён к тому же виду (см. config/env.ts).
		let normalized: string;
		try {
			normalized = new URL(origin).origin;
		} catch {
			callback(new Error('CORS: некорректный заголовок Origin'));
			return;
		}

		if (env.CORS_ORIGINS.includes(normalized)) {
			callback(null, true);
			return;
		}

		// Префикс CORS: распознаётся в errorHandler и превращается в 403 без стека в логе.
		callback(new Error(`CORS: источник ${normalized} не разрешён`));
	},
	methods: ['GET', 'POST', 'OPTIONS'],
	credentials: false,
	maxAge: 86_400,
};

export function createApp() {
	const app = express();

	/**
	 * Ровно один прокси впереди — Nginx. Не true: при true Express доверяет
	 * всей цепочке X-Forwarded-For, и клиент может подделать свой адрес,
	 * обойдя rate limit. Если прокси станет два (например, добавится CDN),
	 * это число нужно увеличить.
	 */
	app.set('trust proxy', 1);
	app.disable('x-powered-by');
	app.disable('etag'); // ETag каталога считаем сами, из состава снимка.

	app.use(helmet({
		// API потребляется фронтендом с другого origin при раздельном деплое;
		// доступ при этом всё равно ограничен списком CORS_ORIGINS.
		crossOriginResourcePolicy: { policy: 'cross-origin' },
	}));
	app.use(cors(corsOptions));

	// Форма — единственное, что мы принимаем. 32 КБ с запасом хватает.
	app.use(express.json({ limit: '32kb' }));

	app.use(requestLogger);
	app.use(globalLimiter);

	app.use('/api', healthRouter);
	app.use('/api', productsRouter);
	app.use('/api', contactRouter);

	app.use(notFound);
	app.use(errorHandler);

	return app;
}
