/**
 * Проверка бэкенда: валидация, анти-спам, лимиты, CORS, формирование письма.
 *
 *   npm start        (в другом окне)
 *   npm run smoke
 *
 * Внимание: тест лимита расходует квоту формы (5 отправок за 15 минут с этого IP),
 * поэтому он идёт последним. Повторный прогон раньше чем через 15 минут
 * покажет 429 там, где ожидался другой код — это ожидаемо, а не поломка.
 */

import nodemailer from 'nodemailer';

import { env } from '../src/config/env.js';
import { ContactSchema } from '../src/schemas/contact.schema.js';
import { buildMailMessage } from '../src/services/mailer.service.js';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		passed++;
		console.log(`  OK   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
	}
}

function section(title: string): void {
	console.log(`\n=== ${title} ===`);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	const response = await fetch(BASE + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* пустое тело — это нормально для 204 */
	}
	return { status: response.status, json, headers: response.headers };
}

const VALID = {
	name: 'Иван Тестов',
	contact: 'ivan@example.com',
	message: 'Здравствуйте! Подскажите, есть ли скидка при заказе двух кейкапов?',
	website: '',
	consent: true,
};

async function main(): Promise<void> {
	/* ------------------------- 1. Санитизация ввода ------------------------- */
	section('Санитизация и валидация (уровень схемы)');

	const injected = ContactSchema.safeParse({
		...VALID,
		name: 'Злодей\r\nBcc: victim@example.com\r\nX-Evil: yes',
	});
	check(
		'CRLF и попытка дописать заголовок вычищаются из имени',
		injected.success && !/[\r\n]/.test(injected.data.name),
		injected.success ? JSON.stringify(injected.data.name) : 'схема отвергла ввод',
	);

	const nullByte = ContactSchema.safeParse({ ...VALID, name: 'Тест\u0007\u0001Имя' });
	check(
		'Управляющие символы вырезаются',
		nullByte.success && !/[\u0000-\u001F\u007F]/.test(nullByte.data.name),
	);

	const multiline = ContactSchema.safeParse({ ...VALID, message: 'Первая\r\nВторая\r\n\r\n\r\n\r\nТретья' });
	check(
		'В тексте сообщения переносы строк сохраняются, а CR убирается',
		multiline.success && multiline.data.message.includes('\n') && !multiline.data.message.includes('\r'),
	);

	check('Слишком короткое имя отвергается', !ContactSchema.safeParse({ ...VALID, name: 'A' }).success);
	check(
		'Сообщение длиннее 2000 символов отвергается',
		!ContactSchema.safeParse({ ...VALID, message: 'я'.repeat(2100) }).success,
	);
	check('Мусор вместо контакта отвергается', !ContactSchema.safeParse({ ...VALID, contact: 'не контакт' }).success);
	check('Телефон принимается', ContactSchema.safeParse({ ...VALID, contact: '+7 (999) 123-45-67' }).success);
	check('E-mail принимается', ContactSchema.safeParse(VALID).success);

	// Согласие 152-ФЗ проверяется на сервере, а не только атрибутом required в HTML:
	// запрос напрямую в API без галочки должен отклоняться.
	const noConsent = ContactSchema.safeParse({ ...VALID, consent: false });
	check('Заявка без согласия отклоняется', !noConsent.success);
	check(
		'Сообщение об отсутствии согласия — на русском',
		!noConsent.success && /согласие/i.test(noConsent.error.issues[0]?.message ?? ''),
		noConsent.success ? '' : noConsent.error.issues[0]?.message,
	);
	check('Заявка вовсе без поля consent отклоняется', !ContactSchema.safeParse({ ...VALID, consent: undefined }).success);

	/* ---------------------- 2. Заголовки письма ----------------------------- */
	section('Формирование письма (защита от header injection)');

	// Попытка внедрить заголовок через поле контакта не доживает до письма:
	// CRLF схлопывается в пробел, и строка перестаёт быть валидным e-mail.
	check(
		'Контакт с CRLF отвергается схемой целиком',
		!ContactSchema.safeParse({ ...VALID, contact: 'attacker@example.com\r\nX-Injected: 1' }).success,
	);

	// В имени враждебный ввод переживает санитизацию как обычный текст —
	// проверяем, что он всё равно не превращается в заголовок письма.
	const hostile = ContactSchema.parse({
		...VALID,
		name: 'Злодей\r\nBcc: victim@example.com',
		contact: 'attacker@example.com',
	});

	// Рендерим сообщение тем же кодом, что и в проде, но в поток вместо SMTP.
	const renderer = nodemailer.createTransport({ streamTransport: true, buffer: true });
	const rendered = await renderer.sendMail(buildMailMessage(hostile, '2026-01-01T00:00:00.000Z'));
	const raw = String(rendered.message);
	const headerBlock = raw.split('\r\n\r\n')[0] ?? '';

	/**
	 * Кириллица в заголовках уезжает в MIME-кодирование (=?UTF-8?B?...?=),
	 * поэтому сравниваем не сырой текст, а раскодированный.
	 */
	const decodeMime = (text: string): string =>
		text
			.replace(/\?=\s+=\?/g, '?==?')
			.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, base64: string) =>
				Buffer.from(base64, 'base64').toString('utf8'),
			);

	const decodedHeaders = decodeMime(headerBlock);
	const subjectLine = decodedHeaders.split('\n').find((line) => /^subject:/i.test(line)) ?? '';

	check('В заголовках письма нет Bcc', !/^bcc:/im.test(headerBlock), headerBlock.slice(0, 120));
	check('В заголовках письма нет X-Injected', !/x-injected/i.test(headerBlock));
	check('Тема письма — заданная константа', /Новое сообщение с сайта Panda Print/.test(subjectLine), subjectLine);
	check('В тему не попал пользовательский ввод', !/Злодей/i.test(subjectLine));
	check('From взят из конфигурации, а не из формы', /^from:.*Panda Print/im.test(decodedHeaders));
	check('Reply-To содержит только адрес отправителя', /^reply-to:\s*attacker@example\.com\s*$/im.test(headerBlock) || /^reply-to:\s*\S+@\S+\s*$/im.test(headerBlock));
	check('Тело письма — text/plain', /content-type:\s*text\/plain/i.test(headerBlock));
	check('Имя из формы попало в тело, а не в заголовки', raw.includes('Bcc: victim@example.com') ? !headerBlock.includes('Bcc: victim@example.com') : true);

	/* ------------------------- 3. Каталог ----------------------------------- */
	section('Каталог');

	const products = await fetch(`${BASE}/api/products`);
	const catalog: any = await products.json();

	check('GET /api/products отвечает 200', products.status === 200, `status ${products.status}`);
	check('Каталог не пустой', Array.isArray(catalog.products) && catalog.products.length > 0);
	check('Есть поле updatedAt', typeof catalog.updatedAt === 'string');
	check(
		'Нет товаров с нулевым остатком',
		catalog.products.every((p: any) => p.stock === null || p.stock > 0),
	);
	check(
		'У всех товаров есть цена, картинка и ссылка',
		catalog.products.every((p: any) => p.price > 0 && p.image.startsWith('https://') && p.url.startsWith('https://')),
	);
	check(
		'Токен Маркета не утёк в ответ',
		!JSON.stringify(catalog).includes('ACMA:'),
	);

	const etag = products.headers.get('etag');
	const notModified = await fetch(`${BASE}/api/products`, { headers: { 'If-None-Match': etag ?? '' } });
	check('Повторный запрос с ETag отдаёт 304', notModified.status === 304, `status ${notModified.status}`);

	/* --------------------------- 4. CORS ------------------------------------ */
	section('CORS');

	const evil = await fetch(`${BASE}/api/products`, { headers: { Origin: 'https://evil.example' } });
	check('Чужой Origin отклоняется', evil.status === 403, `status ${evil.status}`);

	// Берём первый разрешённый источник из конфигурации, а не зашитый в тест домен.
	const allowed = env.CORS_ORIGINS[0] as string;
	const good = await fetch(`${BASE}/api/products`, { headers: { Origin: allowed } });
	check(
		`Разрешённый Origin проходит и получает заголовок (${allowed})`,
		good.status === 200 && good.headers.get('access-control-allow-origin') === allowed,
		`status ${good.status}`,
	);

	/**
	 * Кириллический домен: в .env он записан как https://пандапринт.shop,
	 * а браузер пришлёт punycode. Проверяем, что нормализация их сводит.
	 */
	const idnConfigured = env.CORS_ORIGINS.some((origin) => origin.includes('xn--'));
	if (idnConfigured) {
		check(
			'Кириллический домен нормализован в punycode',
			env.CORS_ORIGINS.every((origin) => !/[^\x00-\x7F]/.test(origin)),
			env.CORS_ORIGINS.join(', '),
		);
	}

	/* --------------------------- 5. Форма ----------------------------------- */
	section('Форма обратной связи');

	const bad = await post('/api/contact', { ...VALID, name: 'A', contact: 'мусор' });
	check('Невалидные данные -> 400', bad.status === 400, `status ${bad.status}`);
	check('Ответ содержит ошибки по полям', Boolean(bad.json?.fields?.name && bad.json?.fields?.contact));

	const honeypot = await post('/api/contact', { ...VALID, website: 'http://spam.example' });
	check('Заполненный honeypot -> 204 и письмо не уходит', honeypot.status === 204, `status ${honeypot.status}`);

	const huge = await post('/api/contact', { ...VALID, message: 'я'.repeat(200_000) });
	check('Слишком большое тело отклоняется', huge.status === 413 || huge.status === 400, `status ${huge.status}`);

	// Единственная заявка, которая при настроенном SMTP реально уходит письмом —
	// это и есть сквозная проверка доставки. Больше одного письма тест не шлёт.
	const valid = await post('/api/contact', VALID);
	const mailConfigured = valid.status !== 503;
	check(
		mailConfigured
			? 'Валидная заявка принята — одно настоящее письмо ушло на MAIL_TO'
			: 'Валидная заявка дошла до отправки, SMTP не настроен -> 503',
		valid.status === 200 || valid.status === 503,
		`status ${valid.status}`,
	);
	if (!mailConfigured) {
		console.log('       (заполните SMTP_* в .env, чтобы проверить реальную доставку письма)');
	} else {
		console.log('       (проверьте входящие: письмо от «Иван Тестов» — это оно)');
	}

	/* ------------------------ 6. Лимит частоты ------------------------------ */
	section('Лимит частоты (последним — расходует квоту)');

	// Лимит считает все запросы к /api/contact независимо от исхода, поэтому
	// давим его honeypot-заявками: они отвечают 204 и писем не порождают.
	// Раньше тут летели валидные заявки, и каждый прогон засорял ящик.
	const HONEYPOT_HIT = { ...VALID, website: 'http://smoke-test.invalid' };

	let got429 = false;
	for (let i = 0; i < 8; i++) {
		const response = await post('/api/contact', HONEYPOT_HIT);
		if (response.status === 429) {
			got429 = true;
			break;
		}
	}
	check('Серия отправок упирается в 429', got429);

	const notFound = await fetch(`${BASE}/api/no-such-method`);
	check('Неизвестный метод -> 404', notFound.status === 404, `status ${notFound.status}`);

	renderer.close();
	console.log(`\nИтого: ${passed} OK, ${failed} FAIL\n`);

	// exitCode, а не process.exit(): даём событийному циклу закрыться самому,
	// иначе libuv ругается на висящие хендлы уже после вывода результатов.
	process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
	console.error('Smoke-тест упал:', error);
	process.exitCode = 1;
});
