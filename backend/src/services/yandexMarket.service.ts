/**
 * Клиент Партнёрского API Яндекс.Маркета.
 *
 * Единственное место в проекте, где используется YANDEX_API_KEY.
 * Токен уходит только в заголовок Api-Key и никогда не попадает
 * ни в URL, ни в логи, ни в ответы наших эндпоинтов.
 *
 * Ограничения площадки, под которые всё написано:
 *  - не больше 4 одновременных запросов на кабинет, поэтому страницы
 *    тянутся строго последовательно, никакого Promise.all;
 *  - при превышении приходит HTTP 420 Enhance Your Calm — он в списке
 *    повторяемых кодов и обрабатывается паузой с ростом задержки.
 */

import { env } from '../config/env.js';
import { describeError, logger } from '../lib/logger.js';
import {
	CampaignsResponseSchema,
	MarketErrorSchema,
	OfferMappingsResponseSchema,
	StocksResponseSchema,
} from '../schemas/market.schema.js';
import type { z } from 'zod';

const API_BASE = 'https://api.partner.market.yandex.ru';

/** Максимум, который принимает Маркет. Старый код слал 200 и получал отказ. */
const PAGE_LIMIT = 100;

/** Предохранитель от бесконечной пагинации, если nextPageToken зациклится. */
const MAX_PAGES = 50;

/**
 * 45 секунд, а не 30: на практике Маркет иногда отдаёт страницу товаров
 * дольше половины минуты, и более короткий таймаут заставлял делать лишний
 * повтор. Пользователь этого ожидания не видит — обновление фоновое.
 */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([420, 425, 429, 500, 502, 503, 504]);

export interface Product {
	source: 'Yandex Market';
	offerId: string;
	name: string;
	price: number;
	oldPrice: number | null;
	image: string;
	url: string;
	category: string;
	/** null означает «остаток неизвестен», а не «ноль» — это важно при фильтрации. */
	stock: number | null;
}

export interface CatalogStats {
	total: number;
	noPrice: number;
	outOfStock: number;
	notPublished: number;
	unknownStock: number;
	kept: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class MarketApiError extends Error {
	fatal: boolean;

	constructor(message: string, options?: { status?: number; fatal?: boolean }) {
		super(message);
		this.name = 'MarketApiError';
		this.status = options?.status;
		this.fatal = options?.fatal ?? false;
	}

	status?: number;
}

/**
 * Один запрос к API с ретраями и разбором ответа по схеме.
 * В текст ошибки кладём только код и сообщение от Маркета — тело целиком не логируем.
 */
async function marketRequest<S extends z.ZodType>(
	method: 'GET' | 'POST',
	path: string,
	schema: S,
	body?: unknown,
): Promise<z.infer<S>> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(API_BASE + path, {
				method,
				headers: {
					'Api-Key': env.YANDEX_API_KEY,
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			const raw = await response.text();

			if (!response.ok) {
				let detail = '';
				try {
					const parsed = MarketErrorSchema.safeParse(JSON.parse(raw));
					if (parsed.success && parsed.data.errors?.length) {
						detail = parsed.data.errors
							.map((item) => [item.code, item.message].filter(Boolean).join(': '))
							.join('; ');
					}
				} catch {
					detail = raw.slice(0, 200);
				}

				throw new MarketApiError(
					`Маркет ответил ${response.status}${detail ? ` (${detail})` : ''}`,
					{
						status: response.status,
						// 401/403/400 повторять бессмысленно — ждём только временные сбои.
						fatal: !RETRYABLE_STATUSES.has(response.status),
					},
				);
			}

			const parsed = schema.safeParse(JSON.parse(raw));
			if (!parsed.success) {
				const where = parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join('.')} ${issue.message}`)
					.join('; ');

				throw new MarketApiError(`Формат ответа Маркета изменился на ${path}: ${where}`, {
					fatal: true,
				});
			}

			return parsed.data;
		} catch (error) {
			lastError = error;

			if (error instanceof MarketApiError && error.fatal) break;
			if (attempt === MAX_ATTEMPTS) break;

			const delayMs = 1000 * 2 ** (attempt - 1);
			logger.warn('Повтор запроса к Маркету', {
				path,
				attempt,
				delayMs,
				...describeError(error),
			});
			await sleep(delayMs);
		}
	}

	throw lastError;
}

/**
 * Постранично выкачивает всё, что отдаёт метод. Строго последовательно.
 */
async function fetchAllPages<S extends z.ZodType, T>(
	label: string,
	buildPath: (query: string) => string,
	schema: S,
	body: unknown,
	collect: (data: z.infer<S>) => T[],
	nextToken: (data: z.infer<S>) => string | undefined,
): Promise<T[]> {
	const items: T[] = [];
	let pageToken: string | undefined;
	let pages = 0;

	do {
		const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
		if (pageToken) query.set('pageToken', pageToken);

		const data = await marketRequest('POST', buildPath(query.toString()), schema, body);
		items.push(...collect(data));

		const token = nextToken(data);
		// Если токен не изменился, пагинация не работает — выходим, а не крутимся вечно.
		pageToken = token && token !== pageToken ? token : undefined;
		pages++;
	} while (pageToken && pages < MAX_PAGES);

	if (pages >= MAX_PAGES && pageToken) {
		logger.warn('Достигнут потолок страниц — выгрузка могла остаться неполной', {
			label,
			pages,
			collected: items.length,
		});
	}

	logger.debug('Выгрузка завершена', { label, pages, items: items.length });
	return items;
}

/**
 * Все кампании (магазины) нашего кабинета.
 *
 * В кабинете Panda Print их три — два FBS и один FBY, — и остатки у каждой свои.
 * Поэтому берём именно все: товар доступен, если он есть хотя бы на одном складе.
 * YANDEX_CAMPAIGN_ID сужает выборку до одной конкретной.
 */
export async function resolveCampaignIds(): Promise<number[]> {
	if (env.YANDEX_CAMPAIGN_ID) {
		return [Number(env.YANDEX_CAMPAIGN_ID)];
	}

	const data = await marketRequest('GET', '/v2/campaigns?limit=100', CampaignsResponseSchema);

	const ours = data.campaigns.filter(
		(campaign) => String(campaign.business?.id ?? '') === env.YANDEX_BUSINESS_ID,
	);
	const chosen = ours.length > 0 ? ours : data.campaigns;

	if (chosen.length === 0) {
		logger.warn('Токен не видит ни одной кампании — остатки будут неизвестны');
		return [];
	}

	logger.info('Кампании кабинета определены', {
		count: chosen.length,
		campaigns: chosen.map((campaign) => `${campaign.id}:${campaign.placementType ?? '?'}`),
	});

	return chosen.map((campaign) => campaign.id);
}

/** Все неархивные товары кабинета. */
function fetchOfferMappings() {
	return fetchAllPages(
		'offer-mappings',
		(query) => `/v2/businesses/${env.YANDEX_BUSINESS_ID}/offer-mappings?${query}`,
		OfferMappingsResponseSchema,
		{ archived: false },
		(data) => data.result.offerMappings,
		(data) => data.result.paging?.nextPageToken ?? undefined,
	);
}

/**
 * Суммарные остатки по offerId по всем кампаниям и складам.
 *
 * AVAILABLE — доступно к продаже (FBY), FIT — годный товар на складе (FBS).
 * Если пришли оба типа, берём AVAILABLE как более точный, иначе FIT.
 * Пустой массив stocks — это честный ноль, а не отсутствие данных.
 */
async function fetchStockMap(campaignIds: number[]): Promise<Map<string, number>> {
	const totals = new Map<string, number>();

	for (const campaignId of campaignIds) {
		try {
			const warehouses = await fetchAllPages(
				`stocks:${campaignId}`,
				(query) => `/v2/campaigns/${campaignId}/offers/stocks?${query}`,
				StocksResponseSchema,
				{ archived: false },
				(data) => data.result.warehouses,
				(data) => data.result.paging?.nextPageToken ?? undefined,
			);

			for (const warehouse of warehouses) {
				for (const offer of warehouse.offers) {
					const available = offer.stocks.filter((item) => item.type === 'AVAILABLE');
					const source =
						available.length > 0 ? available : offer.stocks.filter((item) => item.type === 'FIT');
					const sum = source.reduce((acc, item) => acc + item.count, 0);

					totals.set(offer.offerId, (totals.get(offer.offerId) ?? 0) + sum);
				}
			}
		} catch (error) {
			// Падение одной кампании не должно ронять весь каталог: товары,
			// по которым остаток не выяснился, останутся с stock = null и будут показаны.
			logger.error('Не удалось получить остатки по кампании', {
				campaignId,
				...describeError(error),
			});
		}
	}

	return totals;
}

/** Ссылка на карточку: витрина B2C, иначе собираем по marketSku в том же формате. */
function resolveProductUrl(
	showcaseUrls: { showcaseType: string; showcaseUrl: string }[] | null | undefined,
	marketSku: number | undefined,
): string {
	const b2c = showcaseUrls?.find((link) => link.showcaseType === 'B2C');
	if (b2c) return b2c.showcaseUrl;

	if (marketSku) {
		return `https://market.yandex.ru/card/slug/${marketSku}?businessId=${env.YANDEX_BUSINESS_ID}`;
	}
	return '';
}

/**
 * Полная сборка каталога: товары + остатки, приведённые к формату,
 * который уже умеет читать фронтенд.
 */
export async function fetchCatalog(): Promise<{ products: Product[]; stats: CatalogStats }> {
	const campaignIds = await resolveCampaignIds();
	const mappings = await fetchOfferMappings();
	const stockMap =
		campaignIds.length > 0 ? await fetchStockMap(campaignIds) : new Map<string, number>();

	const stats: CatalogStats = {
		total: mappings.length,
		noPrice: 0,
		outOfStock: 0,
		notPublished: 0,
		unknownStock: 0,
		kept: 0,
	};

	const products: Product[] = [];

	for (const entry of mappings) {
		const { offer, mapping, showcaseUrls } = entry;

		const price = offer.basicPrice?.value ?? 0;
		if (price <= 0) {
			stats.noPrice++;
			continue;
		}

		const stock = stockMap.has(offer.offerId) ? (stockMap.get(offer.offerId) as number) : null;
		if (stock === null) stats.unknownStock++;

		// Неизвестный остаток — не повод прятать товар. Ноль — повод.
		if (stock === 0) {
			stats.outOfStock++;
			continue;
		}

		// Товар без статуса PUBLISHED ни в одной кампании купить нельзя,
		// даже если на складе он числится: ссылка приведёт на мёртвую карточку.
		if (env.CATALOG_REQUIRE_PUBLISHED && offer.campaigns && offer.campaigns.length > 0) {
			if (!offer.campaigns.some((campaign) => campaign.status === 'PUBLISHED')) {
				stats.notPublished++;
				continue;
			}
		}

		const discountBase = offer.basicPrice?.discountBase ?? null;

		products.push({
			source: 'Yandex Market',
			offerId: offer.offerId,
			name: offer.name?.trim() || 'Без названия',
			price,
			oldPrice: discountBase !== null && discountBase > price ? discountBase : null,
			image: offer.pictures?.[0] ?? '',
			url: resolveProductUrl(showcaseUrls, mapping?.marketSku),
			category: mapping?.marketCategoryName?.trim() || 'Без категории',
			stock,
		});
	}

	stats.kept = products.length;
	return { products, stats };
}
