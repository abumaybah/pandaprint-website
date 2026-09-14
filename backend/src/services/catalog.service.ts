/**
 * Кэш каталога.
 *
 * Правило номер один: HTTP-запрос пользователя НИКОГДА не идёт в Яндекс.
 * Эндпоинт отдаёт то, что лежит в памяти. Наполняет память только фоновое
 * обновление — по расписанию (node-cron) и один раз при старте.
 *
 * Кэш дублируется на диск, поэтому рестарт процесса, деплой или рециклинг
 * на хостинге не оставляют сайт с пустым каталогом и не приводят к лишнему
 * походу в Маркет на каждый запуск.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeError, logger } from '../lib/logger.js';
import { fetchCatalog, type CatalogStats, type Product } from './yandexMarket.service.js';

/** backend/data — одинаково считается и из src (tsx), и из dist (прод). */
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const CACHE_FILE = resolve(DATA_DIR, 'catalog.json');
const TEMP_FILE = resolve(DATA_DIR, 'catalog.json.tmp');

export interface CatalogSnapshot {
	products: Product[];
	updatedAt: string;
	count: number;
}

let snapshot: CatalogSnapshot | null = null;

/** Промис текущего обновления: не даём двум запускаться одновременно. */
let inFlight: Promise<void> | null = null;

let lastError: { at: string; message: string } | null = null;
let lastStats: CatalogStats | null = null;

/** Слабый ETag по составу снимка — этого достаточно, чтобы браузер получил 304. */
export function catalogEtag(current: CatalogSnapshot): string {
	return `W/"${current.count}-${Date.parse(current.updatedAt)}"`;
}

export function getCatalog(): CatalogSnapshot | null {
	return snapshot;
}

export function getCatalogHealth() {
	return {
		hasData: snapshot !== null,
		count: snapshot?.count ?? 0,
		updatedAt: snapshot?.updatedAt ?? null,
		refreshing: inFlight !== null,
		lastError,
		lastStats,
	};
}

function isValidSnapshot(value: unknown): value is CatalogSnapshot {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<CatalogSnapshot>;
	return (
		Array.isArray(candidate.products) &&
		typeof candidate.updatedAt === 'string' &&
		Number.isFinite(Date.parse(candidate.updatedAt))
	);
}

/** Поднимает прошлый снимок с диска, чтобы отдавать каталог с первой секунды. */
export async function loadCatalogFromDisk(): Promise<void> {
	try {
		const parsed: unknown = JSON.parse(await readFile(CACHE_FILE, 'utf8'));

		if (!isValidSnapshot(parsed)) {
			logger.warn('Файл кэша повреждён — игнорируем', { file: CACHE_FILE });
			return;
		}

		snapshot = { ...parsed, count: parsed.products.length };
		logger.info('Кэш каталога поднят с диска', {
			count: snapshot.count,
			updatedAt: snapshot.updatedAt,
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			logger.info('Файла кэша нет — ждём первого обновления');
			return;
		}
		logger.warn('Не удалось прочитать кэш с диска', describeError(error));
	}
}

/** Пишем через временный файл, чтобы падение на середине не оставило обрезанный JSON. */
async function persist(current: CatalogSnapshot): Promise<void> {
	try {
		await mkdir(DATA_DIR, { recursive: true });
		await writeFile(TEMP_FILE, JSON.stringify(current), 'utf8');
		await rename(TEMP_FILE, CACHE_FILE);
	} catch (error) {
		// Диск недоступен (например, read-only ФС на хостинге) — это не повод
		// ронять обновление: в памяти каталог уже свежий.
		logger.warn('Не удалось сохранить кэш на диск', describeError(error));
	}
}

/**
 * Обновляет каталог. Параллельные вызовы получают один и тот же промис.
 * Если обновление упало, прошлый снимок остаётся в силе — каталог не пустеет.
 */
export function refreshCatalog(reason: string): Promise<void> {
	if (inFlight) {
		logger.debug('Обновление уже идёт — присоединяемся', { reason });
		return inFlight;
	}

	const startedAt = Date.now();

	inFlight = (async () => {
		logger.info('Обновление каталога началось', { reason });

		try {
			const { products, stats } = await fetchCatalog();

			snapshot = {
				products,
				count: products.length,
				updatedAt: new Date().toISOString(),
			};
			lastStats = stats;
			lastError = null;

			await persist(snapshot);

			logger.info('Каталог обновлён', {
				reason,
				durationMs: Date.now() - startedAt,
				...stats,
			});
		} catch (error) {
			const described = describeError(error);
			lastError = {
				at: new Date().toISOString(),
				message: String(described.errMsg ?? 'неизвестная ошибка'),
			};

			logger.error('Обновление каталога не удалось — отдаём прошлый кэш', {
				reason,
				durationMs: Date.now() - startedAt,
				servingCount: snapshot?.count ?? 0,
				...described,
			});
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}
