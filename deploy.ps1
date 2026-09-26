<#
.SYNOPSIS
    Деплой Panda Print на боевой сервер одной командой.

.DESCRIPTION
    Отправляет коммиты в GitHub и забирает их на сервере. Пересобирает
    бэкенд только если он реально менялся — правки во фронтенде Nginx
    подхватывает сам, пересборка им не нужна.

    Требует настроенного входа по SSH-ключу (Host pandaprint в ~/.ssh/config).
    Как это настроено — см. backend/README.md, раздел «Вход по SSH-ключу».

.EXAMPLE
    .\deploy.ps1
    Обычный деплой: push + pull + пересборка при необходимости.

.EXAMPLE
    .\deploy.ps1 -SkipPush
    Только забрать на сервер то, что уже в GitHub.
#>
[CmdletBinding()]
param(
    # Имя хоста из ~/.ssh/config. Можно передать root@IP, если конфига нет.
    [string]$Server = 'pandaprint',

    # Не пушить, только обновить сервер.
    [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Magenta }

# --- Проверки до того, как что-то менять -----------------------------------

$dirty = git status --porcelain
if ($dirty) {
    Write-Host "Есть незакоммиченные изменения:" -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "  $_" }
    Write-Host "`nСначала закоммитьте их:  git add -A; git commit -m `"...`"" -ForegroundColor Yellow
    exit 1
}

# --- Отправка в GitHub ------------------------------------------------------

if (-not $SkipPush) {
    Write-Step 'Отправляю в GitHub'
    git push origin main
    if ($LASTEXITCODE -ne 0) { Write-Host 'push не прошёл' -ForegroundColor Red; exit 1 }
}

# --- Обновление сервера -----------------------------------------------------
# Вся логика выполняется на сервере одной bash-командой: сравниваем коммит
# до и после pull и смотрим, попали ли в диапазон файлы из backend/.

Write-Step "Обновляю сервер ($Server)"

$remote = @'
set -e
cd /var/www/pandaprint

before=$(git rev-parse HEAD)
# origin main указываем явно: так команда не зависит от того, привязана ли
# ветка к upstream. Сервер разворачивался через fetch + reset, а он привязку не ставит.
git pull --ff-only origin main
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
    echo "Сервер уже на последней версии — обновлять нечего."
    exit 0
fi

echo ""
echo "Обновлено:"
git log --oneline "$before..$after" | sed 's/^/  /'
echo ""

if git diff --name-only "$before" "$after" | grep -q '^backend/'; then
    echo "Менялся бэкенд — пересобираю и перезапускаю."
    cd backend
    npm ci --silent
    npm run build
    pm2 restart pandaprint-api
    echo ""
    sleep 3
    curl -s -o /dev/null -w "health: HTTP %{http_code}\n" http://127.0.0.1:3000/api/health
else
    echo "Менялся только фронтенд — Nginx подхватит файлы сам, перезапуск не нужен."
fi
'@

ssh $Server $remote
if ($LASTEXITCODE -ne 0) { Write-Host "`nОбновление на сервере не прошло" -ForegroundColor Red; exit 1 }

# --- Проверка снаружи -------------------------------------------------------

Write-Step 'Проверяю сайт'

$site = 'https://xn--80aalrwdiejw.shop'
try {
    $page = Invoke-WebRequest -Uri "$site/" -TimeoutSec 20 -UseBasicParsing
    Write-Host "  главная:  HTTP $($page.StatusCode)"

    $health = Invoke-RestMethod -Uri "$site/api/health" -TimeoutSec 20
    Write-Host "  каталог:  $($health.catalog.count) товаров, обновлён $($health.catalog.updatedAt)"
    Write-Host "`nГотово." -ForegroundColor Green
}
catch {
    Write-Host "  сайт не ответил: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  посмотрите логи:  ssh $Server 'pm2 logs pandaprint-api --lines 50'" -ForegroundColor Yellow
    exit 1
}
