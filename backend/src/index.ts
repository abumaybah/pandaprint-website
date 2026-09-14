/**
 * Точка входа.
 *
 * Порядок запуска выбран так, чтобы сайт как можно раньше начал отдавать данные:
 *   1) поднимаем прошлый кэш с диска — каталог доступен с первой секунды;
 *   2) начинаем слушать порт;
 *   3) уже в фоне идём в Маркет за свежими данными, проверяем SMTP
 *      и включаем расписание.
 * Ни один из фоновых шагов не блокирует старт и не роняет процесс при сбое.
 */

import type { Server } from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { startCatalogCron, stopCatalogCron } from './jobs/catalog.cron.js';
import { describeError, logger } from './lib/logger.js';
import { loadCatalogFromDisk, refreshCatalog } from './services/catalog.service.js';
import { verifyMailer } from './services/mailer.service.js';

let server: Server | null = null;

async function shutdown(signal: string): Promise<void> {
	logger.info('Остановка сервера', { signal });

	await stopCatalogCron();

	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
	}

	process.exit(0);
}

async function main(): Promise<void> {
	await loadCatalogFromDisk();

	const app = createApp();

	server = app.listen(env.PORT, env.HOST, () => {
		logger.info('Сервер запущен', {
			host: env.HOST,
			port: env.PORT,
			env: env.NODE_ENV,
			corsOrigins: env.CORS_ORIGINS,
		});
	});

	// Фоновая инициализация: старт сервера её не ждёт.
	void refreshCatalog('startup');
	void verifyMailer();

	startCatalogCron();

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			void shutdown(signal);
		});
	}

	// Необработанные отказы не должны валить процесс молча — логируем и живём дальше.
	process.on('unhandledRejection', (reason) => {
		logger.error('Необработанный отказ промиса', describeError(reason));
	});
}

main().catch((error) => {
	logger.error('Не удалось запустить сервер', describeError(error));
	process.exit(1);
});
