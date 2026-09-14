/**
 * Zod-схемы ответов Партнёрского API Яндекс.Маркета.
 *
 * Описаны по РЕАЛЬНЫМ ответам нашего кабинета (scripts/probe-market.ts),
 * а не только по документации. Валидируем ровно те поля, которые используем:
 * если Яндекс добавит новые — они просто отбросятся, если уберёт нужное —
 * получим внятную ошибку в логе вместо undefined в карточке товара.
 *
 * Побочный полезный эффект: z.object по умолчанию срезает лишние ключи,
 * поэтому громоздкие description и mediaFiles не доезжают до кэша.
 */

import { z } from 'zod';

/* ------------------------------- Кампании ------------------------------- */

export const CampaignsResponseSchema = z.object({
	campaigns: z
		.array(
			z.object({
				id: z.number(),
				domain: z.string().optional(),
				placementType: z.string().optional(),
				apiAvailability: z.string().optional(),
				business: z.object({ id: z.number() }).nullish(),
			}),
		)
		.default([]),
});

export type MarketCampaign = z.infer<typeof CampaignsResponseSchema>['campaigns'][number];

/* -------------------------------- Товары -------------------------------- */

const PagingSchema = z.object({ nextPageToken: z.string().optional() }).nullish();

export const OfferMappingsResponseSchema = z.object({
	result: z.object({
		paging: PagingSchema,
		offerMappings: z
			.array(
				z.object({
					offer: z.object({
						offerId: z.string(),
						name: z.string().optional(),
						pictures: z.array(z.string()).nullish(),
						basicPrice: z
							.object({
								value: z.number(),
								currencyId: z.string().optional(),
								discountBase: z.number().optional(),
							})
							.nullish(),
						/**
						 * Статус товара в каждой кампании кабинета.
						 * Встреченные значения: PUBLISHED, NO_STOCKS, DISABLED_AUTOMATICALLY.
						 */
						campaigns: z
							.array(z.object({ campaignId: z.number(), status: z.string() }))
							.nullish(),
					}),
					mapping: z
						.object({
							marketSku: z.number().optional(),
							marketCategoryName: z.string().optional(),
						})
						.nullish(),
					/** Лежит на элементе, а не внутри offer. */
					showcaseUrls: z
						.array(z.object({ showcaseType: z.string(), showcaseUrl: z.string() }))
						.nullish(),
				}),
			)
			.default([]),
	}),
});

export type OfferMapping =
	z.infer<typeof OfferMappingsResponseSchema>['result']['offerMappings'][number];

/* ------------------------------- Остатки -------------------------------- */

export const StocksResponseSchema = z.object({
	result: z.object({
		paging: PagingSchema,
		warehouses: z
			.array(
				z.object({
					warehouseId: z.number().optional(),
					offers: z
						.array(
							z.object({
								offerId: z.string(),
								stocks: z
									.array(z.object({ type: z.string(), count: z.number() }))
									.default([]),
							}),
						)
						.default([]),
				}),
			)
			.default([]),
	}),
});

/* -------------------------------- Ошибки -------------------------------- */

export const MarketErrorSchema = z.object({
	status: z.literal('ERROR').optional(),
	errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })).optional(),
});
