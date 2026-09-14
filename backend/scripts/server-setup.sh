#!/usr/bin/env bash
#
# Одноразовая подготовка чистого Ubuntu 22.04 / 24.04 под Panda Print.
#
# Что делает:
#   1. обновляет систему;
#   2. ставит Node.js 22 LTS, Nginx, PM2, certbot, ufw;
#   3. включает firewall (SSH разрешается ДО включения — иначе можно
#      отрезать себе доступ к серверу);
#   4. создаёт /var/www/pandaprint;
#   5. пишет конфиг Nginx только для HTTP — HTTPS в него позже допишет certbot,
#      когда домен уже будет смотреть на сервер.
#
# Запуск на сервере от root:
#   bash server-setup.sh
#
# Повторный запуск безопасен: всё, что уже установлено, пропускается.
#
set -euo pipefail

DOMAIN="xn--80aalrwdiejw.shop"          # пандапринт.shop в punycode
APP_DIR="/var/www/pandaprint"
NGINX_SITE="/etc/nginx/sites-available/pandaprint"

if [[ "${EUID}" -ne 0 ]]; then
	echo "Запускать от root: sudo bash server-setup.sh" >&2
	exit 1
fi

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 1. система
step "Обновление системы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
# netcat нужен для проверки исходящего SMTP-порта (nc -zv smtp.yandex.ru 465).
apt-get install -y -qq curl git ufw nginx ca-certificates netcat-openbsd

# ---------------------------------------------------------------- 2. Node.js
step "Node.js 22 LTS"
if command -v node >/dev/null 2>&1 && [[ "$(node -v | cut -d. -f1 | tr -d v)" -ge 20 ]]; then
	echo "уже установлен: $(node -v)"
else
	# В apt Ubuntu лежит слишком старый Node, поэтому берём официальный репозиторий NodeSource.
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y -qq nodejs
	echo "установлен: $(node -v)"
fi

# ---------------------------------------------------------------- 3. PM2
step "PM2"
if command -v pm2 >/dev/null 2>&1; then
	echo "уже установлен: $(pm2 -v)"
else
	npm install -g pm2 --silent
	echo "установлен: $(pm2 -v)"
fi

# ---------------------------------------------------------------- 4. certbot
step "certbot (Let's Encrypt)"
apt-get install -y -qq certbot python3-certbot-nginx

# ---------------------------------------------------------------- 5. firewall
step "Firewall (ufw)"
# Порядок критичен: сначала разрешить SSH, только потом включать.
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null     # 80 + 443
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'
# Порт 3000 наружу не открываем намеренно: Node слушает только 127.0.0.1,
# в интернет его выставляет Nginx.

# ---------------------------------------------------------------- 6. каталог
step "Каталог приложения"
mkdir -p "${APP_DIR}"
echo "  ${APP_DIR}"

# ---------------------------------------------------------------- 7. nginx
step "Nginx: конфиг сайта (пока только HTTP)"
cat > "${NGINX_SITE}" <<'NGINX'
# Panda Print. HTTPS-блок и редирект с 80 на 443 сюда добавит certbot —
# запускать его можно только после того, как домен начнёт резолвиться на этот сервер.

server {
    listen 80;
    listen [::]:80;
    server_name xn--80aalrwdiejw.shop www.xn--80aalrwdiejw.shop;

    server_tokens off;

    # Статика — напрямую, Node к ней не подключается.
    root /var/www/pandaprint/frontend;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(css|js|png|jpg|jpeg|svg|webp|woff2)$ {
        expires 30d;
        add_header Cache-Control "public";
    }

    # API — на Node.
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Без этих двух заголовков rate limiting увидит всех клиентов
        # как 127.0.0.1, и один спамер заблокирует форму для всех.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Host $host;
        proxy_read_timeout 30s;
    }
}
NGINX

ln -sf "${NGINX_SITE}" /etc/nginx/sites-enabled/pandaprint
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx
echo "  конфиг: ${NGINX_SITE}"

# ---------------------------------------------------------------- готово
step "Сервер подготовлен"
cat <<EOF

Дальше — по README, раздел «Деплой на Timeweb по шагам»:

  1. Залить код и .env с локальной машины (команды в README).
  2. cd ${APP_DIR}/backend && npm ci && npm run build
  3. pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
  4. Проверить SMTP-порт:  nc -zv smtp.yandex.ru 465
     (у Timeweb он закрыт по умолчанию — открыть в панели или через поддержку)
  5. Переключить DNS домена на серверы имён Timeweb, дождаться:
       nslookup ${DOMAIN} 8.8.8.8   -> должен показать IP этого сервера
  6. certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}

EOF
