// trakt_folder_sync — плагин Lampa для синхронизации папок с Trakt.
// Переписывается с нуля по SPEC.md.
// Предыдущая стабильная версия — коммит 14aabd9 (доступна через git).
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Константы
    // -----------------------------------------------------------------------

    var SYNC_TAG        = 'TraktFolderSync';
    var STORAGE_ENABLED = 'trakt_folder_sync_enabled';
    var STORAGE_LOGGING = 'trakt_enable_logging';

    // Базовый URL — тот же прокси, что использует trakt_by_lampame. Прокси
    // подставляет trakt-api-key на сервере, поэтому прямой api.trakt.tv без
    // собственного зарегистрированного client_id не подходит. См. SPEC.md.
    var API_URL = 'https://apx.lme.isroot.in/trakt';

    // -----------------------------------------------------------------------
    // Утилиты
    // -----------------------------------------------------------------------

    function log(msg, data) {
        if (!Lampa.Storage.field(STORAGE_LOGGING)) return;
        data !== undefined ? console.log(SYNC_TAG, msg, data) : console.log(SYNC_TAG, msg);
    }

    function warn(msg, data) {
        // Предупреждения пишем всегда — это сигналы о проблемах, не отладка.
        data !== undefined ? console.warn(SYNC_TAG, msg, data) : console.warn(SYNC_TAG, msg);
    }

    function isEnabled() {
        return Lampa.Storage.field(STORAGE_ENABLED) !== false;
    }

    function getToken() {
        return Lampa.Storage.get('trakt_token') || '';
    }

    function hasToken() {
        return !!getToken();
    }

    // -----------------------------------------------------------------------
    // HTTP: traktFetch
    // -----------------------------------------------------------------------
    //
    // Возвращает Promise<response JSON>. Бросает Error с полями
    // { status, response } при неуспешном ответе. Для GET достаточно path;
    // для POST/PUT — передать body в opts.body (сериализуем в JSON).
    //
    function traktFetch(path, opts) {
        opts = opts || {};
        var method = (opts.method || 'GET').toUpperCase();
        var url = API_URL + path;

        var headers = {
            'Content-Type': 'application/json',
            'trakt-api-version': '2'
        };
        if (!opts.unauthorized) {
            var token = getToken();
            if (token) headers['Authorization'] = 'Bearer ' + token;
        }

        var init = {
            method: method,
            headers: headers,
            // credentials по умолчанию 'same-origin' — нам CORS'а хватает.
            mode: 'cors'
        };
        if (opts.body !== undefined) {
            init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        }

        log('fetch →', { method: method, path: path });

        return fetch(url, init).then(function (res) {
            var ct = (res.headers.get('content-type') || '').toLowerCase();
            var parser = ct.indexOf('application/json') >= 0 ? res.json() : res.text();
            return parser.then(function (data) {
                if (!res.ok) {
                    var err = new Error('Trakt API ' + res.status);
                    err.status = res.status;
                    err.response = data;
                    throw err;
                }
                log('fetch ←', { method: method, path: path, status: res.status,
                    size: Array.isArray(data) ? data.length : undefined });
                return data;
            });
        });
    }

    // -----------------------------------------------------------------------
    // Настройки
    // -----------------------------------------------------------------------

    function addSettings() {
        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: STORAGE_ENABLED, type: 'trigger', 'default': true },
            field: {
                name: 'Синхронизация папок с Trakt',
                description: 'Закладки, Смотрю, Просмотрено, Продолжение следует — отражают состояние Trakt'
            }
        });
    }

    // -----------------------------------------------------------------------
    // Пробное чтение (коммит 2): watchlist
    // -----------------------------------------------------------------------
    //
    // Цель этого шага — убедиться, что:
    //   1) traktFetch правильно ставит заголовки и получает 2xx;
    //   2) прокси отвечает ожидаемой формой — массив элементов с полями
    //      movie/show и ids (trakt/imdb/tmdb).
    //
    // Результат только логируется. В папки Lampa пока не пишем.
    //
    function probeWatchlist() {
        if (!isEnabled()) {
            log('Синхронизация отключена в настройках — пропуск пробного чтения');
            return;
        }

        Promise.all([
            traktFetch('/users/me/watchlist/movies'),
            traktFetch('/users/me/watchlist/shows')
        ]).then(function (results) {
            var movies = Array.isArray(results[0]) ? results[0] : [];
            var shows  = Array.isArray(results[1]) ? results[1] : [];

            log('watchlist/movies', {
                count: movies.length,
                sample: movies.slice(0, 3).map(function (it) {
                    var m = it && it.movie ? it.movie : {};
                    return { title: m.title, year: m.year, ids: m.ids };
                })
            });
            log('watchlist/shows', {
                count: shows.length,
                sample: shows.slice(0, 3).map(function (it) {
                    var s = it && it.show ? it.show : {};
                    return { title: s.title, year: s.year, ids: s.ids };
                })
            });
        })['catch'](function (err) {
            warn('watchlist read failed', {
                status: err && err.status,
                message: err && err.message,
                response: err && err.response
            });
        });
    }

    // -----------------------------------------------------------------------
    // Запуск
    // -----------------------------------------------------------------------

    function start() {
        addSettings();

        if (!hasToken()) {
            log('Нет токена Trakt — войдите через плагин trakt_by_lampame');
            return;
        }

        log('Скелет загружен', { enabled: isEnabled() });
        probeWatchlist();
    }

    function init() {
        if (window.appready) {
            start();
        } else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') start();
            });
        }
    }

    if (!window.plugin_trakt_folder_sync_ready) {
        window.plugin_trakt_folder_sync_ready = true;
        init();
    }

})();
