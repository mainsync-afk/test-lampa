// trakt_folder_sync — плагин Lampa для синхронизации папок с Trakt.
// Переписывается с нуля по SPEC.md.
// Предыдущая стабильная версия — коммит 14aabd9 (доступна через git).
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Константы
    // -----------------------------------------------------------------------

    var VERSION         = '0.4.0';

    var SYNC_TAG        = 'TraktFolderSync';
    var COMPONENT       = 'trakt_folder_sync';
    var STORAGE_ENABLED = 'trakt_folder_sync_enabled';
    var STORAGE_LOGGING = 'trakt_enable_logging';

    // Базовый URL — тот же прокси, что использует trakt_by_lampame. Прокси
    // подставляет trakt-api-key на сервере, поэтому прямой api.trakt.tv без
    // собственного зарегистрированного client_id не подходит. См. SPEC.md.
    var API_URL = 'https://apx.lme.isroot.in/trakt';

    // Задержка между TMDB-обогащениями (чтобы не упираться в лимиты TMDB).
    var ADD_DELAY_MS = 150;

    // Иконка раздела настроек — простой кружок с буквой T в стиле Trakt.
    var SECTION_ICON =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">' +
        '<circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" stroke-width="3"/>' +
        '<path d="M14 14 L24 24 L34 14 M19 29 L29 19" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';

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
    // Маппинг watchlist-элемента Trakt → карточка Lampa (тощая)
    // -----------------------------------------------------------------------
    //
    // Watchlist-элемент: { type: 'movie'|'show', listed_at, movie|show: {
    //   ids: { trakt, slug, imdb, tmdb }, title, year, ... } }
    //
    // Эта карточка — только каркас. Перед Lampa.Favorite.add она обогащается
    // данными TMDB (enrichAndAdd) — иначе нет ни постера, ни overview, и
    // Lampa может перепутать карточку с другой сущностью, у которой тот же
    // TMDB id (TMDB нумерует фильмы и сериалы независимо).
    //
    function watchlistItemToStub(item) {
        if (!item) return null;
        var media = item.movie || item.show;
        if (!media || !media.ids) return null;

        var isMovie = !!item.movie;
        var id = media.ids.tmdb;
        // Без TMDB id не умеем обогатить карточку — пропускаем (не добавляем
        // мусорные карточки с trakt-id в роли tmdb-id, как было в v0.3.0).
        if (!id) return null;

        return {
            id:         id,
            ids:        media.ids,
            title:      media.title || '',
            year:       media.year || undefined,
            method:     isMovie ? 'movie' : 'tv',
            card_type:  isMovie ? 'movie' : 'tv'
        };
    }

    // -----------------------------------------------------------------------
    // Обогащение карточки данными TMDB и добавление в Lampa.Favorite
    // -----------------------------------------------------------------------
    //
    // Берёт тощую карточку (id, method, ids), делает запрос к TMDB за полными
    // данными (название на языке пользователя, постер, overview, год и т.д.)
    // и кладёт результат в папку. При ошибке TMDB — добавляет что есть,
    // чтобы карточка хоть как-то появилась.
    //
    function enrichAndAdd(folder, stub, onDone) {
        var id = tmdbId(stub);
        if (!id) {
            // Не должно случаться — watchlistItemToStub уже отсеивает такие.
            if (onDone) onDone();
            return;
        }

        var type = stub.method === 'movie' ? 'movie' : 'tv';
        var lang = Lampa.Storage.get('language', 'ru');
        var url  = Lampa.TMDB.api(type + '/' + id + '?api_key=' + Lampa.TMDB.key() + '&language=' + lang);

        var network = new Lampa.Reguest();
        network.silent(url, function (data) {
            // data — полный объект TMDB (title/name, poster_path, overview, ...).
            // Накрываем поверх наши сохранённые идентификаторы и method.
            var enriched = Object.assign({}, stub, data, {
                ids:       stub.ids,
                method:    stub.method,
                card_type: stub.card_type,
                id:        id,
                source:    'tmdb'
            });
            // Для сериалов TMDB возвращает name; Lampa ждёт title.
            if (type === 'tv' && enriched.name && !enriched.title) {
                enriched.title = enriched.name;
            }
            try { Lampa.Favorite.add(folder, enriched); }
            catch (e) { warn('Favorite.add err', e); }
            if (onDone) onDone();
        }, function (err) {
            warn('TMDB enrich failed', { id: id, type: type, err: err });
            // Падать полностью не хотим — кладём тощую карточку, будет хотя бы
            // заглушка; при следующей синхронизации попробуем ещё раз.
            try { Lampa.Favorite.add(folder, stub); }
            catch (e) { warn('Favorite.add fallback err', e); }
            if (onDone) onDone();
        });
    }

    // -----------------------------------------------------------------------
    // Синхронизация папки book
    // -----------------------------------------------------------------------

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

            // Строим желаемое множество — тощие карточки с TMDB id.
            var desired = [];
            var desiredIds = new Set();
            rawItems.forEach(function (it) {
                var stub = watchlistItemToStub(it);
                if (!stub) return;
                var id = tmdbId(stub);
                if (!id || desiredIds.has(id)) return;
                desiredIds.add(id);
                desired.push(stub);
            });

            // Текущее состояние папки
            var local = Lampa.Favorite.get({ type: 'book' }) || [];
            var localIds = new Set(local.map(tmdbId).filter(Boolean));

            // Что добавить: есть в Trakt, нет в Lampa
            var toAdd = desired.filter(function (c) { return !localIds.has(tmdbId(c)); });

            // Что удалить: есть в Lampa, нет в Trakt
            var toRemove = local.filter(function (c) {
                var id = tmdbId(c);
                return id && !desiredIds.has(id);
            });

            // Удаления — мгновенно, без обогащения
            toRemove.forEach(function (card) {
                try { Lampa.Favorite.remove('book', card); }
                catch (e) { warn('remove err', e); }
            });

            // Добавления — последовательно, с TMDB-обогащением и задержкой
            var added = 0;
            function addNext(index) {
                if (index >= toAdd.length) {
                    log('syncBook: готово', {
                        traktCount: desired.length,
                        added: added,
                        removed: toRemove.length
                    });
                    _syncingBook = false;
                    return;
                }
                enrichAndAdd('book', toAdd[index], function () {
                    added++;
                    setTimeout(function () { addNext(index + 1); }, ADD_DELAY_MS);
                });
            }

            if (!toAdd.length) {
                log('syncBook: готово', {
                    traktCount: desired.length,
                    added: 0,
                    removed: toRemove.length
                });
                _syncingBook = false;
            } else {
                addNext(0);
            }
        })['catch'](function (err) {
            warn('syncBook failed', {
                status: err && err.status,
                message: err && err.message,
                response: err && err.response
            });
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
    // Настройки — свой раздел, не подмешиваемся в «Trakt» от lampame.
    // -----------------------------------------------------------------------

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name:      'Trakt Folder Sync',
            icon:      SECTION_ICON
        });

        // Заголовок с версией — первым пунктом.
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
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
            component: COMPONENT,
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
