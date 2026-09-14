/**
 * Отправка письма с формы обратной связи.
 *
 * Защита от email header injection здесь конструктивная, а не через чистку строк:
 * пользовательский ввод физически не попадает ни в один заголовок письма.
 *   From    — фиксированный, из .env (Яндекс всё равно требует совпадения
 *             с авторизованным ящиком, иначе отклонит отправку);
 *   Subject — константа, имя отправителя уходит только в тело;
 *   Reply-To— ставится, только если контакт распознан как e-mail, и передаётся
 *             объектом, который nodemailer кодирует сам;
 *   To      — из .env.
 * Тело письма — text/plain, без HTML, поэтому разметку туда не внедрить.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import { env, isMailConfigured } from '../config/env.js';
import { describeError, logger } from '../lib/logger.js';
import { isEmail, type ContactInput } from '../schemas/contact.schema.js';

const SUBJECT = 'Новое сообщение с сайта Panda Print';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
	if (transporter) return transporter;

	transporter = nodemailer.createTransport({
		host: env.SMTP_HOST,
		port: env.SMTP_PORT,
		secure: env.SMTP_SECURE,
		auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },

		/**
		 * На порту 587 соединение открывается незашифрованным и поднимается
		 * до TLS командой STARTTLS. requireTLS запрещает продолжать, если
		 * шифрование поднять не удалось: иначе пароль от ящика ушёл бы
		 * по сети открытым текстом. На 465 (secure: true) канал шифруется
		 * сразу, и флаг не нужен.
		 */
		requireTLS: !env.SMTP_SECURE,

		// Пул соединений не включаем: форма отправляется редко,
		// держать открытый сокет к SMTP незачем (без pool это поведение по умолчанию).
		connectionTimeout: 15_000,
		greetingTimeout: 10_000,
		socketTimeout: 20_000,
	});

	return transporter;
}

/**
 * Проверяет SMTP-реквизиты на старте, чтобы не выяснять их некорректность
 * в момент, когда клиент уже отправил форму. Ошибка не роняет процесс:
 * каталог должен работать и при сломанной почте.
 */
export async function verifyMailer(): Promise<boolean> {
	if (!isMailConfigured) {
		logger.warn('SMTP не настроен — /api/contact будет отвечать 503');
		return false;
	}

	try {
		await getTransporter().verify();
		logger.info('SMTP-соединение проверено', { host: env.SMTP_HOST, port: env.SMTP_PORT });
		return true;
	} catch (error) {
		logger.error('SMTP недоступен — письма отправляться не будут', describeError(error));
		return false;
	}
}

function buildBody(input: ContactInput, meta: { at: string }): string {
	return [
		`Имя:      ${input.name}`,
		`Контакт:  ${input.contact}`,
		`Получено: ${meta.at}`,
		`Согласие на обработку персональных данных: получено`,
		'',
		'Сообщение:',
		input.message,
		'',
		'---',
		'Письмо отправлено формой обратной связи на сайте Panda Print.',
	].join('\n');
}

/**
 * Собирает письмо. Вынесено отдельно, чтобы smoke-тест мог отрендерить
 * ровно то сообщение, которое уйдёт в прод, и убедиться, что враждебный
 * ввод не порождает лишних заголовков.
 */
export function buildMailMessage(input: ContactInput, at = new Date().toISOString()) {
	return {
		// Все заголовки формируются из конфигурации, не из пользовательского ввода.
		from: { name: env.MAIL_FROM_NAME, address: env.SMTP_USER ?? 'noreply@example.com' },
		to: env.MAIL_TO ?? 'inbox@example.com',
		subject: SUBJECT,
		text: buildBody(input, { at }),
		// Reply-To ставим только на настоящий e-mail; телефон в заголовок не годится.
		...(isEmail(input.contact) ? { replyTo: { name: '', address: input.contact } } : {}),
	};
}

export async function sendContactMessage(input: ContactInput): Promise<void> {
	if (!isMailConfigured) {
		throw new Error('SMTP не настроен');
	}

	await getTransporter().sendMail(buildMailMessage(input));
}
