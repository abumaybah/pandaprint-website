/**
 * Проверка токена Яндекс SmartCaptcha.
 *
 * Капча опциональна: пока SMARTCAPTCHA_SERVER_KEY пуст, функция всегда
 * возвращает true, и форму защищают honeypot и rate limit. Как подключить
 * капчу на фронте — описано в README.
 *
 * При недоступности сервиса проверки пропускаем заявку (fail-open):
 * терять обращения клиентов из-за чужой аварии хуже, чем пропустить спам,
 * тем более что лимит в 5 отправок за 15 минут с одного IP остаётся в силе.
 */

import { env, isCaptchaEnabled } from '../config/env.js';
import { describeError, logger } from '../lib/logger.js';

const VALIDATE_URL = 'https://smartcaptcha.yandexcloud.net/validate';

export async function verifyCaptcha(token: string | undefined, ip: string): Promise<boolean> {
	if (!isCaptchaEnabled) return true;

	if (!token) {
		logger.info('Заявка без токена капчи отклонена');
		return false;
	}

	try {
		const query = new URLSearchParams({
			secret: env.SMARTCAPTCHA_SERVER_KEY as string,
			token,
			ip,
		});

		const response = await fetch(`${VALIDATE_URL}?${query.toString()}`, {
			method: 'GET',
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			logger.warn('SmartCaptcha ответила ошибкой — пропускаем заявку', {
				status: response.status,
			});
			return true;
		}

		const data = (await response.json()) as { status?: string };
		return data.status === 'ok';
	} catch (error) {
		logger.warn('SmartCaptcha недоступна — пропускаем заявку', describeError(error));
		return true;
	}
}
