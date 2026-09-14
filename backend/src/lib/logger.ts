/**
 * Минимальный структурный логгер в stdout/stderr.
 *
 * Осознанно написан руками, а не взят pino/winston: всё, что нужно —
 * одна строка JSON в поток, файлы и ротацию делает PM2.
 *
 * Главное правило проекта: СЮДА НИКОГДА НЕ ПОПАДАЮТ ТЕЛА ЗАПРОСОВ.
 * Логируем только явно перечисленные поля. Дополнительно, как страховка
 * от случайной утечки, всё сериализованное прогоняется через scrub().
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minWeight(): number {
	const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
	return LEVEL_WEIGHT[raw] ?? LEVEL_WEIGHT.info;
}

/** Значения этих переменных окружения вырезаются из любой строки лога. */
const SECRET_ENV_KEYS = ['YANDEX_API_KEY', 'SMTP_PASS', 'SMARTCAPTCHA_SERVER_KEY'] as const;

/** Формат токена Партнёрского API — на случай, если он придёт не из env, а из текста ошибки. */
const TOKEN_PATTERN = /ACMA:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g;

export function scrub(text: string): string {
	let out = text.replace(TOKEN_PATTERN, 'ACMA:<скрыто>');

	for (const key of SECRET_ENV_KEYS) {
		const value = process.env[key];
		// replaceAll со строковым аргументом ищет литерал — экранировать нечего.
		if (value && value.length >= 8) {
			out = out.replaceAll(value, '<скрыто>');
		}
	}

	return out;
}

export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
	if (LEVEL_WEIGHT[level] < minWeight()) return;

	const record = { ts: new Date().toISOString(), level, msg, ...fields };

	let line: string;
	try {
		line = JSON.stringify(record);
	} catch {
		line = JSON.stringify({ ts: record.ts, level, msg, err: 'log serialization failed' });
	}

	const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
	stream.write(scrub(line) + '\n');
}

/**
 * Приводит пойманное значение к безопасному для лога виду.
 * Стек пишем только в dev — в проде он засоряет вывод и может
 * содержать пути и фрагменты значений.
 */
export function describeError(error: unknown): LogFields {
	if (error instanceof Error) {
		const fields: LogFields = { errName: error.name, errMsg: error.message };
		if (process.env.NODE_ENV !== 'production' && error.stack) {
			fields.stack = error.stack.split('\n').slice(0, 6).join('\n');
		}
		return fields;
	}
	return { errMsg: String(error) };
}

export const logger = {
	debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
	info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
	warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
	error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};
