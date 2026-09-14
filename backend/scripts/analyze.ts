import { env } from '../src/config/env.js';

const BASE = 'https://api.partner.market.yandex.ru';

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
	const r = await fetch(BASE + path, {
		method,
		headers: { 'Api-Key': env.YANDEX_API_KEY, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} на ${path}: ${(await r.text()).slice(0, 200)}`);
	return r.json();
}

async function main() {
	const campaigns = (await call('GET', '/v2/campaigns?limit=100')).campaigns as any[];

	// --- все товары ---
	const offers: any[] = [];
	let token: string | undefined;
	let page = 0;
	do {
		const qs = new URLSearchParams({ limit: '100' });
		if (token) qs.set('pageToken', token);
		const data = await call('POST', `/v2/businesses/${env.YANDEX_BUSINESS_ID}/offer-mappings?${qs}`, {
			archived: false,
		});
		offers.push(...(data.result?.offerMappings ?? []));
		token = data.result?.paging?.nextPageToken;
		page++;
	} while (token && page < 50);

	console.log(`Страниц: ${page}. Товаров (archived:false): ${offers.length}`);

	const statusCount: Record<string, number> = {};
	let anyPublished = 0;
	let noPrice = 0;
	let noPicture = 0;
	let noB2C = 0;
	for (const e of offers) {
		const st = (e.offer?.campaigns ?? []) as any[];
		for (const c of st) statusCount[c.status] = (statusCount[c.status] ?? 0) + 1;
		if (st.some((c) => c.status === 'PUBLISHED')) anyPublished++;
		if (!e.offer?.basicPrice?.value) noPrice++;
		if (!e.offer?.pictures?.length) noPicture++;
		if (!(e.showcaseUrls ?? []).some((u: any) => u.showcaseType === 'B2C')) noB2C++;
	}

	console.log('\nСтатусы по кампаниям (offer.campaigns[].status):');
	for (const [k, v] of Object.entries(statusCount).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k.padEnd(26)} ${v}`);
	}
	console.log(`\nТоваров со статусом PUBLISHED хотя бы в одной кампании: ${anyPublished}`);
	console.log(`Без цены: ${noPrice} | без картинки: ${noPicture} | без B2C-ссылки: ${noB2C}`);

	// --- остатки по всем кампаниям ---
	const stockByOffer = new Map<string, number>();
	for (const c of campaigns) {
		let t: string | undefined;
		let p = 0;
		let rows = 0;
		do {
			const qs = new URLSearchParams({ limit: '100' });
			if (t) qs.set('pageToken', t);
			const data = await call('POST', `/v2/campaigns/${c.id}/offers/stocks?${qs}`, { archived: false });
			for (const w of data.result?.warehouses ?? []) {
				for (const o of w.offers ?? []) {
					rows++;
					const avail = (o.stocks ?? []).filter((s: any) => s.type === 'AVAILABLE');
					const fit = (o.stocks ?? []).filter((s: any) => s.type === 'FIT');
					const use = avail.length > 0 ? avail : fit;
					const sum = use.reduce((acc: number, s: any) => acc + (s.count ?? 0), 0);
					stockByOffer.set(o.offerId, (stockByOffer.get(o.offerId) ?? 0) + sum);
				}
			}
			t = data.result?.paging?.nextPageToken;
			p++;
		} while (t && p < 50);
		console.log(`\nКампания ${c.id} (${c.domain}, ${c.placementType}): страниц ${p}, строк остатков ${rows}`);
	}

	const withStock = [...stockByOffer.values()].filter((v) => v > 0).length;
	console.log(`\nВсего offerId в остатках: ${stockByOffer.size}`);
	console.log(`Из них с остатком > 0 (суммарно по всем кампаниям): ${withStock}`);

	const survives = offers.filter((e) => {
		const id = e.offer?.offerId;
		const price = e.offer?.basicPrice?.value;
		const stock = stockByOffer.get(id);
		return price > 0 && (stock === undefined || stock > 0);
	}).length;
	console.log(`\n>>> Товаров попадёт в каталог при правиле "есть цена И остаток != 0": ${survives}`);

	const survivesPublished = offers.filter((e) =>
		(e.offer?.campaigns ?? []).some((c: any) => c.status === 'PUBLISHED'),
	).length;
	console.log(`>>> Товаров при правиле "PUBLISHED хотя бы где-то": ${survivesPublished}`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
