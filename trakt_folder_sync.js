// trakt_folder_sync — плагин Lampa для синхронизации папок с Trakt.
// Переписывается с нуля по SPEC.md.
// Предыдущая стабильная версия — коммит 14aabd9 (доступна через git).
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Константы
    // -----------------------------------------------------------------------

    var VERSION         = '0.7.0';

    var SYNC_TAG        = 'TraktFolderSync';
    // Не создаём свой компонент — подмешиваем параметры в уже существующий
    // раздел «Trakt» от плагина trakt_by_lampame / trakttv. В v0.4.0–0.4.1
    // пробовали свой component: 'trakt_folder_sync' — Lampa регистрировала
    // его без ошибок, но в UI панели он не появлялся. Возврат к паттерну v44.
    var COMPONENT       = 'trakt';
    var STORAGE_ENABLED = 'trakt_folder_sync_enabled';
    var STORAGE_LOGGING = 'trakt_enable_logging';
    var STORAGE_PENDING = 'trakt_folder_sync_pending';

    // Базовый URL — тот же прокси, что использует trakt_by_lampame. Прокси
    // подставляет trakt-api-key на сервере, поэтому прямой api.trakt.tv без
    // собственного зарегистрированного client_id не подходит. См. SPEC.md.
    var API_URL = 'https://apx.lme.isroot.in/trakt';

    // Задержка между TMDB-обогащениями (чтобы не упираться в лимиты TMDB).
    var ADD_DELAY_MS = 150;

    // Окно, в течение которого Pending Ops перекрывают состояние Trakt.
    // Trakt API отдаёт устаревшие данные 5–15 минут после записи — в это
    // время действие пользователя не должно откатываться синхронизацией.
    // См. SPEC.md § «Задержки Trakt API и механизм Pending Ops».
    var PENDING_TTL_SEC = 15 * 60;

    // Окно, в течение которого метка _ownOps защищает от парных событий
    // Favorite.listener (Lampa иногда эмитит add/remove дважды за одну
    // операцию — в этом окне оба события считаются «нашими»).
    // 1.5 секунды — с запасом на задержку листенера.
    var OWN_OPS_TTL_MS = 1500;

    // Окно дедупликации исходящих POST-запросов в Trakt по id+action.
    // Защищает от дубля, когда Lampa эмитит парные события от действия
    // пользователя (оба прошли consumeOwn, оба улетели бы в Trakt).
    var WRITE_DEDUP_WINDOW_MS = 1500;

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

    // Определяем тип карточки (movie/show) для Trakt API.
    // Используется только для информативных логов и для watchlistItemToStub.
    // В write-пути тип НЕ угадываем — отправляем в Trakt оба массива сразу
    // (movies и shows) и читаем фактический тип из ответа. TMDB id
    // namespaced per type, поэтому в watchlist попадёт ровно один из двух,
    // а другой окажется в not_found — см. pushWatchlist.
    //
    // До v0.5.1 эта эвристика использовалась для формирования POST-body
    // и давала ложные movie для «тощих» карточек от парных событий Lampa,
    // из-за чего сериалы молча не добавлялись в Trakt (тикет 2026-04-24).
    function cardIsShow(card) {
        if (!card) return false;
        if (card.method === 'tv' || card.card_type === 'tv') return true;
        if (card.media_type === 'tv') return true;
        if (card.number_of_seasons != null) return true;
        if (card.first_air_date && !card.release_date) return true;
        if (card.name && !card.title) return true;
        return false;
    }

    // -----------------------------------------------------------------------
    // Pending Ops — буфер под задержку Trakt API
    // -----------------------------------------------------------------------
    //
    // После каждой успешной записи в Trakt кладём сюда запись
    // { id, type, folder, action, ts }. На syncBook-е накладываем эти записи
    // поверх diff'а: pending add → не удалять, pending remove → не добавлять.
    // По истечении PENDING_TTL_SEC запись протухает сама.

    function loadPendingOps() {
        var raw;
        try { raw = Lampa.Storage.get(STORAGE_PENDING, '[]'); }
        catch (e) { return []; }
        var arr;
        try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { return []; }
        if (!Array.isArray(arr)) return [];

        var cutoff = Math.floor(Date.now() / 1000) - PENDING_TTL_SEC;
        var fresh  = arr.filter(function (op) {
            return op && op.id && op.action && op.ts && op.ts >= cutoff;
        });
        // Протухшие — вычищаем из хранилища сразу.
        if (fresh.length !== arr.length) {
            try { Lampa.Storage.set(STORAGE_PENDING, fresh); } catch (e) {}
        }
        return fresh;
    }

    function addPendingOp(op) {
        if (!op || !op.id || !op.folder || !op.action) return;
        var ops = loadPendingOps();
        // Дубликаты (id+folder+action) заменяем свежим ts.
        ops = ops.filter(function (x) {
            return !(x.id === op.id && x.folder === op.folder && x.action === op.action);
        });
        ops.push({
            id:     String(op.id),
            type:   op.type || 'movie',
            folder: op.folder,
            action: op.action,
            ts:     Math.floor(Date.now() / 1000)
        });
        try { Lampa.Storage.set(STORAGE_PENDING, ops); } catch (e) {}
        log('pending op сохранён', op);
    }

    // -----------------------------------------------------------------------
    // _ownOps — защита от петли собственных записей в Lampa.Favorite
    // -----------------------------------------------------------------------
    //
    // syncBook вызывает Lampa.Favorite.add/remove, которые рожают события
    // на Favorite.listener — те же события слушает наш favorite-listener,
    // и без защиты каждая наша синхронизация порождала бы write-запрос в
    // Trakt, размножая действия пользователя.
    //
    // Lampa в некоторых случаях эмитит события парно (два события на одну
    // операцию), поэтому метка работает как TTL-окно, а не как одноразовый
    // consume: пока метка жива — ВСЕ события с этим id пропускаются.

    var _ownOps = new Map(); // id (string) → expiresAtMs

    function markOwn(id) {
        if (!id) return;
        // Ленивая GC протухших записей, чтобы Map не рос вечно.
        var now = Date.now();
        _ownOps.forEach(function (exp, k) { if (now > exp) _ownOps['delete'](k); });
        _ownOps.set(String(id), now + OWN_OPS_TTL_MS);
    }

    function consumeOwn(id) {
        if (!id) return false;
        id = String(id);
        var exp = _ownOps.get(id);
        if (!exp) return false;
        if (Date.now() > exp) {
            _ownOps['delete'](id);
            return false;
        }
        // Метку НЕ удаляем — пусть накроет парное событие в TTL-окне.
        return true;
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
            // Для сериалов TMDB возвращает локализованное name (Lampa ждёт
            // title для списочных представлений). В stub.title у нас лежит
            // канонический заголовок из Trakt — как правило, английский.
            // Всегда перезаписываем: приоритет — локализация TMDB.
            // Проверка `!enriched.title` здесь НЕ нужна — из-за неё в v0.6.0
            // сериалы в list-view папок показывались по-английски, хотя
            // внутри карточки (где Lampa читает name/overview) всё было на
            // языке пользователя.
            if (type === 'tv' && enriched.name) {
                enriched.title = enriched.name;
            }
            markOwn(id);
            try { Lampa.Favorite.add(folder, enriched); }
            catch (e) { warn('Favorite.add err', e); }
            if (onDone) onDone();
        }, function (err) {
            warn('TMDB enrich failed', { id: id, type: type, err: err });
            // Падать полностью не хотим — кладём тощую карточку, будет хотя бы
            // заглушка; при следующей синхронизации попробуем ещё раз.
            markOwn(id);
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

            // Накладываем Pending Ops: то, что пользователь только что
            // сделал в Lampa, не должно откатываться из-за того, что Trakt
            // ещё не пересчитал watchlist. SPEC.md § «Pending Ops».
            var pending = loadPendingOps().filter(function (op) {
                return op.folder === 'book';
            });
            if (pending.length) {
                var pendingAdd    = new Set();
                var pendingRemove = new Set();
                pending.forEach(function (op) {
                    if (op.action === 'add')    pendingAdd.add(op.id);
                    if (op.action === 'remove') pendingRemove.add(op.id);
                });
                // pending add → пользователь только что добавил: не трогать локально
                toRemove = toRemove.filter(function (c) { return !pendingAdd.has(tmdbId(c)); });
                // pending remove → пользователь только что удалил: не возвращать
                toAdd    = toAdd.filter(function (c)   { return !pendingRemove.has(tmdbId(c)); });
                log('pending ops применены', {
                    total: pending.length,
                    add: pendingAdd.size, remove: pendingRemove.size
                });
            }

            // Удаления — мгновенно, без обогащения.
            // markOwn — чтобы собственный Favorite.remove не улетел обратно
            // в Trakt через favorite-listener как действие пользователя.
            toRemove.forEach(function (card) {
                var rid = tmdbId(card);
                if (rid) markOwn(rid);
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
    // Классификация сериалов и синхронизация статусных папок
    // -----------------------------------------------------------------------
    //
    // SPEC.md § «Логика статусов сериала».
    //
    // Решающий сигнал — ПРОСМОТРЕНА ЛИ ПОСЛЕДНЯЯ ВЫШЕДШАЯ СЕРИЯ
    // (not: сравнение количества вышло/просмотрено). Это важно, потому
    // что пользователь может пропустить серию в середине: «смотрел 1,3,5»
    // — количественно 3<5, но с точки зрения «что можно смотреть сейчас»
    // сериал догнан (следующая серия ещё не вышла). Trakt UI использует
    // ту же семантику, и это соответствует ожиданиям пользователя.
    //
    // Источник данных — на каждый сериал запрос
    // /shows/:trakt_id/progress/watched. В ответе:
    //   • last_episode            — последняя вышедшая (season, number)
    //   • seasons[].episodes[]    — с флагом completed для каждой серии
    //   • aired, completed        — счётчики (используем только для логов)
    // Status сериала (returning series / ended / canceled / ...) берём
    // из /sync/watched/shows?extended=full, там он уже есть.
    //
    // Цена: 1 запрос /sync/watched/shows + N запросов /shows/:id/progress
    // (параллельно через Promise.all). Для типичного watched-списка в
    // десятки шоу это ~20–40 HTTP-вызовов — укладывается в Trakt
    // rate limit 1000/5мин с запасом.
    //
    // Фильмы в viewed — /sync/watched/movies (любой plays > 0 = смотрели).
    // Сериалы идут в look/viewed/continued, фильмы — только в viewed.
    //
    // Write-путь у статусных папок не реализован: отметка серий
    // просмотренными делается сторонним плагином scrobbling'ом, мы лишь
    // отражаем итоговую раскладку.

    function classifyShow(row) {
        var completed = row.completed || 0;
        var status    = String(row.status || '').toLowerCase();
        if (completed === 0)          return null;        // ни одного просмотра — не статусная
        if (!row.lastAiredWatched)    return 'look';      // есть непросмотренная вышедшая серия
        if (status === 'ended' || status === 'canceled') return 'viewed';
        return 'continued';                               // догнал, ждёт новые серии
    }

    // Проверяем, отмечен ли просмотренным конкретно последний вышедший
    // эпизод (progress.last_episode). Не сравниваем количества — ищем
    // именно эту серию в progress.seasons[].episodes[].
    function isLastAiredWatched(progress) {
        if (!progress || !progress.last_episode) return false;
        var last = progress.last_episode;
        var season = (progress.seasons || []).find(function (s) {
            return s && s.number === last.season;
        });
        if (!season) return false;
        var ep = (season.episodes || []).find(function (e) {
            return e && e.number === last.number;
        });
        return !!(ep && ep.completed);
    }

    function fetchShowProgress(showKey) {
        return traktFetch('/shows/' + encodeURIComponent(showKey) + '/progress/watched')
            ['catch'](function (err) {
                warn('progress failed', {
                    show: showKey,
                    status: err && err.status,
                    message: err && err.message
                });
                return null;
            });
    }

    function fetchShowsClassification() {
        return traktFetch('/sync/watched/shows?extended=full').then(function (items) {
            if (!Array.isArray(items)) return [];
            var valid = items.filter(function (it) {
                return it && it.show && it.show.ids
                    && it.show.ids.tmdb && it.show.ids.trakt;
            });
            // N+1: один progress-запрос на сериал. Параллельно.
            return Promise.all(valid.map(function (it) {
                return fetchShowProgress(it.show.ids.trakt).then(function (progress) {
                    return { it: it, progress: progress };
                });
            })).then(function (pairs) {
                var rows = [];
                pairs.forEach(function (p) {
                    var show     = p.it.show;
                    var progress = p.progress;
                    var row = {
                        id:               String(show.ids.tmdb),
                        ids:              show.ids,
                        title:            show.title || '',
                        year:             show.year,
                        status:           show.status || '',
                        aired:            progress ? (progress.aired || 0) : 0,
                        completed:        progress ? (progress.completed || 0) : 0,
                        lastEpisode:      progress && progress.last_episode,
                        lastAiredWatched: isLastAiredWatched(progress)
                    };
                    row.folder = classifyShow(row);
                    log('классификация сериала', {
                        title:              row.title,
                        tmdb:               row.id,
                        progress_aired:     row.aired,
                        progress_completed: row.completed,
                        show_status:        row.status,
                        last_episode:       row.lastEpisode
                            ? 'S' + row.lastEpisode.season + 'E' + row.lastEpisode.number
                            : null,
                        last_aired_watched: row.lastAiredWatched,
                        classified_as:      row.folder || '— (completed == 0)'
                    });
                    if (row.folder) rows.push(row);
                });
                return rows;
            });
        });
    }

    function fetchWatchedMovies() {
        return traktFetch('/sync/watched/movies').then(function (items) {
            if (!Array.isArray(items)) return [];
            var rows = [];
            items.forEach(function (it) {
                var m = it && it.movie;
                if (!m || !m.ids || !m.ids.tmdb) return;
                rows.push({
                    id:    String(m.ids.tmdb),
                    ids:   m.ids,
                    title: m.title || '',
                    year:  m.year
                });
            });
            return rows;
        });
    }

    function computeStatusFolders() {
        return Promise.all([fetchShowsClassification(), fetchWatchedMovies()])
            .then(function (results) {
                var shows  = results[0];
                var movies = results[1];

                var desired = { look: [], viewed: [], continued: [] };

                shows.forEach(function (row) {
                    desired[row.folder].push({
                        id:        row.id,
                        ids:       row.ids,
                        title:     row.title,
                        year:      row.year,
                        method:    'tv',
                        card_type: 'tv'
                    });
                });

                movies.forEach(function (m) {
                    desired.viewed.push({
                        id:        m.id,
                        ids:       m.ids,
                        title:     m.title,
                        year:      m.year,
                        method:    'movie',
                        card_type: 'movie'
                    });
                });

                return desired;
            });
    }

    function syncStatusFolder(folder, desiredList) {
        return new Promise(function (resolve) {
            var desiredIds = new Set(desiredList.map(function (s) { return String(s.id); }));
            var local      = Lampa.Favorite.get({ type: folder }) || [];
            var localIds   = new Set(local.map(tmdbId).filter(Boolean));

            var toAdd    = desiredList.filter(function (s) { return !localIds.has(String(s.id)); });
            var toRemove = local.filter(function (c) {
                var id = tmdbId(c);
                return id && !desiredIds.has(id);
            });

            // Удаляем то, что больше не должно быть в папке. markOwn — потому
            // что listener всё равно посмотрит на where и наш обработчик для
            // book проигнорирует, но защита на будущее не повредит.
            toRemove.forEach(function (card) {
                var rid = tmdbId(card);
                if (rid) markOwn(rid);
                try { Lampa.Favorite.remove(folder, card); }
                catch (e) { warn(folder + ' remove err', e); }
            });

            function done() {
                log('syncStatusFolder: готово', {
                    folder: folder,
                    desired: desiredList.length,
                    added: toAdd.length,
                    removed: toRemove.length
                });
                resolve();
            }

            if (!toAdd.length) { done(); return; }

            var i = 0;
            function step() {
                if (i >= toAdd.length) { done(); return; }
                // markOwn ставится внутри enrichAndAdd перед Favorite.add.
                // Для статусной папки Lampa может сама снять карточку с
                // другого статуса (look→continued и т.п.), — метка накроет
                // сопутствующий remove-event.
                enrichAndAdd(folder, toAdd[i], function () {
                    i++;
                    setTimeout(step, ADD_DELAY_MS);
                });
            }
            step();
        });
    }

    var _syncingStatus = false;

    function syncStatusFolders() {
        if (_syncingStatus) { log('syncStatusFolders: уже идёт, пропуск'); return; }
        if (!isEnabled()) { log('syncStatusFolders: синхронизация отключена'); return; }
        if (!hasToken())  { log('syncStatusFolders: нет токена');            return; }
        _syncingStatus = true;
        log('syncStatusFolders: старт');

        computeStatusFolders().then(function (desired) {
            log('статусы рассчитаны', {
                look:      desired.look.length,
                viewed:    desired.viewed.length,
                continued: desired.continued.length
            });
            // Диагностика: выводим названия и trakt-id, чтобы можно было
            // сверить с тем, что реально лежит в Trakt-аккаунте. Если тут
            // появляются карточки, которых в Trakt-вебе нет, значит токен
            // привязан к другому аккаунту или в Trakt есть рассинхрон
            // между /sync/watched и UI-страницей History.
            ['look', 'viewed', 'continued'].forEach(function (f) {
                if (!desired[f].length) return;
                log('папка ' + f + ': классифицировано', desired[f].map(function (s) {
                    return {
                        title: s.title,
                        year:  s.year,
                        tmdb:  s.id,
                        trakt: s.ids && s.ids.trakt
                    };
                }));
            });
            return Promise.all([
                syncStatusFolder('look',      desired.look),
                syncStatusFolder('viewed',    desired.viewed),
                syncStatusFolder('continued', desired.continued)
            ]);
        }).then(function () {
            _syncingStatus = false;
            log('syncStatusFolders: готово');
        })['catch'](function (err) {
            warn('syncStatusFolders failed', {
                status:   err && err.status,
                message:  err && err.message,
                response: err && err.response
            });
            _syncingStatus = false;
        });
    }

    // -----------------------------------------------------------------------
    // Write-путь: действия пользователя → Trakt API
    // -----------------------------------------------------------------------
    //
    // SPEC.md § «Ручные действия пользователя».
    // book ↔ Trakt Watchlist — единственная двусторонняя папка в текущей
    // версии. Добавление/удаление карточки в Lampa отправляем в Trakt
    // через POST /sync/watchlist[/remove], затем кладём Pending Op.

    // Собираем body для /sync/watchlist[/remove].
    // Отправляем id СРАЗУ в обоих массивах — movies и shows. TMDB id
    // namespaced per type, так что Trakt найдёт ровно одну сущность;
    // лишний объект уйдёт в not_found и проигнорируется.
    // Фактический тип определяется по полю added/deleted в ответе —
    // см. pushWatchlist. Эвристика cardIsShow оставлена только для
    // предварительного лога и в write-пути больше не используется.
    function buildWatchlistBody(card) {
        var id = tmdbId(card);
        if (!id) return null;
        var entry = { ids: { tmdb: Number(id) } };
        var body  = { movies: [entry], shows: [entry] };
        return { body: body, guessedType: cardIsShow(card) ? 'show' : 'movie', id: id };
    }

    // Извлекаем фактический тип (movie/show) из ответа Trakt по /sync/watchlist.
    // Формат ответа: { added|deleted: { movies: N, shows: N }, ... }
    // Возвращаем 'movie' | 'show' | null (если ни один из счётчиков не > 0 —
    // то есть Trakt не нашёл id вообще, скорее всего лежит в not_found).
    function resolveTypeFromTraktResp(resp, action) {
        if (!resp) return null;
        var bucket = resp[action === 'remove' ? 'deleted' : 'added'];
        if (!bucket) return null;
        if ((bucket.movies || 0) > 0) return 'movie';
        if ((bucket.shows  || 0) > 0) return 'show';
        return null;
    }

    // Дедуп исходящих write-запросов. Lampa может эмитить add/remove парно;
    // без этой защиты каждое действие пользователя улетало бы в Trakt дважды.
    // Ключ — action+id (не action+id+type), потому что парное событие может
    // прийти с вырожденной карточкой, у которой наш cardIsShow даёт movie
    // вместо show — и дубль бы прошёл как «другой тип».
    var _recentWrites = new Map(); // 'add:123' → timestampMs

    function pushWatchlist(action, card) {
        if (!hasToken()) return;
        var built = buildWatchlistBody(card);
        if (!built) { warn('pushWatchlist: нет tmdb id', card); return; }

        var key  = action + ':' + built.id;
        var now  = Date.now();
        var last = _recentWrites.get(key);
        if (last && (now - last) < WRITE_DEDUP_WINDOW_MS) {
            log('pushWatchlist: дубль в окне дедупа, пропуск', { key: key });
            return;
        }
        _recentWrites.set(key, now);
        // Ленивая GC давних записей.
        _recentWrites.forEach(function (ts, k) {
            if ((now - ts) > WRITE_DEDUP_WINDOW_MS * 4) _recentWrites['delete'](k);
        });

        var path = action === 'remove' ? '/sync/watchlist/remove' : '/sync/watchlist';
        traktFetch(path, { method: 'POST', body: built.body })
            .then(function (data) {
                var actualType = resolveTypeFromTraktResp(data, action);
                if (!actualType) {
                    // Trakt ответил 200/201, но ни movies, ни shows не
                    // добавились/удалились — скорее всего id неизвестен
                    // (not_found) или Trakt посчитал запись уже существующей.
                    // Для add: проверяем existing как «уже было» — это ок.
                    var existing = data && data.existing;
                    if (action === 'add' && existing &&
                        ((existing.movies || 0) > 0 || (existing.shows || 0) > 0)) {
                        actualType = (existing.movies || 0) > 0 ? 'movie' : 'show';
                        log('watchlist add — уже было в Trakt', { id: built.id, type: actualType });
                    } else {
                        warn('watchlist ' + action + ' — Trakt не распознал id', {
                            id: built.id, resp: data
                        });
                        return;
                    }
                }
                log('watchlist ' + action + ' ok', {
                    id: built.id, type: actualType,
                    guessed: built.guessedType, resp: data
                });
                addPendingOp({
                    id:     built.id,
                    type:   actualType,
                    folder: 'book',
                    action: action
                });
            })['catch'](function (err) {
                warn('watchlist ' + action + ' failed', {
                    id: built.id, guessed: built.guessedType,
                    status: err && err.status, response: err && err.response
                });
            });
    }

    function initFavoriteListener() {
        if (!Lampa.Favorite || !Lampa.Favorite.listener ||
            typeof Lampa.Favorite.listener.follow !== 'function') {
            warn('initFavoriteListener: Lampa.Favorite.listener недоступен');
            return;
        }

        Lampa.Favorite.listener.follow('add', function (e) {
            if (!e || !e.where || !e.card) return;
            if (e.where !== 'book') return;
            var id = tmdbId(e.card);
            if (consumeOwn(id)) {
                log('Favorite.add — пропуск своей же операции', { id: id });
                return;
            }
            if (!isEnabled()) return;
            log('Favorite.add пользователем → Trakt', { id: id });
            pushWatchlist('add', e.card);
        });

        Lampa.Favorite.listener.follow('remove', function (e) {
            if (!e || !e.where || !e.card) return;
            if (e.where !== 'book') return;
            var id = tmdbId(e.card);
            if (consumeOwn(id)) {
                log('Favorite.remove — пропуск своей же операции', { id: id });
                return;
            }
            if (!isEnabled()) return;
            log('Favorite.remove пользователем → Trakt', { id: id });
            pushWatchlist('remove', e.card);
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
            log('bookmarks открыт → syncBook + syncStatusFolders');
            syncBook();
            syncStatusFolders();
        });
    }

    // -----------------------------------------------------------------------
    // Настройки — подмешиваемся в существующий раздел «Trakt» от lampame.
    // Свой раздел через addComponent в v0.4.0/0.4.1 визуально не появлялся,
    // даже когда API-вызов проходил без ошибок. Паттерн v44 работает как
    // ожидалось — ограничиваемся одним addParam.
    // -----------------------------------------------------------------------

    function addSettings() {
        if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.addParam !== 'function') {
            warn('addSettings: Lampa.SettingsApi.addParam недоступен');
            return;
        }

        try {
            Lampa.SettingsApi.addParam({
                component: COMPONENT,
                param: { name: STORAGE_ENABLED, type: 'trigger', 'default': true },
                field: {
                    name: 'Синхронизация папок с Trakt (v' + VERSION + ')',
                    description: 'Закладки, Смотрю, Просмотрено, Продолжение следует — отражают состояние Trakt'
                }
            });
            log('addSettings: ок');
        } catch (e) {
            warn('addSettings: addParam ошибка', e);
        }
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
        initFavoriteListener();
        initActivityListener();

        // Диагностика: какой Trakt-аккаунт стоит за этим токеном. Разовый
        // запрос при старте, не влияет на горячий путь. Поможет отловить
        // случай «токен от одного аккаунта, смотрим в Trakt-веб на другой».
        traktFetch('/users/me').then(function (me) {
            log('Trakt аккаунт', {
                username: me && me.username,
                name:     me && me.name,
                ids:      me && me.ids
            });
        })['catch'](function (err) {
            warn('/users/me запрос не прошёл', { status: err && err.status });
        });
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
