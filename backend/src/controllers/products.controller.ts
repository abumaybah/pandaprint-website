/**
 * Отдача каталога.
 *
 * Здесь нет и не должно быть ни одного обращения к Яндексу: контроллер
 * работает только с тем, что уже лежит в кэше. Наполнением занимается
 * фоновое обновление (jobs/catalog.cron.ts).
 */

import type { RequestHandler } from 'express';

import { catalogEtag, getCatalog, getCatalogHealth } from '../services/catalog.service.js';

/** Пять минут — компромисс между свежестью и лишними мегабайтами трафика. */
const BROWSER_CACHE_SECONDS = 300;

export const getProducts: RequestHandler = (req, res) => {
	const snapshot = getCatalog();

	if (!snapshot) {
		// Первое обновление ещё не завершилось и на диске ничего не было.
		res.status(503).json({
			ok: false,
			error: 'Каталог ещё загружается, обновите страницу через минуту',
		});
		return;
	}

	const etag = catalogEtag(snapshot);
	res.setHeader('ETag', etag);
	res.setHeader('Cache-Control', `public, max-age=${BROWSER_CACHE_SECONDS}`);

	if (req.headers['if-none-match'] === etag) {
		res.status(304).end();
		return;
	}

	res.json({
		updatedAt: snapshot.updatedAt,
		count: snapshot.count,
		products: snapshot.products,
	});
};

/** Диагностика: состояние кэша без единого байта пользовательских данных. */
export const getHealth: RequestHandler = (_req, res) => {
	const health = getCatalogHealth();

	res.status(health.hasData ? 200 : 503).json({
		ok: health.hasData,
		catalog: health,
		uptimeSeconds: Math.round(process.uptime()),
	});
};
