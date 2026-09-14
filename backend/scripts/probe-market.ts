/**
 * Одноразовая разведка Партнёрского API.
 *
 * Задача — увидеть РЕАЛЬНУЮ форму ответа нашего кабинета, а не ту,
 * что описана в документации. Маппер в yandexMarket.service.ts пишется
 * по выводу этого скрипта.
 *
 *   npm run probe
 *
 * Токен в вывод не попадает: он уходит только в заголовок запроса.
 */

import { env } from '../src/config/env.js';

const BASE = 'https://api.partner.market.yandex.ru';

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(BASE + path, {
		method,
		headers: {
			'Api-Key': env.YANDEX_API_KEY,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const text = await response.text();
	console.log(`\n${method} ${path} -> HTTP ${response.status}`);

	try {
		return JSON.parse(text);
	} catch {
		console.log('  (ответ не JSON):', text.slice(0, 400));
		return null;
	}
}

/** Рекурсивно заменяет значения на их типы — печатать можно смело. */
function shape(value: unknown): unknown {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		return value.length === 0 ? '[] (пусто)' : [shape(value[0]), `…всего ${value.length}`];
	}
	if (typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
	}
	return typeof value;
}

function dump(label: string, value: unknown): void {
	console.log(`\n--- ${label} ---`);
	console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
	// 1. Какие кампании видит токен и совпадает ли business.id с нашим.
	const campaigns = (await call('GET', '/v2/campaigns?limit=100')) as any;
	dump('campaigns (как есть)', campaigns);

	const campaignId =
		env.YANDEX_CAMPAIGN_ID ??
		campaigns?.campaigns?.find((c: any) => String(c?.business?.id) === env.YANDEX_BUSINESS_ID)?.id ??
		campaigns?.campaigns?.[0]?.id;

	console.log(`\n>>> выбранный campaignId: ${campaignId ?? 'НЕ НАЙДЕН'}`);

	// 2. Форма ответа по товарам + один живой пример целиком.
	const offers = (await call(
		'POST',
		`/v2/businesses/${env.YANDEX_BUSINESS_ID}/offer-mappings?limit=2`,
		{ archived: false },
	)) as any;

	dump('offer-mappings: СХЕМА (типы вместо значений)', shape(offers));
	dump('offer-mappings: первый элемент целиком', offers?.result?.offerMappings?.[0]);
	console.log('\nnextPageToken присутствует:', Boolean(offers?.result?.paging?.nextPageToken));

	// 3. Остатки — отдельный метод, ходит по campaignId.
	if (campaignId) {
		const stocks = (await call('POST', `/v2/campaigns/${campaignId}/offers/stocks?limit=2`, {
			archived: false,
		})) as any;

		dump('stocks: СХЕМА', shape(stocks));
		dump('stocks: первый склад целиком', stocks?.result?.warehouses?.[0]);
	}
}

main().catch((error) => {
	console.error('Пробный запрос упал:', error instanceof Error ? error.message : error);
	process.exit(1);
});
