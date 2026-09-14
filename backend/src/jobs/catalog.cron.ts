/**
 * Периодическое обновление каталога.
 *
 * noOverlap: true — если предыдущий прогон ещё идёт (Маркет тормозит,
 * сработали ретраи), новый не стартует. Дополнительно от параллельного
 * запуска защищает сам catalog.service через общий промис.
 */

import cron, { type ScheduledTask } from 'node-cron';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { refreshCatalog } from '../services/catalog.service.js';

let task: ScheduledTask | null = null;

export function startCatalogCron(): void {
	if (!cron.validate(env.CATALOG_REFRESH_CRON)) {
		logger.error('CATALOG_REFRESH_CRON содержит некорректное выражение — автообновление выключено', {
			expression: env.CATALOG_REFRESH_CRON,
		});
		return;
	}

	task = cron.schedule(
		env.CATALOG_REFRESH_CRON,
		() => {
			void refreshCatalog('cron');
		},
		{ noOverlap: true, timezone: 'Europe/Moscow' },
	);

	logger.info('Автообновление каталога включено', { cron: env.CATALOG_REFRESH_CRON });
}

export async function stopCatalogCron(): Promise<void> {
	if (!task) return;
	await task.destroy();
	task = null;
}
