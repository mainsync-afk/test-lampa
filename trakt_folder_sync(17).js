(function () {
    'use strict';

    var SYNC_TAG = 'TraktFolderSync';
    var STORAGE_THROWN_LIST_ID   = 'trakt_sync_thrown_list_id';
    var STORAGE_THROWN_LIST_NAME = 'trakt_sync_thrown_list_name';
    var STORAGE_ENABLED          = 'trakt_folder_sync_enabled';

    function log(msg, data) {
        if (!Lampa.Storage.field('trakt_enable_logging')) return;
        if (data !== undefined) console.log(SYNC_TAG, msg, data);
        else console.log(SYNC_TAG, msg);
    }

    function isEnabled() {
        return !!(
            Lampa.Storage.get('trakt_token') &&
            Lampa.Storage.field(STORAGE_ENABLED) !== false
        );
    }

    function getTraktApi() {
        try { if (window.TraktTV && window.TraktTV.api) return window.TraktTV.api; }
        catch (e) {}
        return null;
    }

    function cardTmdbId(card) {
        if (!card) return null;
        var id = (card.ids && card.ids.tmdb) || card.id;
        return id ? String(id) : null;
    }

    function buildSyncParams(card) {
        var method = card.method || card.card_type || card.type ||
                     (card.first_air_date || card.name ? 'tv' : 'movie');
        var ids = Object.assign({}, card.ids || {});
        if (!ids.tmdb && card.id) ids.tmdb = card.id;
        return { method: method, ids: ids, id: card.id };
    }

    // Set ID карточек которые мы сами добавляем/удаляем из Lampa (защита от петли)
    var _ownOps = new Set();

    function enrichAndAdd(folder, card, onDone) {
        var tmdbId = cardTmdbId(card);
        if (!tmdbId) {
            _ownOps.add(tmdbId);
            Lampa.Favorite.add(folder, card);
            if (onDone) onDone();
            return;
        }
        var type = (card.method === 'movie' || card.card_type === 'movie') ? 'movie' : 'tv';
        var lang = Lampa.Storage.get('language', 'ru');
        var url  = Lampa.TMDB.api(type + '/' + tmdbId + '?api_key=' + Lampa.TMDB.key() + '&language=' + lang);

        var network = new Lampa.Reguest();
        network.silent(url, function (data) {
            var enriched = Object.assign({}, card, data, {
                ids:    card.ids,
                method: card.method || (type === 'tv' ? 'tv' : 'movie'),
                id:     tmdbId
            });
            // Для сериалов TMDB возвращает название в поле 'name', не 'title'
            // Синхронизируем title с name чтобы карточка отображалась на русском
            if (type === 'tv' && enriched.name && !enriched.title) {
                enriched.title = enriched.name;
            } else if (type === 'tv' && enriched.name) {
                enriched.title = enriched.name;
            }
            log('Enriched card', { id: tmdbId, title: enriched.title || enriched.name });
            _ownOps.add(String(tmdbId));
            Lampa.Favorite.add(folder, enriched);
            if (onDone) onDone();
        }, function () {
            log('TMDB enrich failed, adding as-is', tmdbId);
            _ownOps.add(String(tmdbId));
            Lampa.Favorite.add(folder, card);
            if (onDone) onDone();
        });
    }

    // ----- Lampa -> Trakt ---------------------------------------------------

    function onFavoriteChanged(folder, method, card) {
        if (!isEnabled()) return;
        var api = getTraktApi();
        if (!api) return;

        var id = cardTmdbId(card);

        // Если это наша собственная операция из синхронизации — игнорируем
        if (id && _ownOps.has(String(id))) {
            _ownOps.delete(String(id));
            log('Skipping own op', { folder: folder, method: method, id: id });
            return;
        }

        // Если фильм защищён (addToList ещё не завершился) — игнорируем remove
        if (method === 'remove' && id && _ownOps.has('thrown:' + String(id))) {
            log('Skipping remove - thrown op in progress', id);
            return;
        }

        var params = buildSyncParams(card);
        log('Lampa->Trakt', { folder: folder, method: method, id: id });

        if (folder === 'book') {
            if (method === 'add') {
                api.addToWatchlist(params)
                    .then(function () { log('Added to Watchlist'); })
                    .catch(function (e) { log('addToWatchlist error', e); });
            } else {
                api.removeFromWatchlist(params)
                    .then(function () { log('Removed from Watchlist'); })
                    .catch(function (e) { log('removeFromWatchlist error', e); });
            }
        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
            if (!listId) { log('thrown list not configured'); return; }
            if (method === 'add') {
                // При добавлении в Брошено — убираем из Закладок и Trakt Watchlist
                var cardId = cardTmdbId(card);
                // Защищаем от удаления синхронизацией пока API запрос не завершился
                // Держим в _ownOps на время пока addToList не завершится
                _ownOps.add('thrown:' + String(cardId));
                var inBook = (Lampa.Favorite.get({ type: 'book' }) || [])
                    .some(function (c) { return cardTmdbId(c) === cardId; });
                if (inBook) {
                    log('Removing from book on thrown add', cardId);
                    _ownOps.add(String(cardId));
                    Lampa.Favorite.remove('book', card);
                    api.removeFromWatchlist(params)
                        .then(function () { log('Removed from Watchlist on thrown add'); })
                        .catch(function (e) { log('removeFromWatchlist error', e); });
                }
                api.addToList({ listId: listId, item: params })
                    .then(function () {
                        log('Added to thrown list');
                        _ownOps.delete('thrown:' + String(cardId));
                    })
                    .catch(function (e) {
                        log('addToList error', e);
                        _ownOps.delete('thrown:' + String(cardId));
                    });
            } else {
                api.removeFromList({ listId: listId, item: params })
                    .then(function () { log('Removed from thrown list'); })
                    .catch(function (e) { log('removeFromList error', e); });
            }
        }
    }

    // ----- Trakt -> Lampa ---------------------------------------------------

    var syncInProgress = { book: false, thrown: false };
    var _replacing = false; // флаг чтобы не триггерить синхронизацию от нашего replace

    function refreshCurrentFolder(folder) {
        try {
            var active = Lampa.Activity.active();
            if (!active || active.component !== 'favorite' || active.type !== folder) return;
            var saved = Object.assign({}, active);
            _replacing = true;
            Lampa.Activity.backward();
            setTimeout(function () {
                Lampa.Activity.push(saved);
                setTimeout(function () { _replacing = false; }, 3000);
            }, 300);
        } catch (e) { log('refreshCurrentFolder error', e); }
    }

    function syncTraktToLampa(folder) {
        if (!isEnabled() || syncInProgress[folder]) return;
        var api = getTraktApi();
        if (!api) return;
        syncInProgress[folder] = true;
        log('Start sync Trakt->Lampa', folder);
        fetchAllTraktItems(api, folder)
            .then(function (items) { return applyTraktToLampa(folder, items); })
            .catch(function (e) { log('sync error', e); })
            .then(function () { syncInProgress[folder] = false; });
    }

    function fetchAllTraktItems(api, folder) {
        if (folder === 'book') {
            return fetchAllPages(function (p) {
                return api.watchlist({ page: p, limit: 100, mediaType: 'movies,shows' });
            });
        }
        if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
            if (!listId) return Promise.resolve([]);
            return fetchAllPages(function (p) {
                return api.myListItems({ listId: listId, page: p, limit: 100 });
            });
        }
        return Promise.resolve([]);
    }

    function fetchAllPages(fn) {
        var all = [];
        function next(page) {
            return fn(page).then(function (data) {
                var results = (data && data.results) ? data.results : [];
                all = all.concat(results);
                if (page < ((data && data.total_pages) || 1)) return next(page + 1);
                return all;
            });
        }
        return next(1);
    }

    function applyTraktToLampa(folder, traktItems) {
        return new Promise(function (resolve) {
            var localItems = Lampa.Favorite.get({ type: folder }) || [];
            var localIds   = new Set(localItems.map(cardTmdbId).filter(Boolean));
            var traktIds   = new Set(traktItems.map(cardTmdbId).filter(Boolean));
            var removed = 0;

            // Есть в Lampa, нет в Trakt -> удалить
            localItems.forEach(function (card) {
                var id = cardTmdbId(card);
                if (!id || traktIds.has(id)) return;
                // Пропускаем если карточка защищена (addToList ещё не завершился)
                if (_ownOps.has('thrown:' + String(id)) || _ownOps.has('book:' + String(id))) {
                    log('Skipping removal - protected', id);
                    return;
                }
                try {
                    _ownOps.add(String(id));
                    Lampa.Favorite.remove(folder, card);
                    removed++;
                } catch (e) { log('remove error', e); }
            });

            // Есть в Trakt, нет в Lampa -> добавить с обогащением
            var toAdd = traktItems.filter(function (card) {
                var id = cardTmdbId(card);
                return id && !localIds.has(id);
            });

            var added = 0;

            function addNext(index) {
                if (index >= toAdd.length) {
                    log('Sync done', { folder: folder, added: added, removed: removed });
                    if (removed && !added) refreshCurrentFolder(folder);
                    if (added) {
                        // Ждём завершения синхронизации CUB с сервером
                        // из лога видно: Favorite.add -> Account sync -> bookmarks complete -> Timetable
                        // Обновляем папку через 2.5с — к этому времени Account sync точно завершится
                        setTimeout(function () {
                            refreshCurrentFolder(folder);
                        }, 2500);
                    }
                    resolve();
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
                if (removed) refreshCurrentFolder(folder);
                resolve();
            }
        });
    }

    // ----- Перехват открытия папки ------------------------------------------

    function hookFavoriteOpen() {
        Lampa.Listener.follow('activity', function (e) {
            if (!e || e.type !== 'start') return;
            var activity = e.object || {};

            // Пользователь открыл экран Избранного — запускаем синхронизацию заранее
            if (activity.component === 'bookmarks') {
                log('Bookmarks screen opened, pre-syncing');
                syncTraktToLampa('book');
                var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
                if (listId) syncTraktToLampa('thrown');
                return;
            }

            if (activity.component !== 'favorite') return;
            if (_replacing) { log('Skipping sync - own replace'); return; }
            var folder = activity.type;
            if (folder === 'book' || folder === 'thrown') {
                // Синхронизация уже могла запуститься из bookmarks — не дублируем
                if (!syncInProgress[folder]) {
                    setTimeout(function () { syncTraktToLampa(folder); }, 300);
                }
            }
        });
    }

    // ----- Настройки --------------------------------------------------------

    function addSettings() {
        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: STORAGE_ENABLED, type: 'trigger', 'default': true },
            field: {
                name: 'Синхронизация нативных папок',
                description: 'Закладки <-> Watchlist, Брошено <-> выбранный список'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: 'trakt_sync_thrown_select', type: 'button' },
            field: {
                name: 'Список Trakt для папки "Брошено"',
                description: Lampa.Storage.get(STORAGE_THROWN_LIST_NAME) || 'Не выбран'
            },
            onRender: function (item) {
                var name = Lampa.Storage.get(STORAGE_THROWN_LIST_NAME) || 'Не выбран';
                item.find('.settings-param__description').text(name);
                if (!Lampa.Storage.get('trakt_token')) item.hide(); else item.show();
            },
            onChange: function () {
                var api = getTraktApi();
                if (!api) return;
                api.myLists({ page: 1, limit: 100 }).then(function (response) {
                    var lists = (response && response.results) ? response.results : [];
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
                            Lampa.Storage.set(STORAGE_THROWN_LIST_ID,   item.listId);
                            Lampa.Storage.set(STORAGE_THROWN_LIST_NAME, item.listName);
                            Lampa.Bell.push({ text: 'Список "' + item.listName + '" выбран для Брошено' });
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

    // ----- Инициализация ----------------------------------------------------

    function init() {
        Lampa.Favorite.listener.follow('add', function (e) {
            if (!e || !e.where || !e.card) return;
            var folder = e.where;
            if (folder !== 'book' && folder !== 'thrown') return;
            onFavoriteChanged(folder, 'add', e.card);
        });

        Lampa.Favorite.listener.follow('remove', function (e) {
            if (!e || !e.where || !e.card) return;
            var folder = e.where;
            if (folder !== 'book' && folder !== 'thrown') return;
            onFavoriteChanged(folder, 'remove', e.card);
        });

        hookFavoriteOpen();
        log('Initialized');
    }

    function start() {
        if (window.appready) { addSettings(); init(); }
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') { addSettings(); init(); }
            });
        }
    }

    if (!window.plugin_trakt_folder_sync_ready) {
        window.plugin_trakt_folder_sync_ready = true;
        start();
    }

})();
