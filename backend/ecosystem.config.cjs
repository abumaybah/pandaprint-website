/**
 * Конфигурация PM2.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup      (чтобы пережить перезагрузку сервера)
 *
 * ВАЖНО: instances: 1 и режим fork — не «пока не дошли руки до кластера»,
 * а обязательное условие. И кэш каталога, и счётчики express-rate-limit
 * живут в памяти процесса. В кластере из N воркеров получилось бы N
 * независимых кэшей (и N походов в Маркет каждые 20 минут) и лимит формы,
 * умноженный на N. Нагрузка здесь — отдача готового JSON, одного процесса
 * хватает с большим запасом.
 */

module.exports = {
	apps: [
		{
			name: 'pandaprint-api',
			script: 'dist/index.js',
			cwd: __dirname,

			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			max_restarts: 10,
			min_uptime: '20s',
			max_memory_restart: '300M',

			env: {
				NODE_ENV: 'production',
			},

			// Логи уже в JSON со своей меткой времени — PM2 добавлять свою не нужно.
			time: false,
			merge_logs: true,
			out_file: 'logs/out.log',
			error_file: 'logs/error.log',
		},
	],
};
