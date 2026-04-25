// trakt_folder_sync — плагин Lampa для синхронизации папок с Trakt.
// Переписывается с нуля по SPEC.md.
// Предыдущая стабильная версия — коммит 14aabd9 (доступна через git).
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Константы
    // -----------------------------------------------------------------------

    var VERSION         = '0.8.4';

    var SYNC_TAG        = 'TraktFolderSync';
    var STATUS_FOLDERS  = ['look', 'viewed', 'continued'];
    // Не создаём свой компонент — подмешиваем параметры в уже существующий
    // раздел «Trakt» от плагина trakt_by_lampame / trakttv. В v0.4.0–0.4.1
    // пробовали свой component: 'trakt_folder_sync' — Lampa регистрировала
    // его без ошибок, но в UI панели он не появлялся. Возврат к паттерну v44.
    var COMPONENT           = 'trakt';
    var STORAGE_ENABLED     = 'trakt_folder_sync_enabled';
    var STORAGE_LOGGING     = 'trakt_enable_logging';
    var STORAGE_PENDING     = 'trakt_folder_sync_pending';
    var STORAGE_PENDING_TTL = 'trakt_folder_sync_pending_ttl';

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
    //
    // Значение по умолчанию — 15 минут (с запасом). С 0.8.3 значение можно
    // менять в настройках (раздел «Trakt» → «Окно Pending Ops»): 15 мин /
    // 5 мин / 1 мин / 10 сек / Выключено. Полезно для отладки, когда
    // Trakt API отвечает быстро и ждать буфер незачем. Значение 0 полностью
    // отключает буфер: ничего не сохраняется и ничего не накладывается на
    // diff — синхронизация работает «как есть».
    var PENDING_TTL_DEFAULT_SEC = 15 * 60;

    function getPendingTtlSec() {
        var raw = Lampa.Storage.field(STORAGE_PENDING_TTL);
        if (raw == null || raw === '') return PENDING_TTL_DEFAULT_SEC;
        var n = parseInt(raw, 10);
        if (isNaN(n) || n < 0) return PENDING_TTL_DEFAULT_SEC;
        return n;
    }

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
    // По истечении окна (см. getPendingTtlSec) запись протухает сама.

    function loadPendingOps() {
        var ttl = getPendingTtlSec();
        // ttl=0 → буфер выключен пользователем. Чистим хранилище, чтобы
        // протухшие записи из «вчерашнего» режима не накладывались.
        if (ttl === 0) {
            try { Lampa.Storage.set(STORAGE_PENDING, []); } catch (e) {}
            return [];
        }

        var raw;
        try { raw = Lampa.Storage.get(STORAGE_PENDING, '[]'); }
        catch (e) { return []; }
        var arr;
        try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { return []; }
        if (!Array.isArray(arr)) return [];

        var cutoff = Math.floor(Date.now() / 1000) - ttl;
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
        // Буфер выключен — ничего не пишем. Действие пользователя уже улетело
        // в Trakt (write-путь отработал), pending-ops просто не страхует от
        // обратки на ближайшей синхронизации.
        if (getPendingTtlSec() === 0) return;
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

    // Удаляет из Trakt watchlist «двойников» — пары, где один и тот же
    // tmdb id присутствует и как movie, и как show. Это след бага 0.5.x–0.8.3:
    // мы слали /sync/watchlist с id одновременно в movies и shows, рассчитывая
    // что Trakt разрешит ровно одну сущность, — но TMDB id пересекаются между
    // movies и shows (это РАЗНЫЕ namespace, но один и тот же номер часто
    // занят и фильмом, и сериалом), и Trakt добавлял обе.
    //
    // Что удаляем: тип, которого нет в local Lampa book для этого id. Если
    // в Lampa книге нет карточки с этим id вообще — не трогаем (мало ли,
    // пользователь сам в Trakt-вебе добавил оба).
    function cleanupWatchlistDuplicates(rawMovies, rawShows) {
        var movieIds = new Set();
        var showIds  = new Set();
        rawMovies.forEach(function (it) {
            var id = it && it.movie && it.movie.ids && it.movie.ids.tmdb;
            if (id != null) movieIds.add(String(id));
        });
        rawShows.forEach(function (it) {
            var id = it && it.show && it.show.ids && it.show.ids.tmdb;
            if (id != null) showIds.add(String(id));
        });
        var dups = [];
        movieIds.forEach(function (id) { if (showIds.has(id)) dups.push(id); });
        if (!dups.length) return;

        var local = Lampa.Favorite.get({ type: 'book' }) || [];
        var localTypeById = {};
        local.forEach(function (c) {
            var lid = tmdbId(c);
            if (!lid) return;
            localTypeById[lid] = cardIsShow(c) ? 'show' : 'movie';
        });

        dups.forEach(function (id) {
            var localType = localTypeById[id];
            if (!localType) {
                warn('watchlist cleanup: пара movie+show, в Lampa нет — пропуск', { id: id });
                return;
            }
            var unwanted = (localType === 'show') ? 'movie' : 'show';
            var body = (unwanted === 'movie')
                ? { movies: [{ ids: { tmdb: Number(id) } }] }
                : { shows:  [{ ids: { tmdb: Number(id) } }] };
            log('watchlist cleanup: удаляем дубль', { id: id, removeType: unwanted, keepType: localType });
            traktFetch('/sync/watchlist/remove', { method: 'POST', body: body })
                .then(function (resp) {
                    log('watchlist cleanup ok', { id: id, removeType: unwanted, resp: resp });
                })['catch'](function (err) {
                    warn('watchlist cleanup failed', {
                        id: id, removeType: unwanted,
                        status: err && err.status, response: err && err.response
                    });
                });
        });
    }

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
            var rawMovies = Array.isArray(results[0]) ? results[0] : [];
            var rawShows  = Array.isArray(results[1]) ? results[1] : [];
            var rawItems  = rawMovies.concat(rawShows);

            // Чистим наследованные дубли «movie+show с одним tmdb id» (баг
            // 0.5.x–0.8.3, см. buildWatchlistBody): такие пары появлялись,
            // когда мы слали add сразу в обе корзины Trakt, и Trakt находил
            // обе сущности (TMDB id у фильма и сериала независимы, но часто
            // пересекаются по числу). Огонь и забыли — наш собственный dedup
            // по tmdb id маскировал пару в diff'е, и мусор оставался в Trakt
            // навсегда. Вычищаем тип, которого нет в local Lampa book.
            cleanupWatchlistDuplicates(rawMovies, rawShows);

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
    // Write-путь статусных папок реализован ниже (pushHistory): действия
    // пользователя в Lampa транслируются в POST /sync/history[/remove].

    function classifyShow(row) {
        var completed = row.completed || 0;
        var status    = String(row.status || '').toLowerCase();
        if (completed === 0)          return null;        // ни одного просмотра — не статусная
        if (!row.caughtUp)            return 'look';      // есть непросмотренная вышедшая серия
        if (status === 'ended' || status === 'canceled') return 'viewed';
        return 'continued';                               // догнал, ждёт новые серии
    }

    // "Догнан" в терминах Trakt = next_episode == null в /shows/:id/progress/watched.
    // Это ровно тот же сигнал, по которому Trakt UI кладёт / не кладёт сериал
    // в Continue Watching. Сравнение количеств aired/completed и проверка
    // last_episode неверны: last_episode в этом эндпоинте — последняя
    // ПРОСМОТРЕННАЯ пользователем серия, а не последняя вышедшая.
    function isCaughtUp(progress) {
        if (!progress) return false;
        return !progress.next_episode;
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
                        id:          String(show.ids.tmdb),
                        ids:         show.ids,
                        title:       show.title || '',
                        year:        show.year,
                        status:      show.status || '',
                        aired:       progress ? (progress.aired || 0) : 0,
                        completed:   progress ? (progress.completed || 0) : 0,
                        nextEpisode: progress && progress.next_episode,
                        caughtUp:    isCaughtUp(progress)
                    };
                    row.folder = classifyShow(row);
                    log('классификация сериала', {
                        title:              row.title,
                        tmdb:               row.id,
                        progress_aired:     row.aired,
                        progress_completed: row.completed,
                        show_status:        row.status,
                        next_episode:       row.nextEpisode
                            ? 'S' + row.nextEpisode.season + 'E' + row.nextEpisode.number
                            : null,
                        caught_up:          row.caughtUp,
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

    // Накладываем pending ops на желаемое распределение по статусным папкам.
    //
    // Семантика:
    // • pending add в папку X → карточка должна быть ТОЛЬКО в X (убираем
    //   id из остальных статусных папок desired; если X не содержит id —
    //   вставляем минимальный stub, чтобы sync не удалил локальную копию).
    // • pending remove из любой статусной папки → убираем id из всех
    //   статусных папок desired (карточка не должна нигде появиться).
    //
    // Причина: Trakt отдаёт устаревшее состояние 5–15 минут после записи,
    // и без этого классификатор положил бы сериал обратно в ту папку, из
    // которой пользователь только что увёл.
    function applyStatusPendingOps(desired) {
        var pending = loadPendingOps().filter(function (op) {
            return STATUS_FOLDERS.indexOf(op.folder) >= 0;
        });
        if (!pending.length) return;

        pending.forEach(function (op) {
            var id = String(op.id);

            if (op.action === 'add') {
                STATUS_FOLDERS.forEach(function (f) {
                    if (f === op.folder) return;
                    desired[f] = desired[f].filter(function (c) {
                        return String(c.id) !== id;
                    });
                });
                var exists = desired[op.folder].some(function (c) {
                    return String(c.id) === id;
                });
                if (!exists) {
                    var isMovie = op.type === 'movie';
                    desired[op.folder].push({
                        id:        id,
                        ids:       { tmdb: Number(id) },
                        method:    isMovie ? 'movie' : 'tv',
                        card_type: isMovie ? 'movie' : 'tv'
                    });
                }
            }

            if (op.action === 'remove') {
                STATUS_FOLDERS.forEach(function (f) {
                    desired[f] = desired[f].filter(function (c) {
                        return String(c.id) !== id;
                    });
                });
            }
        });

        log('status pending ops применены', { total: pending.length });
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

                applyStatusPendingOps(desired);

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

    // Собираем body для /sync/watchlist[/remove] под уже определённый тип.
    //
    // ВАЖНО: type должен быть 'show' или 'movie'. До 0.8.4 мы слали id
    // одновременно в shows и movies, надеясь, что неподходящий тип уйдёт
    // в not_found. Это неверно: TMDB id 124364 (например) одновременно
    // существует как movie («Dangerous Obsession», 1989) и как show — это
    // разные сущности в разных namespaces TMDB. Trakt находил обе и добавлял
    // обе в watchlist, после чего наш собственный dedup по tmdb id маскировал
    // дубль в local diff'е и мусор оставался в Trakt навсегда.
    function buildWatchlistBody(id, type) {
        if (!id || (type !== 'show' && type !== 'movie')) return null;
        var entry = { ids: { tmdb: Number(id) } };
        return type === 'show'
            ? { shows:  [entry] }
            : { movies: [entry] };
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
    // Ключ — folder+action+id. folder нужен, чтобы различать переход между
    // папками (remove из look + add в viewed — это два разных события, оба
    // должны пройти).
    var _recentWrites = new Map(); // 'book/add:123' → timestampMs

    function checkWriteDedup(action, folder, id) {
        var key  = folder + '/' + action + ':' + id;
        var now  = Date.now();
        var last = _recentWrites.get(key);
        if (last && (now - last) < WRITE_DEDUP_WINDOW_MS) {
            log('write: дубль в окне дедупа, пропуск', { key: key });
            return true;
        }
        _recentWrites.set(key, now);
        // Ленивая GC давних записей.
        _recentWrites.forEach(function (ts, k) {
            if ((now - ts) > WRITE_DEDUP_WINDOW_MS * 4) _recentWrites['delete'](k);
        });
        return false;
    }

    function pushWatchlist(action, card) {
        if (!hasToken()) return;
        var id = tmdbId(card);
        if (!id) { warn('pushWatchlist: нет tmdb id', card); return; }

        if (checkWriteDedup(action, 'book', id)) return;

        // Резолвим тип ДО отправки. resolveCardType сначала смотрит на
        // method/card_type/media_type/number_of_seasons (для нормальных
        // карточек, добавленных через UI Lampa, — мгновенный ответ), и
        // только для тощих случаев идёт в /search/tmdb/:id. Слать в обе
        // корзины (как было в 0.5.x–0.8.3) нельзя: TMDB id может означать
        // и фильм, и сериал одновременно — Trakt тогда добавит обоих.
        var path = action === 'remove' ? '/sync/watchlist/remove' : '/sync/watchlist';
        var guessedType = cardIsShow(card) ? 'show' : 'movie';

        resolveCardType(card).then(function (type) {
            if (type !== 'show' && type !== 'movie') {
                // /search/tmdb не нашёл, и поля карточки ничего не сказали.
                // Fallback на эвристику cardIsShow (как было до 0.5.2 для
                // book) — лучше отправить хоть что-то, чем потерять действие.
                warn('pushWatchlist: тип не определён, fallback на эвристику', {
                    id: id, guessed: guessedType
                });
                type = guessedType;
            }
            var body = buildWatchlistBody(id, type);
            if (!body) { warn('pushWatchlist: пустое body', { id: id, type: type }); return; }

            traktFetch(path, { method: 'POST', body: body })
                .then(function (data) {
                    var actualType = resolveTypeFromTraktResp(data, action) || type;
                    var bucket = data && data[action === 'remove' ? 'deleted' : 'added'];
                    var changed = bucket && ((bucket.movies || 0) > 0 || (bucket.shows || 0) > 0);
                    if (!changed) {
                        // Для add: «existing» = уже было в Trakt — ок.
                        var existing = data && data.existing;
                        if (action === 'add' && existing &&
                            ((existing.movies || 0) > 0 || (existing.shows || 0) > 0)) {
                            log('watchlist add — уже было в Trakt', { id: id, type: actualType });
                        } else {
                            warn('watchlist ' + action + ' — Trakt не распознал id', {
                                id: id, type: type, resp: data
                            });
                            return;
                        }
                    }
                    log('watchlist ' + action + ' ok', {
                        id: id, type: actualType, guessed: guessedType, resp: data
                    });
                    addPendingOp({
                        id:     id,
                        type:   actualType,
                        folder: 'book',
                        action: action
                    });
                })['catch'](function (err) {
                    warn('watchlist ' + action + ' failed', {
                        id: id, type: type, guessed: guessedType,
                        status: err && err.status, response: err && err.response
                    });
                });
        });
    }

    // -----------------------------------------------------------------------
    // Write-путь для статусных папок: /sync/history[/remove]
    // -----------------------------------------------------------------------
    //
    // SPEC.md § «Ручные действия пользователя».
    //
    // Для фильма viewed — прямолинейно: POST с { movies: [...] }.
    //
    // Для сериала viewed — нам нужно отметить ВСЕ вышедшие эпизоды. Берём
    // их из /shows/:id/progress/watched и складываем в body одним запросом
    // (Trakt принимает массив сезонов с массивами эпизодов внутри одного
    // /sync/history). Это одно обращение к серверу, а не N по эпизодам.
    //
    // Для look на сериале — «подсказка Trakt'у»: отмечаем просмотренной
    // только S01E01, чтобы completed стал > 0 и next_episode указал на
    // S01E02. Классификатор получит look. Остальные эпизоды не трогаем —
    // они остаются в том состоянии, что были (например, если пользователь
    // уже смотрел часть через scrobble, ничего не теряется).
    //
    // look на фильме и continued на чём угодно — действия, которые нельзя
    // выразить через Trakt API. Игнорируем с логом; карточка либо откатится
    // на следующей синхронизации (если это продукт перемещения), либо так
    // и останется локально (что нежелательно, но безвредно).

    // Если у карточки есть trakt id — используем его; иначе резолвим через
    // /search/tmdb. Нужно для /shows/:id/progress/watched: этот эндпоинт
    // принимает trakt id / trakt slug / imdb id, но НЕ tmdb id.
    function resolveShowKeyForProgress(card) {
        if (card && card.ids && card.ids.trakt)  return Promise.resolve(card.ids.trakt);
        if (card && card.ids && card.ids.imdb)   return Promise.resolve(card.ids.imdb);
        var id = tmdbId(card);
        if (!id) return Promise.resolve(null);
        return traktFetch('/search/tmdb/' + id + '?type=show')
            .then(function (results) {
                if (!Array.isArray(results) || !results.length) return null;
                var hit = results.find(function (r) {
                    return r && r.show && r.show.ids && r.show.ids.trakt;
                });
                return hit ? hit.show.ids.trakt : null;
            })
            ['catch'](function (err) {
                warn('search tmdb failed', { tmdb: id, err: err && err.message });
                return null;
            });
    }

    // Возвращает 'show' | 'movie' | null. Сперва смотрим явные поля карточки;
    // если их нет (тощая карточка от парного события Lampa — см. v0.5.2 для
    // такого же бага в book) — спрашиваем Trakt. Эвристика «нет признаков
    // сериала → значит фильм» неверна: Lampa иногда отдаёт в листенер карточку
    // без method/card_type/number_of_seasons — см. лог, где Breaking Bad
    // (сериал, tmdb 1396) пришёл без всякой типизации и был принят за фильм.
    function resolveCardType(card) {
        if (!card) return Promise.resolve(null);

        var m = card.method || card.card_type || card.media_type;
        if (m === 'tv')    return Promise.resolve('show');
        if (m === 'movie') return Promise.resolve('movie');
        if (card.number_of_seasons != null) return Promise.resolve('show');

        var id = tmdbId(card);
        if (!id) return Promise.resolve(null);

        return traktFetch('/search/tmdb/' + id)
            .then(function (results) {
                if (!Array.isArray(results) || !results.length) return null;
                // Если tmdb id совпадает и с шоу, и с фильмом (редко, но бывает),
                // отдаём приоритет show — в Lampa статусные папки в подавляющем
                // большинстве случаев оперируют сериалами.
                if (results.some(function (r) { return r && r.type === 'show'; }))  return 'show';
                if (results.some(function (r) { return r && r.type === 'movie'; })) return 'movie';
                return null;
            })
            ['catch'](function (err) {
                warn('resolveCardType search failed', { tmdb: id, err: err && err.message });
                return null;
            });
    }

    function postHistoryMovie(action, id) {
        var body = { movies: [{ ids: { tmdb: Number(id) } }] };
        var path = action === 'remove' ? '/sync/history/remove' : '/sync/history';
        return traktFetch(path, { method: 'POST', body: body })
            .then(function (resp) {
                log('history ' + action + ' (movie) ok', { id: id, resp: resp });
                addPendingOp({ id: id, type: 'movie', folder: 'viewed', action: action });
            })['catch'](function (err) {
                warn('history ' + action + ' (movie) failed', {
                    id: id, status: err && err.status, response: err && err.response
                });
            });
    }

    function postHistoryMarkFirst(id) {
        // Одна POST /sync/history, где сериал задан через tmdb id + указан
        // конкретный эпизод S01E01. Trakt примет без фетча progress'а.
        var body = {
            shows: [{
                ids: { tmdb: Number(id) },
                seasons: [{ number: 1, episodes: [{ number: 1 }] }]
            }]
        };
        return traktFetch('/sync/history', { method: 'POST', body: body })
            .then(function (resp) {
                log('history add (look-start S01E01) ok', { id: id, resp: resp });
                addPendingOp({ id: id, type: 'show', folder: 'look', action: 'add' });
            })['catch'](function (err) {
                warn('history add (look-start) failed', {
                    id: id, status: err && err.status, response: err && err.response
                });
            });
    }

    function postHistoryUnmarkFirst(id) {
        // Зеркало postHistoryMarkFirst: снимает именно тот S01E01, который мы
        // поставили в качестве подсказки Trakt'у при add в look. Реальную
        // пользовательскую историю за пределами S01E01 не трогаем — если она
        // есть, классификатор оставит сериал в look/viewed как положено.
        var body = {
            shows: [{
                ids: { tmdb: Number(id) },
                seasons: [{ number: 1, episodes: [{ number: 1 }] }]
            }]
        };
        return traktFetch('/sync/history/remove', { method: 'POST', body: body })
            .then(function (resp) {
                log('history remove (look-start S01E01) ok', { id: id, resp: resp });
                addPendingOp({ id: id, type: 'show', folder: 'look', action: 'remove' });
            })['catch'](function (err) {
                warn('history remove (look-start) failed', {
                    id: id, status: err && err.status, response: err && err.response
                });
            });
    }

    function postHistoryAllAired(action, card, id) {
        return resolveShowKeyForProgress(card).then(function (showKey) {
            if (!showKey) {
                warn('history ' + action + ' (show): не удалось резолвить trakt/imdb id', {
                    tmdb: id
                });
                return;
            }
            return fetchShowProgress(showKey).then(function (progress) {
                if (!progress || !Array.isArray(progress.seasons)) {
                    warn('history ' + action + ' (show): нет progress.seasons', {
                        tmdb: id, showKey: showKey
                    });
                    return;
                }
                var seasons = progress.seasons.map(function (s) {
                    return {
                        number: s.number,
                        episodes: (s.episodes || []).map(function (e) {
                            return { number: e.number };
                        })
                    };
                }).filter(function (s) { return s.episodes.length > 0; });

                if (!seasons.length) {
                    warn('history ' + action + ' (show): ни одной вышедшей серии', {
                        tmdb: id, showKey: showKey
                    });
                    return;
                }

                var body = {
                    shows: [{
                        ids: { tmdb: Number(id) },
                        seasons: seasons
                    }]
                };
                var epsCount = seasons.reduce(function (acc, s) {
                    return acc + s.episodes.length;
                }, 0);
                var path = action === 'remove' ? '/sync/history/remove' : '/sync/history';
                return traktFetch(path, { method: 'POST', body: body })
                    .then(function (resp) {
                        log('history ' + action + ' (show all-aired) ok', {
                            tmdb: id, episodes: epsCount, resp: resp
                        });
                        addPendingOp({
                            id: id, type: 'show', folder: 'viewed', action: action
                        });
                    })['catch'](function (err) {
                        warn('history ' + action + ' (show all-aired) failed', {
                            tmdb: id, status: err && err.status, response: err && err.response
                        });
                    });
            });
        });
    }

    function pushHistory(folder, action, card) {
        if (!hasToken()) return;
        var id = tmdbId(card);
        if (!id) { warn('pushHistory: нет tmdb id', card); return; }
        if (checkWriteDedup(action, folder, id)) return;

        if (folder === 'continued') {
            // continued — производная «догнан + выходит». Пользователь
            // не может её проставить напрямую: нет действия, которое бы это
            // сделало (mark as watched отправило бы в viewed или continued
            // в зависимости от статуса сериала — это уже покрыто viewed-путём).
            log('continued — производная папка, игнорируем действие',
                { id: id, action: action });
            return;
        }

        if (folder === 'look') {
            // look в Trakt-модели существует только для сериалов. Тип карточки
            // НЕ проверяем: Lampa в листенер часто отдаёт тощую карточку, где
            // ни method, ни card_type, ни number_of_seasons не выставлены
            // (см. лог 2026-04-25 — Breaking Bad tmdb=1396 пришёл без типизации
            // и был принят за фильм). Постим S01E01 безусловно — если тмдб id
            // принадлежит фильму, Trakt просто ничего не сделает с seasons.
            //
            // add: помечаем S01E01 как просмотренный (completed>0, next_episode
            // указывает на S01E02, классификатор выдаёт look).
            // remove: зеркально снимаем S01E01. Если у пользователя реальная
            // история за пределами S01E01 — классификатор оставит сериал
            // там, где ему место (look/viewed/continued), и это корректно:
            // наше действие обратимо только в части нашей же подсказки.
            if (action === 'add')    postHistoryMarkFirst(id);
            else                     postHistoryUnmarkFirst(id);
            return;
        }

        if (folder === 'viewed') {
            // Резолвим тип через Trakt, а не по полям карточки: тощая карточка
            // от Lampa тоже актуальна тут (см. коммент выше про look).
            resolveCardType(card).then(function (type) {
                if (type === 'show')  { postHistoryAllAired(action, card, id); return; }
                if (type === 'movie') { postHistoryMovie(action, id);           return; }
                warn('pushHistory viewed: не удалось определить тип карточки',
                    { id: id, action: action });
            });
            return;
        }
    }

    function initFavoriteListener() {
        if (!Lampa.Favorite || !Lampa.Favorite.listener ||
            typeof Lampa.Favorite.listener.follow !== 'function') {
            warn('initFavoriteListener: Lampa.Favorite.listener недоступен');
            return;
        }

        Lampa.Favorite.listener.follow('add', function (e) {
            if (!e || !e.where || !e.card) return;
            var id = tmdbId(e.card);
            if (consumeOwn(id)) {
                log('Favorite.add — пропуск своей же операции',
                    { id: id, where: e.where });
                return;
            }
            if (!isEnabled()) return;
            if (e.where === 'book') {
                log('Favorite.add пользователем → Trakt', { id: id, where: e.where });
                pushWatchlist('add', e.card);
                return;
            }
            if (STATUS_FOLDERS.indexOf(e.where) >= 0) {
                log('Favorite.add пользователем → Trakt',
                    { id: id, where: e.where });
                pushHistory(e.where, 'add', e.card);
            }
        });

        Lampa.Favorite.listener.follow('remove', function (e) {
            if (!e || !e.where || !e.card) return;
            var id = tmdbId(e.card);
            if (consumeOwn(id)) {
                log('Favorite.remove — пропуск своей же операции',
                    { id: id, where: e.where });
                return;
            }
            if (!isEnabled()) return;
            if (e.where === 'book') {
                log('Favorite.remove пользователем → Trakt',
                    { id: id, where: e.where });
                pushWatchlist('remove', e.card);
                return;
            }
            if (STATUS_FOLDERS.indexOf(e.where) >= 0) {
                log('Favorite.remove пользователем → Trakt',
                    { id: id, where: e.where });
                pushHistory(e.where, 'remove', e.card);
            }
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
        } catch (e) {
            warn('addSettings: addParam (enabled) ошибка', e);
        }

        // Окно Pending Ops. Значения — строки секунд (Lampa Storage.field
        // возвращает их как есть). Дефолт 900 = 15 мин — соответствует
        // PENDING_TTL_DEFAULT_SEC. Значение '0' = буфер выключен.
        try {
            Lampa.SettingsApi.addParam({
                component: COMPONENT,
                param: {
                    name: STORAGE_PENDING_TTL,
                    type: 'select',
                    values: {
                        '900': '15 минут (по умолчанию)',
                        '300': '5 минут',
                        '60':  '1 минута',
                        '10':  '10 секунд',
                        '0':   'Выключено'
                    },
                    'default': '900'
                },
                field: {
                    name: 'Окно Pending Ops',
                    description: 'Сколько секунд защищать только что изменённые карточки от отката синхронизацией. Меньше — быстрее тестировать. «Выключено» полностью отключает буфер.'
                }
            });
            log('addSettings: ок');
        } catch (e) {
            warn('addSettings: addParam (pending_ttl) ошибка', e);
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
