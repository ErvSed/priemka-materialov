# ПРИЁМКА — центральный портал

Статическое приложение без сборки. Интерфейс публикуется на GitHub Pages, API — на сервере.

**Главный сайт:** https://ervsed.github.io/priemka-materialov/
**API:** https://45-81-253-203.sslip.io/priemka-api/
**Архив v1:** https://ervsed.github.io/priemka-materialov/v1/

## Модель данных

- Реестр материалов и аккаунты хранятся только в SQLite на сервере.
- В браузере нет локального реестра и нет зашифрованного vault.
- GitHub Pages не выполняет серверный код; интерфейс обращается к API по HTTPS.
- На GitHub Pages после входа выдаётся Bearer-токен сессии; он хранится в `localStorage` и отправляется в заголовке `Authorization`. Cookie на другом origin браузером не используется.
- На серверном зеркале `/priemka/` (тот же origin, что API) дополнительно работает HttpOnly/Secure/SameSite=Strict cookie.
- Все устройства с одним кодом видят одни и те же материалы.
- Пользовательские коды создаёт администратор; коды хранятся на сервере только в виде SHA-256-хэшей.

## Роли

| Действие | Администратор | Пользователь |
| --- | --- | --- |
| Смотреть, добавлять, редактировать материалы | да | да |
| Архив и восстановление | да | нет |
| Импорт и экспорт CSV | да | нет |
| Пользователи и коды доступа | да | нет |
| Смена и отзыв кодов | да | нет |

Архив дополнительно запрещён на уровне API для роли `user`.

## GitHub Pages и сервер

GitHub Pages отдаёт только статические файлы. База и Python-код должны работать на сервере:

- `index.html`, `styles.css`, `app.js`, `assets/`, `fonts/` — корень GitHub Pages;
- `v1/` — архив старой локальной версии;
- `server/` — API, SQLite, аккаунты и сессии.

API разрешает origin `https://ervsed.github.io` и заголовок `Authorization`. Сессионный Bearer-токен возвращается при `POST /login`; cookie остаётся для серверного зеркала.

## Установка API

```bash
# код
install -o root -g root -m 0755 server/priemka_sync.py /opt/priemka/priemka_sync.py
install -o root -g root -m 0755 server/create_admin.py /opt/priemka/create_admin.py

# сервис
systemctl restart priemka-sync
systemctl is-active priemka-sync
```

## Серверное зеркало (необязательно)

Можно дополнительно отдавать интерфейс с того же сервера, что API:

```bash
rsync -a index.html styles.css app.js assets fonts root@server:/opt/priemka/www/
```

```nginx
location = /priemka {
    return 302 /priemka/;
}
location /priemka/ {
    alias /opt/priemka/www/;
    index index.html;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Cache-Control "no-cache" always;
}
```

В HTTPS `server` существующего сайта добавить:

```nginx
include /etc/nginx/snippets/priemka-api.conf;
include /etc/nginx/snippets/priemka-web.conf;
```

Проверить и перезагрузить:

```bash
nginx -t && systemctl reload nginx
```

В `/opt/priemka/priemka.env` должны быть:

```dotenv
PRIEMKA_DB=/opt/priemka/data/priemka.db
PRIEMKA_TOKEN_SHA256=<старый-хэш-для-старого-приложения>
PRIEMKA_ALLOWED_ORIGINS=https://ervsed.github.io,https://45-81-253-203.sslip.io
PRIEMKA_COOKIE_SECURE=1
PRIEMKA_HOST=127.0.0.1
PRIEMKA_PORT=8012
```

Создание первого администратора (код печатается один раз):

```bash
runuser -u priemka -- env PRIEMKA_DB=/opt/priemka/data/priemka.db \
  python3 /opt/priemka/create_admin.py
```

Скрипт откажется создавать второго активного администратора. Для сброса кода администратора нужен доступ к серверу и отдельная процедура.

## Проверка

```bash
curl -fsS https://45-81-253-203.sslip.io/priemka-api/health
curl -fsS https://ervsed.github.io/priemka-materialov/ | head
```

В браузере:

1. Открыть GitHub Pages и войти по коду администратора.
2. Убедиться, что в реестре видны записи из общей базы.
3. Открыть «Пользователи», создать сотрудника, скопировать его код.
4. Войти с этим кодом в другом браузере: роль «Пользователь», нет архива, импорта и пользователей.
5. Отозвать доступ и убедиться, что сессия сотрудника завершается.
6. Открыть архив v1 и убедиться, что старый локальный вход работает.

## Безопасность

- Код входа — секрет. Код администратора даёт полный доступ ко всем материалам и пользователям.
- Коды не отображаются повторно. Потерянный код сотрудника сбрасывается кнопкой «Новый код»; старый сразу перестаёт работать.
- На GitHub Pages сессионный Bearer-токен хранится в `localStorage`; CSP запрещает сторонние скрипты. На серверном зеркале используется HttpOnly/Secure/SameSite=Strict cookie.
- API принимает только разрешённый Origin и проверяет сессию на каждом запросе.
- Данные на сервере хранятся в SQLite в открытом виде; доступ к серверу и файлу базы должен быть ограничен. Резервные копии сервера нужно хранить в защищённом месте.
- Архив `v1/` использует отдельный статический токен `/sync`; он оставлен только для доступа к старым данным и импорта CSV.
