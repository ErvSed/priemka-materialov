# ПРИЁМКА — центральный портал

Статическое приложение без сборки. Работает на том же сервере, что и API `/priemka-api/`.

**Адрес:** https://45-81-253-203.sslip.io/priemka/

## Модель данных

- Реестр материалов и аккаунты хранятся только в SQLite на сервере.
- В браузере нет локального реестра и нет зашифрованного vault.
- После входа сервер выдаёт HttpOnly/Secure/SameSite=Strict сессию.
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

## Установка на сервер

```bash
# файлы сайта
rsync -a portal/ root@server:/opt/priemka/www/

# Nginx
cat > /etc/nginx/snippets/priemka-web.conf <<'EOF'
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
EOF
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
curl -fsS https://45-81-253-203.sslip.io/priemka/ | head
```

В браузере:

1. Войти по коду администратора.
2. Убедиться, что в реестре видны записи из общей базы.
3. Открыть «Пользователи», создать сотрудника, скопировать его код.
4. Войти с этим кодом в другом браузере: роль «Пользователь», нет архива, импорта и пользователей.
5. Отозвать доступ и убедиться, что сессия сотрудника завершается.

## Безопасность

- Код входа — секрет. Код администратора даёт полный доступ ко всем материалам и пользователям.
- Коды не отображаются повторно. Потерянный код сотрудника сбрасывается кнопкой «Новый код»; старый сразу перестаёт работать.
- Cookie сессии `HttpOnly`, `Secure`, `SameSite=Strict`; API дополнительно проверяет Origin для POST.
- Данные на сервере хранятся в SQLite в открытом виде; доступ к серверу и файлу базы должен быть ограничен. Резервные копии сервера нужно хранить в защищённом месте.
- Старое приложение на GitHub Pages использует отдельный статический токен `/sync`; оно оставлено только для архивного доступа и импорта старых данных.
