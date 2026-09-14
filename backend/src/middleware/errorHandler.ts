/**
 * Обработка ошибок и 404.
 *
 * Наружу не отдаём ни стек, ни текст внутренней ошибки: клиенту достаточно
 * знать, что запрос не прошёл. Подробности уходят в лог.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';

import { describeError, logger } from '../lib/logger.js';

export const notFound: RequestHandler = (req, res) => {
	res.status(404).json({ ok: false, error: 'Метод не найден' });
};

/** Сообщения для клиентских ошибок, которые бросает не наш код, а express. */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
	400: 'Некорректный запрос',
	413: 'Слишком большое тело запроса',
	415: 'Неподдерживаемый тип содержимого',
};

/** Достаёт HTTP-код из ошибок в стиле http-errors (их бросает body-parser). */
function clientStatusOf(error: unknown): number | null {
	const candidate = error as { status?: unknown; statusCode?: unknown };
	const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;

	if (typeof status === 'number' && status >= 400 && status < 500) return status;
	return null;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
	// Отказ CORS — клиентская ситуация, стек в логе не нужен.
	if (error instanceof Error && error.message.startsWith('CORS:')) {
		logger.warn('Запрос отклонён политикой CORS', { path: req.path });
		res.status(403).json({ ok: false, error: 'Источник запроса не разрешён' });
		return;
	}

	/**
	 * Битый JSON и слишком большое тело приходят от body-parser с готовым
	 * кодом ответа. Раньше они проваливались в общий обработчик и клиент
	 * получал 500 вместо 400/413 — то есть выглядели как сбой сервера.
	 */
	const clientStatus = clientStatusOf(error);
	if (clientStatus !== null) {
		logger.warn('Некорректный запрос отклонён', {
			path: req.path,
			status: clientStatus,
			errName: error instanceof Error ? error.name : 'unknown',
		});

		res.status(clientStatus).json({
			ok: false,
			error: CLIENT_ERROR_MESSAGES[clientStatus] ?? 'Некорректный запрос',
		});
		return;
	}

	logger.error('Необработанная ошибка запроса', {
		method: req.method,
		path: req.path,
		...describeError(error),
	});

	if (res.headersSent) return;
	res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
};
