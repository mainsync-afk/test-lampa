(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Trakt Folder Sync
    // Trakt — источник истины, Lampa — интерфейс
    //
    // book   (Закладки) <--> Trakt Watchlist
    // thrown (Брошено)  <--> Trakt личный список (выбирается в настройках)
    // -----------------------------------------------------------------------

    var SYNC_TAG             = 'TraktFolderSync';
    var STORAGE_LIST_ID      = 'trakt_sync_thrown_list_id';
    var STORAGE_LIST_NAME    = 'trakt_sync_thrown_list_name';
    var STORAGE_ENABLED      = 'trakt_folder_sync_enabled';

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
    // Lampa → Trakt (только API вызовы, без изменений Lampa.Favorite)
    // -----------------------------------------------------------------------

    function onAdd(folder, card) {
        var api = getApi();
        if (!api) return;
        var params = buildParams(card);
        log('Lampa->Trakt add', { folder: folder, id: tmdbId(card) });

        if (folder === 'book') {
            api.addToWatchlist(params)
               .then(function () { log('addToWatchlist ok'); })
               .catch(function (e) { log('addToWatchlist err', e); });

        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_LIST_ID);
            if (!listId) { log('thrown list not configured'); return; }
            api.addToList({ listId: listId, item: params })
               .then(function () { log('addToList ok'); })
               .catch(function (e) { log('addToList err', e); });
            api.removeFromWatchlist(params)
               .then(function () { log('removeFromWatchlist ok'); })
               .catch(function (e) { log('removeFromWatchlist err', e); });
        }
    }

    function onRemove(folder, card) {
        var api = getApi();
        if (!api) return;
        var params = buildParams(card);
        log('Lampa->Trakt remove', { folder: folder, id: tmdbId(card) });

        if (folder === 'book') {
            api.removeFromWatchlist(params)
               .then(function () { log('removeFromWatchlist ok'); })
               .catch(function (e) { log('removeFromWatchlist err', e); });

        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_LIST_ID);
            if (!listId) { log('thrown list not configured'); return; }
            api.removeFromList({ listId: listId, item: params })
               .then(function () { log('removeFromList ok'); })
               .catch(function (e) { log('removeFromList err', e); });
        }
    }

    // -----------------------------------------------------------------------
    // Trakt → Lampa (синхронизация при открытии bookmarks)
    // -----------------------------------------------------------------------

    // ID карточек которые мы сами добавляем/удаляем — не отправлять обратно в Trakt
    var _ownOps = new Set();
    var _syncing = { book: false, thrown: false };

    function syncFolder(folder) {
        if (!isEnabled() || _syncing[folder]) return;
        var api = getApi();
        if (!api) return;

        _syncing[folder] = true;
        log('Sync start', folder);

        fetchTraktItems(api, folder)
            .then(function (traktItems) {
                applySync(folder, traktItems);
            })
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

        // Есть в Trakt, нет в Lampa → добавить
        var toAdd = traktItems.filter(function (c) {
            var id = tmdbId(c);
            return id && !localIds.has(id);
        });

        // Есть в Lampa, нет в Trakt → удалить
        _ownOps = new Set(); // сбрасываем перед удалением
        localItems.forEach(function (card) {
            var id = tmdbId(card);
            if (!id || traktIds.has(id)) return;
            try {
                _ownOps.add(id);
                Lampa.Favorite.remove(folder, card);
                removed++;
            } catch (e) { log('remove err', e); }
        });

        // Добавляем последовательно с обогащением через TMDB
        function addNext(index) {
            if (index >= toAdd.length) {
                log('Sync done', { folder: folder, added: added, removed: removed });
                if (added) {
                    setTimeout(function () { refreshFolder(folder); }, 2500);
                }
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
    // Обогащение карточки локализованными данными TMDB
    // -----------------------------------------------------------------------

    function enrichAndAdd(folder, card, onDone) {
        var id = tmdbId(card);
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
            // Для сериалов синхронизируем title с name
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

    // -----------------------------------------------------------------------
    // Обновление папки после синхронизации
    // -----------------------------------------------------------------------

    var _replacing = false;

    function refreshFolder(folder) {
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
        } catch (e) { log('refreshFolder err', e); }
    }

    // -----------------------------------------------------------------------
    // Перехват событий Lampa.Favorite
    // -----------------------------------------------------------------------

    function initFavoriteListener() {
        Lampa.Favorite.listener.follow('add', function (e) {
            if (!e || !e.where || !e.card) return;
            var folder = e.where;
            if (folder !== 'book' && folder !== 'thrown') return;
            var id = tmdbId(e.card);
            // Пропускаем собственные операции из синхронизации
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
            // Пропускаем собственные операции из синхронизации
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
    // Перехват открытия экрана bookmarks
    // -----------------------------------------------------------------------

    function initActivityListener() {
        Lampa.Listener.follow('activity', function (e) {
            if (!e || e.type !== 'start') return;
            var activity = e.object || {};

            // Открыт экран Избранного — запускаем синхронизацию обеих папок
            if (activity.component === 'bookmarks') {
                log('Bookmarks opened, syncing');
                syncFolder('book');
                if (Lampa.Storage.get(STORAGE_LIST_ID)) syncFolder('thrown');
                return;
            }

            // Пропускаем повторный запуск от нашего backward+push
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
