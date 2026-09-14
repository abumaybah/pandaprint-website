/**
 * Единственное место, где читается process.env.
 *
 * Схема проверяется на старте: если переменной нет или она кривая —
 * процесс падает сразу с понятным сообщением, а не через час в проде
 * на первом же запросе. Значения секретов в вывод не попадают.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

/** Пустая строка в .env означает «не задано», а не «задано пустым». */
const optionalText = z
	.string()
	.trim()
	.transform((value) => (value === '' ? undefined : value))
	.optional();

const EnvSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
		PORT: z.coerce.number().int().min(1).max(65535).default(3000),

		/**
		 * Слушаем только петлевой интерфейс: наружу нас выставляет Nginx.
		 * Переопределять стоит лишь в контейнере, где 127.0.0.1 недоступен снаружи pod'а.
		 */
		HOST: z.string().trim().min(1).default('127.0.0.1'),

		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

		/** Список доменов фронтенда. Звёздочка не поддерживается сознательно. */
		CORS_ORIGINS: z
			.string()
			.trim()
			.min(1, 'CORS_ORIGINS обязателен: перечислите домены фронтенда через запятую')
			.transform((raw) =>
				raw
					.split(',')
					.map((item) => item.trim())
					.filter(Boolean),
			)
			.pipe(z.array(z.url('CORS_ORIGINS должен содержать полные URL со схемой')).min(1))
			/**
			 * Приводим к тому виду, в котором Origin реально приходит от браузера.
			 * Это важно для кириллического домена: браузер сериализует источник
			 * по стандарту WHATWG и присылает punycode, поэтому
			 * https://пандапринт.shop в .env должен сравниваться
			 * с https://xn--80aalrwdiejw.shop в заголовке. Заодно отбрасываются
			 * путь, завершающий слэш и регистр в имени хоста.
			 */
			.transform((origins) => origins.map((value) => new URL(value).origin)),

		// --- Яндекс Маркет ---
		YANDEX_API_KEY: z.string().trim().min(10, 'YANDEX_API_KEY выглядит слишком коротким'),
		YANDEX_BUSINESS_ID: z.string().trim().regex(/^\d+$/, 'YANDEX_BUSINESS_ID — только цифры'),
		YANDEX_CAMPAIGN_ID: optionalText.pipe(
			z.string().regex(/^\d+$/, 'YANDEX_CAMPAIGN_ID — только цифры').optional(),
		),
		CATALOG_REFRESH_CRON: z.string().trim().min(1).default('*/20 * * * *'),

		/**
		 * Показывать только товары со статусом PUBLISHED хотя бы в одной кампании.
		 * Такой товар реально можно купить; иначе ссылка ведёт на мёртвую карточку.
		 * false — показывать всё, что имеет цену и ненулевой остаток.
		 */
		CATALOG_REQUIRE_PUBLISHED: z
			.enum(['true', 'false'])
			.default('true')
			.transform((value) => value === 'true'),

		// --- Почта ---
		SMTP_HOST: optionalText,
		SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
		SMTP_SECURE: z
			.enum(['true', 'false'])
			.default('true')
			.transform((value) => value === 'true'),
		SMTP_USER: optionalText,
		SMTP_PASS: optionalText,
		MAIL_TO: optionalText.pipe(z.email('MAIL_TO должен быть корректным e-mail').optional()),
		MAIL_FROM_NAME: z.string().trim().min(1).default('Panda Print'),

		// --- Анти-спам ---
		SMARTCAPTCHA_SERVER_KEY: optionalText,
	})
	.superRefine((env, ctx) => {
		// Почта — единственный блок, который можно оставить незаполненным в разработке:
		// это позволяет поднять сервер и отлаживать каталог до получения SMTP-реквизитов.
		// В проде отсутствие почты означает молча теряемые заявки, поэтому — жёстко.
		if (env.NODE_ENV !== 'production') return;

		const missing = (['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'] as const).filter(
			(key) => !env[key],
		);

		if (missing.length > 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['SMTP'],
				message: `В production обязательны: ${missing.join(', ')}`,
			});
		}
	});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
	// Печатаем только имена переменных и текст проблемы — никаких значений.
	const problems = parsed.error.issues.map((issue) => {
		const where = issue.path.join('.') || '(env)';
		return `  • ${where}: ${issue.message}`;
	});

	process.stderr.write(
		'\nНекорректная конфигурация окружения. Сверьтесь с .env.example:\n' +
			problems.join('\n') +
			'\n\n',
	);
	process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';

/** Почта настроена целиком — иначе /api/contact вернёт 503, а не упадёт молча. */
export const isMailConfigured = Boolean(
	env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_TO,
);

/** SmartCaptcha включается самим фактом наличия серверного ключа. */
export const isCaptchaEnabled = Boolean(env.SMARTCAPTCHA_SERVER_KEY);
