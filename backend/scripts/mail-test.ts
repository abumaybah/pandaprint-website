/**
 * Отправка тестового письма тем же кодом, что работает в проде.
 *
 *   npm run mail:test
 *
 * Проверяет по шагам: заполнены ли SMTP-переменные, устанавливается ли
 * соединение, доходит ли письмо. При ошибке печатает, что именно не так,
 * и как это чинится. Пароль в вывод не попадает.
 */

import { env, isMailConfigured } from '../src/config/env.js';
import { ContactSchema } from '../src/schemas/contact.schema.js';
import { sendContactMessage, verifyMailer } from '../src/services/mailer.service.js';

function fail(message: string, hints: string[] = []): never {
	console.error(`\n✗ ${message}`);
	for (const hint of hints) console.error(`  • ${hint}`);
	console.error('');
	process.exit(1);
}

async function main(): Promise<void> {
	console.log('\n=== Шаг 1: переменные окружения ===');

	const missing = (['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'] as const).filter(
		(key) => !env[key],
	);

	if (missing.length > 0 || !isMailConfigured) {
		fail(`Не заполнено в .env: ${missing.join(', ')}`, [
			'Откройте backend/.env и впишите недостающее.',
			'SMTP_PASS — это пароль приложения, а не пароль от аккаунта.',
		]);
	}

	console.log(`  SMTP:      ${env.SMTP_HOST}:${env.SMTP_PORT} (secure: ${env.SMTP_SECURE})`);
	console.log(`  Отправитель: ${env.SMTP_USER}`);
	console.log(`  Получатель:  ${env.MAIL_TO}`);

	console.log('\n=== Шаг 2: соединение с SMTP ===');

	const connected = await verifyMailer();
	if (!connected) {
		fail('Соединение с SMTP не установлено.', [
			'Если ошибка похожа на таймаут — почти наверняка хостер закрыл исходящий порт.',
			`Проверьте: nc -zv ${env.SMTP_HOST} ${env.SMTP_PORT}`,
			'Многие провайдеры (в том числе Timeweb Cloud) по умолчанию блокируют',
			'исходящие 25, 465, 587 и 2525 для защиты от спама. Открывается в панели',
			'управления сервером или заявкой в поддержку.',
			'',
			'Если ошибка про авторизацию — SMTP_PASS должен быть паролем приложения',
			'(Яндекс ID -> Пароли приложений), а не паролем от аккаунта.',
			'Проверьте также соответствие порта и режима: 465 + SMTP_SECURE=true либо 587 + false.',
		]);
	}

	console.log('  Соединение установлено.');

	console.log('\n=== Шаг 3: отправка письма ===');

	// Прогоняем через ту же схему, что и настоящую заявку с сайта,
	// включая враждебный ввод в имени — чтобы заодно увидеть письмо целиком.
	const message = ContactSchema.parse({
		name: 'Тестовая заявка с сайта',
		contact: 'test@example.com',
		message:
			'Это проверочное письмо от бэкенда Panda Print.\n' +
			'Если оно пришло — форма обратной связи настроена и работает.',
		website: '',
		consent: true,
	});

	try {
		await sendContactMessage(message);
	} catch (error) {
		fail(`Письмо не отправилось: ${error instanceof Error ? error.message : String(error)}`, [
			'Если ошибка про «Sender address rejected» — SMTP_USER должен совпадать',
			'с ящиком, под которым идёт авторизация: Яндекс и Google не дают слать «от чужого имени».',
		]);
	}

	console.log(`\n✓ Письмо отправлено на ${env.MAIL_TO}`);
	console.log('  Проверьте входящие, а если пусто — папку «Спам».\n');
}

main().catch((error) => {
	console.error('Тест почты упал:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
