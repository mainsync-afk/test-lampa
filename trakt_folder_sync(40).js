(function () {
    'use strict';

    var SYNC_TAG             = 'TraktFolderSync';
    var STORAGE_LIST_ID      = 'trakt_sync_thrown_list_id';
    var STORAGE_LIST_NAME    = 'trakt_sync_thrown_list_name';
    var STORAGE_ENABLED      = 'trakt_folder_sync_enabled';
    var STORAGE_LOOK_DAYS    = 'trakt_sync_look_days';
    var STORAGE_TRAKT_ID_MAP = 'trakt_id_map'; // tmdbId -> traktId
    var DEFAULT_LOOK_DAYS    = 30;

    var TRAKT_PROXY = 'https://apx.lme.isroot.in/trakt';

    // -----------------------------------------------------------------------
    // Утилиты
    // -----------------------------------------------------------------------

    function log(msg, data) {
        if (!Lampa.Storage.field('trakt_enable_logging')) return;
        data !== undefined ? console.log(SYNC_TAG, msg, data) : console.log(SYNC_TAG, msg);
    }

    function isEnabled() {
        return !!(Lampa.Storage.get('trakt_token') &&
                  Lampa.Storage.field(STORAGE_ENABLED) !== false);
    }

    function getApi() {
        try { return window.TraktTV && window.TraktTV.api || null; }
        catch (e) { return null; }
    }

    function tmdbId(card) {
        if (!card) return null;
        var id = (card.ids && card.ids.tmdb) || card.id;
        return id ? String(id) : null;
    }

    function buildParams(card) {
        var method = card.method || card.card_type || card.type ||
                     (card.first_air_date || card.name ? 'tv' : 'movie');
        var ids = Object.assign({}, card.ids || {});
        if (!ids.tmdb && card.id) ids.tmdb = card.id;
        return { method: method, ids: ids, id: card.id };
    }

    // -----------------------------------------------------------------------
    // Словарь tmdbId → traktId (хранится в Lampa.Storage)
    // Lampa не сохраняет объекты карточек, только массив ID,
    // поэтому храним маппинг отдельно
    // -----------------------------------------------------------------------

    function saveTraktId(tmdb, trakt) {
        if (!tmdb || !trakt) return;
        var map = Lampa.Storage.get(STORAGE_TRAKT_ID_MAP) || {};
        map[String(tmdb)] = String(trakt);
        Lampa.Storage.set(STORAGE_TRAKT_ID_MAP, map);
    }

    function lookupTraktId(tmdb) {
        if (!tmdb) return null;
        var map = Lampa.Storage.get(STORAGE_TRAKT_ID_MAP) || {};
        return map[String(tmdb)] || null;
    }

    function getTraktId(card) {
        if (!card) return null;
        // Сначала из ids (свежая карточка из upnext/watchlist)
        var tid = card.ids && card.ids.trakt;
        if (tid) return String(tid);
        // Потом из словаря (карточка уже сохранённая в Lampa.Favorite)
        var tmdb = tmdbId(card);
        return tmdb ? lookupTraktId(tmdb) : null;
    }

    // -----------------------------------------------------------------------
    // Прямой вызов Trakt API через прокси
    // -----------------------------------------------------------------------

    function traktApiRequest(method, endpoint, body) {
        var token = Lampa.Storage.get('trakt_token');
        if (!token) return Promise.reject(new Error('No trakt token'));

        var url = TRAKT_PROXY + endpoint;
        var opts = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token,
                'Trakt-Api-Version': '2'
            }
        };
        if (body) opts.body = JSON.stringify(body);

        return fetch(url, opts).then(function (r) {
            if (!r.ok) throw new Error('Trakt API error: ' + r.status);
            return r.status === 204 ? {} : r.json().catch(function () { return {}; });
        });
    }

    // -----------------------------------------------------------------------
    // Drop show — убирает сериал из upnext/continue watching в Trakt
    // POST /users/hidden/dropped {"shows": [{"ids": {"trakt": 123}}]}
    // Прогресс и история НЕ удаляются
    // -----------------------------------------------------------------------

    function dropShowFromUpnext(card) {
        var tid = getTraktId(card);
        if (!tid) {
            log('dropShowFromUpnext: no trakt id', { title: card && (card.title || card.name), tmdb: tmdbId(card) });
            return Promise.resolve();
        }

        var body = { shows: [{ ids: { trakt: parseInt(tid, 10) } }] };
        log('dropShowFromUpnext', { traktId: tid, title: card.title || card.name });

        return traktApiRequest('POST', '/users/hidden/dropped', body)
            .then(function (res) { log('dropShowFromUpnext ok', res); })
            .catch(function (e) { log('dropShowFromUpnext err', e); });
    }

    // -----------------------------------------------------------------------
    // Lampa → Trakt
    // -----------------------------------------------------------------------

    function onRemove(folder, card) {
        var api = getApi();
        if (!api) return;
        var params = buildParams(card);
        var id = tmdbId(card);
        log('Lampa->Trakt remove', { folder: folder, id: id });

        if (folder === 'book') {
            api.removeFromWatchlist(params)
               .then(function () { log('removeFromWatchlist ok'); })
               .catch(function (e) { log('removeFromWatchlist err', e); });

        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_LIST_ID);
            if (!listId) { log('thrown list not configured'); return; }
            if (id) _ownOps.add('del:' + id);
            api.removeFromList({ listId: listId, item: params })
               .then(function () {
                   log('removeFromList ok');
                   setTimeout(function () { _ownOps.delete('del:' + id); }, 10000);
               })
               .catch(function (e) {
                   log('removeFromList err', e);
                   if (id) _ownOps.delete('del:' + id);
               });
        }
    }

    function onAdd(folder, card) {
        var api = getApi();
        if (!api) return;
        var params = buildParams(card);
        var id = tmdbId(card);
        log('Lampa->Trakt add', { folder: folder, id: id });

        if (folder === 'book') {
            api.addToWatchlist(params)
               .then(function () { log('addToWatchlist ok'); })
               .catch(function (e) { log('addToWatchlist err', e); });

        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_LIST_ID);
            if (!listId) { log('thrown list not configured'); return; }

            if (id) _ownOps.add('add:' + id);

            // Убираем из look и отправляем drop в Trakt
            if (id) {
                var lookItems = Lampa.Favorite.get({ type: 'look' }) || [];
                var inLook = lookItems.find(function (c) { return tmdbId(c) === id; });
                if (inLook) {
                    // Не добавляем id в _ownOps — remove('look') не слушается,
                    // а голый id в _ownOps заблокирует последующий add('thrown')
                    Lampa.Favorite.remove('look', inLook);
                    log('Removed from look on thrown add', id);
                    dropShowFromUpnext(inLook);
                }
            }

            api.addToList({ listId: listId, item: params })
               .then(function () { log('addToList ok'); })
               .catch(function (e) { log('addToList err', e); });

            api.removeFromWatchlist(params)
               .then(function () { log('removeFromWatchlist ok'); })
               .catch(function (e) { log('removeFromWatchlist err', e); });
        }
    }

    // -----------------------------------------------------------------------
    // Trakt → Lampa (синхронизация)
    // -----------------------------------------------------------------------

    var _ownOps = new Set();
    var _syncing = { book: false, thrown: false, look: false };

    function syncFolder(folder) {
        if (!isEnabled() || _syncing[folder]) return;
        var api = getApi();
        if (!api) return;

        _syncing[folder] = true;
        log('Sync start', folder);

        fetchTraktItems(api, folder)
            .then(function (traktItems) { applySync(folder, traktItems); })
            .catch(function (e) { log('Sync error', e); })
            .then(function () { _syncing[folder] = false; });
    }

    function fetchTraktItems(api, folder) {
        if (folder === 'book') {
            return fetchPages(function (p) {
                return api.watchlist({ page: p, limit: 100, mediaType: 'movies,shows' });
            });
        }
        if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_LIST_ID);
            if (!listId) return Promise.resolve([]);
            return fetchPages(function (p) {
                return api.myListItems({ listId: listId, page: p, limit: 100 });
            });
        }
        if (folder === 'look') {
            var days = parseInt(Lampa.Storage.get(STORAGE_LOOK_DAYS) || DEFAULT_LOOK_DAYS, 10) || DEFAULT_LOOK_DAYS;
            var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            return fetchPages(function (p) {
                return api.upnext({ page: p, limit: 100 });
            }).then(function (items) {
                return items.filter(function (item) {
                    var lastWatched = item.trakt_upnext_last_watched_at;
                    if (!lastWatched) return false;
                    return new Date(lastWatched).getTime() > cutoff;
                });
            });
        }
        return Promise.resolve([]);
    }

    function fetchPages(fn) {
        var all = [];
        function next(page) {
            return fn(page).then(function (data) {
                var results = (data && data.results) || [];
                all = all.concat(results);
                if (page < ((data && data.total_pages) || 1)) return next(page + 1);
                return all;
            });
        }
        return next(1);
    }

    function applySync(folder, traktItems) {
        var localItems = Lampa.Favorite.get({ type: folder }) || [];
        var localIds   = new Set(localItems.map(tmdbId).filter(Boolean));
        var traktIds   = new Set(traktItems.map(tmdbId).filter(Boolean));
        var added = 0, removed = 0;

        // Есть в Lampa, нет в Trakt → удалить
        localItems.forEach(function (card) {
            var id = tmdbId(card);
            if (!id || traktIds.has(id)) return;
            if (_ownOps.has('add:' + id)) {
                log('Skip remove - pending add', { folder: folder, id: id });
                return;
            }
            try {
                _ownOps.add(id);
                Lampa.Favorite.remove(folder, card);
                removed++;
            } catch (e) { log('remove err', e); }
        });

        // Есть в Trakt, нет в Lampa → добавить
        // Для look: пропускаем если уже в thrown
        var thrownIds = folder === 'look'
            ? new Set((Lampa.Favorite.get({ type: 'thrown' }) || []).map(tmdbId).filter(Boolean))
            : null;

        var toAdd = traktItems.filter(function (c) {
            var id = tmdbId(c);
            if (!id || localIds.has(id)) return false;
            if (thrownIds && thrownIds.has(id)) {
                log('Skip look add - card is in thrown', { id: id });
                return false;
            }
            return true;
        });

        function addNext(index) {
            if (index >= toAdd.length) {
                log('Sync done', { folder: folder, added: added, removed: removed });
                return;
            }
            enrichAndAdd(folder, toAdd[index], function () {
                added++;
                setTimeout(function () { addNext(index + 1); }, 150);
            });
        }
        addNext(0);

        if (!toAdd.length) {
            log('Sync done', { folder: folder, added: 0, removed: removed });
        }
    }

    // -----------------------------------------------------------------------
    // Обогащение карточки через TMDB + сохранение trakt_id в словарь
    // -----------------------------------------------------------------------

    function enrichAndAdd(folder, card, onDone) {
        var id = tmdbId(card);
        if (id && _ownOps.has('del:' + id)) {
            log('Skip add - pending delete', { folder: folder, id: id });
            if (onDone) onDone();
            return;
        }

        // Сохраняем trakt ID в словарь пока карточка ещё свежая из Trakt API
        var tid = card.ids && card.ids.trakt;
        if (id && tid) {
            saveTraktId(id, tid);
            log('Saved trakt_id', { tmdb: id, trakt: tid });
        }

        if (!id) {
            _ownOps.add(id);
            Lampa.Favorite.add(folder, card);
            if (onDone) onDone();
            return;
        }

        var type = (card.method === 'movie' || card.card_type === 'movie') ? 'movie' : 'tv';
        var lang = Lampa.Storage.get('language', 'ru');
        var url  = Lampa.TMDB.api(type + '/' + id + '?api_key=' + Lampa.TMDB.key() + '&language=' + lang);

        var network = new Lampa.Reguest();
        network.silent(url, function (data) {
            var enriched = Object.assign({}, card, data, {
                ids:    card.ids,
                method: card.method || (type === 'tv' ? 'tv' : 'movie'),
                id:     id
            });
            if (type === 'tv' && enriched.name) enriched.title = enriched.name;
            log('Enriched', { id: id, title: enriched.title || enriched.name });
            _ownOps.add(id);
            Lampa.Favorite.add(folder, enriched);
            if (onDone) onDone();
        }, function () {
            log('TMDB enrich failed', id);
            _ownOps.add(id);
            Lampa.Favorite.add(folder, card);
            if (onDone) onDone();
        });
    }

    var _replacing = false;

    // -----------------------------------------------------------------------
    // Перехват событий Lampa.Favorite
    // -----------------------------------------------------------------------

    function initFavoriteListener() {
        Lampa.Favorite.listener.follow('add', function (e) {
            if (!e || !e.where || !e.card) return;
            var folder = e.where;
            if (folder !== 'book' && folder !== 'thrown') return;
            var id = tmdbId(e.card);
            if (id && _ownOps.has(id)) {
                _ownOps.delete(id);
                log('Skip own add', { folder: folder, id: id });
                return;
            }
            if (!isEnabled()) return;
            onAdd(folder, e.card);
        });

        Lampa.Favorite.listener.follow('remove', function (e) {
            if (!e || !e.where || !e.card) return;
            var folder = e.where;
            if (folder !== 'book' && folder !== 'thrown') return;
            var id = tmdbId(e.card);
            if (id && _ownOps.has(id)) {
                _ownOps.delete(id);
                log('Skip own remove', { folder: folder, id: id });
                return;
            }
            if (!isEnabled()) return;
            onRemove(folder, e.card);
        });
    }

    // -----------------------------------------------------------------------
    // Перехват открытия bookmarks
    // -----------------------------------------------------------------------

    function initActivityListener() {
        Lampa.Listener.follow('activity', function (e) {
            if (!e || e.type !== 'start') return;
            var activity = e.object || {};

            if (activity.component === 'bookmarks') {
                log('Bookmarks opened, syncing');
                syncFolder('book');
                syncFolder('look');
                return;
            }

            if (activity.component === 'favorite' && _replacing) {
                log('Skip activity - own replace');
            }
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
                description: 'Закладки ↔ Watchlist, Брошено ↔ выбранный список'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: {
                name: STORAGE_LOOK_DAYS,
                type: 'select',
                'default': String(DEFAULT_LOOK_DAYS),
                values: { '7': '7 дней', '14': '14 дней', '30': '30 дней', '60': '60 дней', '90': '90 дней' }
            },
            field: {
                name: 'Период синхронизации папки "Смотрю"',
                description: 'Сериалы просмотренные за указанный период попадают в папку Смотрю'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: 'trakt_sync_thrown_now', type: 'button' },
            field: {
                name: 'Синхронизировать папку "Брошено" из Trakt',
                description: 'Подтянуть изменения из Trakt в папку Брошено'
            },
            onRender: function (item) {
                if (!Lampa.Storage.get('trakt_token') || !Lampa.Storage.get(STORAGE_LIST_ID)) item.hide();
                else item.show();
            },
            onChange: function () {
                var api = getApi();
                if (!api) return;
                Lampa.Bell.push({ text: 'Синхронизация Брошено...' });
                syncFolder('thrown');
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: 'trakt_sync_thrown_select', type: 'button' },
            field: {
                name: 'Список Trakt для папки "Брошено"',
                description: Lampa.Storage.get(STORAGE_LIST_NAME) || 'Не выбран'
            },
            onRender: function (item) {
                var name = Lampa.Storage.get(STORAGE_LIST_NAME) || 'Не выбран';
                item.find('.settings-param__description').text(name);
                if (!Lampa.Storage.get('trakt_token')) item.hide(); else item.show();
            },
            onChange: function () {
                var api = getApi();
                if (!api) return;
                api.myLists({ page: 1, limit: 100, forceFresh: true }).then(function (response) {
                    var lists = (response && response.results) || [];
                    if (!lists.length) {
                        Lampa.Bell.push({ text: 'Нет личных списков в Trakt' });
                        return;
                    }
                    var items = lists.map(function (list) {
                        return {
                            title:    list.list_title || list.title || String(list.id),
                            listId:   list.id,
                            listName: list.list_title || list.title || String(list.id)
                        };
                    });
                    items.push({ title: 'Отмена', cancel: true });
                    Lampa.Select.show({
                        title: 'Список для "Брошено"',
                        items: items,
                        onSelect: function (item) {
                            if (item.cancel) { Lampa.Controller.toggle('settings_component'); return; }
                            Lampa.Storage.set(STORAGE_LIST_ID,   item.listId);
                            Lampa.Storage.set(STORAGE_LIST_NAME, item.listName);
                            Lampa.Bell.push({ text: '"' + item.listName + '" выбран для Брошено' });
                            Lampa.Settings.update();
                            Lampa.Controller.toggle('settings_component');
                        },
                        onBack: function () { Lampa.Controller.toggle('settings_component'); }
                    });
                }).catch(function () {
                    Lampa.Bell.push({ text: 'Ошибка загрузки списков Trakt' });
                });
            }
        });
    }

    // -----------------------------------------------------------------------
    // Запуск
    // -----------------------------------------------------------------------

    function start() {
        if (window.appready) {
            addSettings();
            initFavoriteListener();
            initActivityListener();
            log('Ready');
        } else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') {
                    addSettings();
                    initFavoriteListener();
                    initActivityListener();
                    log('Ready');
                }
            });
        }
    }

    if (!window.plugin_trakt_folder_sync_ready) {
        window.plugin_trakt_folder_sync_ready = true;
        start();
    }

})();
