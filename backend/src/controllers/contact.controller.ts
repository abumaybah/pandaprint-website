/**
 * Приём формы обратной связи.
 *
 * Порядок проверок выбран так, чтобы самые дешёвые отсекали трафик первыми:
 *   1) размер и форма тела (express.json + Zod),
 *   2) honeypot — бесплатно и отсеивает основную массу ботов,
 *   3) капча — сетевой вызов, только если включена,
 *   4) отправка письма.
 * Лимит частоты стоит ещё выше, на уровне роутера.
 */

import type { RequestHandler } from 'express';

import { isMailConfigured } from '../config/env.js';
import { describeError, logger } from '../lib/logger.js';
import { ContactSchema, isEmail } from '../schemas/contact.schema.js';
import { verifyCaptcha } from '../services/captcha.service.js';
import { sendContactMessage } from '../services/mailer.service.js';

export const postContact: RequestHandler = async (req, res) => {
	const parsed = ContactSchema.safeParse(req.body);

	if (!parsed.success) {
		// Отдаём ошибки по полям, но не эхо-значения — они и так у клиента.
		const fields: Record<string, string> = {};
		for (const issue of parsed.error.issues) {
			const key = String(issue.path[0] ?? 'form');
			fields[key] ??= issue.message;
		}

		logger.info('Форма не прошла валидацию', { fields: Object.keys(fields) });
		res.status(400).json({ ok: false, error: 'Проверьте заполнение формы', fields });
		return;
	}

	const data = parsed.data;

	// Honeypot: скрытое поле заполняют только боты. Отвечаем как при успехе,
	// чтобы не подсказывать, по какому признаку заявка отбракована.
	if (data.website.trim() !== '') {
		logger.info('Заявка отсеяна honeypot-полем');
		res.status(204).end();
		return;
	}

	const captchaPassed = await verifyCaptcha(data.captchaToken, req.ip ?? '');
	if (!captchaPassed) {
		res.status(400).json({ ok: false, error: 'Не пройдена проверка на робота' });
		return;
	}

	if (!isMailConfigured) {
		logger.error('Заявка получена, но SMTP не настроен — письмо не отправлено');
		res.status(503).json({
			ok: false,
			error: 'Отправка временно недоступна. Напишите нам в Telegram или на почту.',
		});
		return;
	}

	try {
		await sendContactMessage(data);

		// В лог — только факт и безличные признаки. Ни имени, ни контакта, ни текста.
		logger.info('contact_sent', { ok: true, hasEmail: isEmail(data.contact) });

		res.status(200).json({ ok: true, message: 'Сообщение отправлено. Мы ответим в ближайшее время.' });
	} catch (error) {
		logger.error('Не удалось отправить письмо', describeError(error));
		res.status(502).json({
			ok: false,
			error: 'Не получилось отправить сообщение. Попробуйте позже или напишите нам в Telegram.',
		});
	}
};
