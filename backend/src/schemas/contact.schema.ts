/**
 * Валидация формы обратной связи.
 *
 * Имена полей взяты из существующей разметки (frontend/index.html):
 * name, contact, message. Плюс скрытое honeypot-поле website и
 * необязательный токен SmartCaptcha.
 *
 * Санитизация здесь — первый и главный рубеж против email header injection:
 * управляющие символы, включая CR и LF, вырезаются до того, как строка
 * вообще доедет до nodemailer.
 */

import { z } from 'zod';

/**
 * Убирает управляющие символы (в том числе перевод строки и возврат каретки)
 * и схлопывает пробелы. Именно перевод строки позволяет дописать лишний
 * заголовок письма, поэтому чистим до всех остальных проверок.
 */
function sanitizeSingleLine(value: string): string {
	return value
		.replace(/[\u0000-\u001F\u007F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Для текста сообщения переводы строк осмысленны — сохраняем их,
 * но убираем возврат каретки и прочие управляющие символы.
 */
function sanitizeMultiline(value: string): string {
	return value
		.replace(/\r/g, '')
		.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[\d][\d\s()-]{4,19}$/;

export function isEmail(value: string): boolean {
	return EMAIL_PATTERN.test(value);
}

export function isPhone(value: string): boolean {
	// Считаем телефоном только то, где хотя бы 5 цифр — иначе это просто мусор.
	const digits = value.replace(/\D/g, '');
	return PHONE_PATTERN.test(value) && digits.length >= 5 && digits.length <= 15;
}

export const ContactSchema = z.object({
	name: z
		.string()
		.max(200, 'Слишком длинное имя')
		.transform(sanitizeSingleLine)
		.pipe(
			z
				.string()
				.min(2, 'Имя слишком короткое')
				.max(80, 'Имя слишком длинное'),
		),

	contact: z
		.string()
		.max(200, 'Слишком длинный контакт')
		.transform(sanitizeSingleLine)
		.pipe(
			z
				.string()
				.min(3, 'Укажите e-mail или телефон')
				.max(120, 'Слишком длинный контакт')
				.refine(
					(value) => isEmail(value) || isPhone(value),
					'Укажите корректный e-mail или телефон',
				),
		),

	message: z
		.string()
		.max(5000, 'Сообщение слишком длинное')
		.transform(sanitizeMultiline)
		.pipe(
			z
				.string()
				.min(5, 'Сообщение слишком короткое')
				.max(2000, 'Сообщение слишком длинное'),
		),

	/**
	 * Honeypot. Настоящий пользователь его не видит и не заполняет,
	 * бот — заполняет. Непустое значение обрабатывается в контроллере.
	 */
	website: z.string().max(200).optional().default(''),

	/** Токен SmartCaptcha, если капча включена на фронте. */
	captchaToken: z.string().max(4096).optional(),

	/**
	 * Согласие на обработку персональных данных (152-ФЗ). Проверяется здесь, а не только
	 * атрибутом required на чекбоксе в HTML — иначе запрос напрямую в API в обход чекбокса
	 * прошёл бы без согласия. z.literal(true) отсеивает и false, и отсутствие поля.
	 */
	// В Zod 4 параметр называется message; errorMap из Zod 3 здесь не компилируется,
	// а в рантайме молча игнорируется — пользователь видел бы английский текст по умолчанию.
	consent: z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

export type ContactInput = z.infer<typeof ContactSchema>;
