// trakt_folder_sync — плагин Lampa для синхронизации папок с Trakt.
// Переписывается с нуля по SPEC.md.
// Предыдущая стабильная версия — коммит 14aabd9 (доступна через git).
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Константы
    // -----------------------------------------------------------------------

    var VERSION         = '0.3.0';

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

    function tmdbId(card) {
        if (!card) return null;
        var id = (card.ids && card.ids.tmdb) || card.id;
        return id != null ? String(id) : null;
    }

    // -----------------------------------------------------------------------
    // HTTP: traktFetch
    // -----------------------------------------------------------------------

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

        var init = { method: method, headers: headers, mode: 'cors' };
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
    // Маппинг watchlist-элемента Trakt → карточка Lampa
    // -----------------------------------------------------------------------
    //
    // Watchlist-элемент: { type: 'movie'|'show', listed_at, movie|show: {
    //   ids: { trakt, slug, imdb, tmdb }, title, year, ... } }
    //
    // Lampa.Favorite.add ожидает объект с минимум id, title, method/card_type.
    // Без TMDB-обогащения получим скромную карточку без постера — это
    // приемлемо для первого прохода; обогащение TMDB будет в коммите 4+.
    //
    function watchlistItemToCard(item) {
        if (!item) return null;
        var media = item.movie || item.show;
        if (!media || !media.ids) return null;

        var isMovie = !!item.movie;
        var id = media.ids.tmdb || media.ids.trakt;
        if (!id) return null;

        return {
            id:             id,
            ids:            media.ids,
            title:          media.title || '',
            original_title: media.title || '',
            name:           isMovie ? undefined : (media.title || ''),
            release_date:   media.year ? String(media.year) : '',
            first_air_date: media.year && !isMovie ? String(media.year) : '',
            vote_average:   Number(media.rating || 0),
            method:         isMovie ? 'movie' : 'tv',
            card_type:      isMovie ? 'movie' : 'tv',
            source:         'tmdb'
        };
    }

    // -----------------------------------------------------------------------
    // Синхронизация папки book
    // -----------------------------------------------------------------------
    //
    // Поток: читаем watchlist (movies + shows) → строим множество желаемых
    // карточек → сравниваем с текущим состоянием Lampa.Favorite type='book'
    // → добавляем/удаляем разницу.
    //
    // Trakt — источник правды. Если пользователь удалил из watchlist на
    // трэкт-сайте, мы убираем и из Закладок Lampa.
    //
    var _syncingBook = false;

    function syncBook() {
        if (_syncingBook) { log('syncBook: уже идёт, пропуск'); return; }
        if (!isEnabled()) { log('syncBook: синхронизация отключена'); return; }
        if (!hasToken())  { log('syncBook: нет токена');            return; }

        _syncingBook = true;
        log('syncBook: старт');

        Promise.all([
            traktFetch('/users/me/watchlist/movies'),
            traktFetch('/users/me/watchlist/shows')
        ]).then(function (results) {
            var rawItems = (Array.isArray(results[0]) ? results[0] : [])
                     .concat(Array.isArray(results[1]) ? results[1] : []);

            // Собираем желаемые карточки
            var desired = [];
            var desiredIds = new Set();
            rawItems.forEach(function (it) {
                var card = watchlistItemToCard(it);
                if (!card) return;
                var id = tmdbId(card);
                if (!id || desiredIds.has(id)) return;
                desiredIds.add(id);
                desired.push(card);
            });

            // Текущее состояние папки
            var local = Lampa.Favorite.get({ type: 'book' }) || [];
            var localIds = new Set(local.map(tmdbId).filter(Boolean));

            // Добавить: есть в Trakt, нет в Lampa
            var toAdd = desired.filter(function (c) { return !localIds.has(tmdbId(c)); });

            // Удалить: есть в Lampa, нет в Trakt
            var toRemove = local.filter(function (c) {
                var id = tmdbId(c);
                return id && !desiredIds.has(id);
            });

            toRemove.forEach(function (card) {
                try { Lampa.Favorite.remove('book', card); }
                catch (e) { warn('remove err', e); }
            });
            toAdd.forEach(function (card) {
                try { Lampa.Favorite.add('book', card); }
                catch (e) { warn('add err', e); }
            });

            log('syncBook: готово', {
                traktCount: desired.length,
                added: toAdd.length,
                removed: toRemove.length
            });
        })['catch'](function (err) {
            warn('syncBook failed', {
                status: err && err.status,
                message: err && err.message,
                response: err && err.response
            });
        }).then(function () {
            _syncingBook = false;
        });
    }

    // -----------------------------------------------------------------------
    // Триггер: открытие экрана «Избранное» (bookmarks)
    // -----------------------------------------------------------------------

    function initActivityListener() {
        Lampa.Listener.follow('activity', function (e) {
            if (!e || e.type !== 'start') return;
            var activity = e.object || {};
            if (activity.component !== 'bookmarks') return;
            log('bookmarks открыт → syncBook');
            syncBook();
        });
    }

    // -----------------------------------------------------------------------
    // Настройки
    // -----------------------------------------------------------------------

    function addSettings() {
        // Заголовок панели с версией — первым пунктом, над переключателем.
        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: 'trakt_folder_sync_header', type: 'static' },
            field: { name: '' },
            onRender: function (item) {
                item.empty();
                item.append(
                    '<div style="padding:1em 1.5em;opacity:.7;font-size:1.1em;">' +
                    'Trakt Folder Sync <b>v' + VERSION + '</b>' +
                    '</div>'
                );
            }
        });

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
    // Запуск
    // -----------------------------------------------------------------------

    function start() {
        addSettings();

        if (!hasToken()) {
            log('Нет токена Trakt — войдите через плагин trakt_by_lampame');
            return;
        }

        log('Готов', { version: VERSION, enabled: isEnabled() });
        initActivityListener();
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
