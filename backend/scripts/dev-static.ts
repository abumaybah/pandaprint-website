/**
 * Локальный аналог продакшн-схемы Nginx: отдаёт статику из ../frontend
 * и проксирует /api на Node-бэкенд.
 *
 * Нужен только для разработки. В проде эту роль выполняет Nginx,
 * а сам Node статику не раздаёт.
 *
 *   npm run dev:site      (бэкенд при этом должен быть запущен отдельно)
 *
 * Смысл именно в проксировании: фронт работает по относительным путям
 * /api/..., ровно как на боевом домене, и локальная проверка не расходится
 * с продакшеном из-за CORS или другого порта.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend');
const PORT = Number(process.env.DEV_SITE_PORT ?? 4173);
const BACKEND = process.env.DEV_BACKEND ?? 'http://127.0.0.1:3000';

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

	// --- Прокси на бэкенд ---
	if (url.pathname.startsWith('/api/')) {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);

			const upstream = await fetch(BACKEND + url.pathname + url.search, {
				method: req.method,
				headers: {
					'Content-Type': req.headers['content-type'] ?? 'application/json',
					Accept: req.headers.accept ?? 'application/json',
					...(req.headers['if-none-match']
						? { 'If-None-Match': String(req.headers['if-none-match']) }
						: {}),
				},
				body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
			});

			res.writeHead(upstream.status, {
				'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
				...(upstream.headers.get('etag') ? { ETag: upstream.headers.get('etag') as string } : {}),
			});
			res.end(upstream.status === 304 ? undefined : Buffer.from(await upstream.arrayBuffer()));
		} catch (error) {
			res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: false, error: 'Бэкенд недоступен. Запущен ли npm start?' }));
			console.error('Прокси не смог достучаться до бэкенда:', error);
		}
		return;
	}

	// --- Статика ---
	const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([.][.][/\\])+/, '');
	let filePath = join(ROOT, relative === sep || relative === '/' ? 'index.html' : relative);

	// Не выпускаем за пределы каталога фронтенда.
	if (!filePath.startsWith(ROOT)) {
		res.writeHead(403).end('Forbidden');
		return;
	}

	try {
		const info = await stat(filePath);
		if (info.isDirectory()) filePath = join(filePath, 'index.html');

		res.writeHead(200, {
			'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
			'Cache-Control': 'no-cache',
		});
		createReadStream(filePath).pipe(res);
	} catch {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`Статика фронтенда: http://127.0.0.1:${PORT}`);
	console.log(`  /api/* проксируется на ${BACKEND}`);
	console.log(`  каталог: ${ROOT}`);
});
