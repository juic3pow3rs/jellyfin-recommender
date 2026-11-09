# Content Recommender — Technical documentation

> Written from the source code (revision `e397ccb`, updated with the 2026-10-23 fixes). Problems and suggested fixes
> are in [`AUDIT.md`](AUDIT.md).

## 1. Overview

A static page that connects to a **Jellyfin** server, splits what the user has already played from what they have not
and shows recommendations in two sections:

1. **"Based on Your General Watched Content"** — an aggregated taste profile (genres/tags) applied to the whole unplayed
   catalog; **Load More** button.
2. **"Because you watched X"** — for a few played titles picked at random, the most similar unplayed items; more groups
   appear with infinite *scroll*.

Published at `https://jeffersoncgo.github.io/content-recommender/`. No build, no backend.

## 2. Files

| File | Role |
|---|---|
| `index.html` | Header, login window (`#loginBox`), page nav (`#pageNav`), the four pages (`.page`), filter toggles (`#filter-bar`) and script loading |
| `style.css` | Dark theme, responsive card grid (≤ 768 px and ≤ 480 px) |
| `script.js` | Login, pages (`switchPage`/`loadCurrentPage`), filter state (type/scope/source), collecting items, rendering the cards |
| `findSimilar.js` | Similarity and taste algorithms, type filter, anchor/candidate state |
| `tmdb.js` | TMDB API client: "new to your library" recommendations, missing seasons/sequels, favorite people, upcoming releases (throttled) |
| `script_infinity_scroll.js` | Fetches more "Because you watched" groups when nearing the end of the page (one batch at a time) |
| `js/vendor/` | Copies of the dependencies (below) |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Serve the static app with nginx (port 8080) |

### Dependencies (copies in `js/vendor/`, since 2026-10-23)

```
js/vendor/common.js        ← jeffersoncgo/cdn        js/common.js         utils, String/Array extensions
js/vendor/base.js          ← jeffersoncgo/cdn        js/base.js           JCGWeb
js/vendor/object.js        ← jeffersoncgo/cdn        js/object.js         searchInArray (used by the Jellyfin client)
js/vendor/controller.js    ← jeffersoncgo/cdn        js/controller.js     Controller (searchItems debounce)
js/vendor/observer.js      ← jeffersoncgo/cdn        js/observer.js       Observer (used by pageMemory)
js/vendor/pagememory.js    ← jeffersoncgo/cdn        js/pagememory.js     persistence of the [save] fields
js/vendor/windowsHandle.js ← jeffersoncgo/CoverMaker js/windowsHandle.js  showWindow/hideWindow
js/vendor/fetchqueue.js    ← jeffersoncgo/cdn        js/fetchqueue.js     FetchQueue
js/vendor/jellyfin.js      ← jeffersoncgo/CoverMaker js/jellyfin.js       Jellyfin class (login, API, IndexedDB cache, Meilisearch)
js/vendor/search.js        ← jeffersoncgo/cdn        js/search.js         SearchEngine (taste recommendation, strict mode)
https://cdnjs.cloudflare.com/.../font-awesome/6.7.2    icons (with SRI)
```

They used to be loaded live from the other repositories' GitHub Pages: any push there changed (and could break) this
app without warning (`CR-05`). Now updating is a conscious step: when one of these files changes at its source, copy it
to `js/vendor/` with the same content and run this app's tests (see the checklist in `CoverMaker/docs/FIX-PLAN.md`).

## 3. Flow

```
page load
 ├─ loadFieldsFromStorage()                       server (+ username/password only from old versions, used once)
 └─ DOMContentLoaded
     ├─ saved session (Jellyfin.getSavedAuth) or old credentials? → InitializeJellyfin() │ otherwise → shows #loginBox
     └─ new pageMemory().init()                    restores the [save] fields

InitializeJellyfin(explicitLogin)                  explicitLogin = Connect button
 └─ new Jellyfin(server, user, pass, events, true, { preferCredentials: explicitLogin })
     │                                             (CoverMaker's class: token or password login, getLibraries, cache)
     ├─ onLoginSuccess → forgetSavedPassword()     deletes the old username/password; shows "Sign out" and #filter-bar
     └─ Sign out → jellyfin.logout() + reload      POST /Sessions/Logout, deletes the saved session
     └─ onLibraryLoad → loadCurrentPage()            loads the active page (§3a)
```

### 3a. Pages (views)

`#pageNav` switches between four `.page` sections (persisted as `localStorage.recommender.page`):

| Page | Container | Content | Toggles shown |
|---|---|---|---|
| `recommendations` | `#recommendations-container` | source `library`: taste section + "Because you watched" groups; source `new`: "New to your library" groups (TMDB) | Type, Base (scope), Source, TMDB key, Shuffle |
| `completeness` | `#completeness-container` | Shows: missing/upcoming seasons; Movies: missing collection parts | Type, TMDB key |
| `people` | `#people-container` | More works of favorite actors/directors | Type, TMDB key |
| `upcoming` | `#upcoming-container` | Future-dated releases feed | Type, TMDB key |

`switchPage(page)` shows/hides the `.page` sections and the `data-group` filter-bar groups, then
`loadCurrentPage()` recomputes the active page. Changing a toggle (or Shuffle / the TMDB key) calls
`refreshRecommendations()`, which resets the anchor/candidate state, clears all page containers and reloads
the current page. Pages 2–4 always use the whole library (`getList(null, 'All', null)` + `filterByContentType`)
and need the TMDB key; without/invalid key they show a hint (`tmdbKeyOrHint`).

Filter toggles (`#filter-bar`, visible after login, persisted in `localStorage` as `recommender.type` /
`recommender.scope`):

- **Type** — `Movie` (Movies) or `Series` (Shows): applied with `filterByContentType` when the lists are built
  (`getList`), not at load time (shared library cache).
- **Scope** — `watched` (default): played items as anchors, unplayed as candidates; `all`: the whole library as
  both anchors and candidates (`findSimilar(…, includePlayed = true)` keeps already watched candidates, and the
  section titles become "Similar to …" / "Based on Your Whole Library").
- **Source** — `library` (default) / `new`: on the Recommendations page, `library` shows the in-library
  taste + "Because you watched" sections; `new` shows `#new-content-container` with TMDB recommendations
  **outside** the library (§5b). (Migrated from the old `recommender.newContent` on/off key.)

Changing a toggle (or the TMDB key) calls `refreshRecommendations()`: resets the anchor/candidate state
(`resetRecommendationState`), clears the cached lists and the page containers, then reloads the current page.

The **Shuffle** button (`#shuffleBtn`, recommendations page) does the same, so `selectRandomContents` picks
different anchors. It is disabled while a recompute is running (`[inactive]`).

`getList(…, 'Played'|'Unplayed'|'All')` sets `searchParams.PlayedOnly/UnplayedOnly` (`'All'` clears both),

`getList(…, 'Played'|'Unplayed')` sets `searchParams.PlayedOnly/UnplayedOnly`, `limit = 999999` and calls
`jellyfin.searchItems('', '', {})`, which joins the items of every loaded library and filters with
`jellyfin.isPlayed(item)` (`UserData.Played`, `PlayCount > 0` or `PlayedPercentage ≥ 70`; never for collections).

Each card opens `${Server.ExternalAddress}/web/#/details?id=<Id>&serverId=<ServerId>` in a new tab
(click, Enter or Space).

## 4. "Because you watched" algorithm (`findSimilar`)

`findSimilar(played, unplayed, anchorCount = 10, perAnchor = 7, useSingleAppearance = true, includePlayed = false)`

1. Removes from the unplayed list the items that have `UserData.Played` (kept when `includePlayed` is set, i.e. the
   "Whole library" scope).
2. **Rarity** of each genre/tag across the whole catalog: `log((N + 1) / (freq + 1))` (IDF style).
3. Draws a played anchor not used yet (`usedWatchedIds`, global across calls) and scores each candidate:

| Component | Computation | Weight (`WEIGHTS`) |
|---|---|---|
| Genres | Rarity-weighted Jaccard: `Σ rarity(shared) / Σ rarity(union)` | `GENRE = 4` |
| Tags | same | `TAG = 4` |
| Community rating | `max(0, 1 − |Δ| / 10)` (only if both have a rating) | `COMMUNITY_RATING = 3` |
| Year | `max(0, 1 − |Δ| / 80)` (only if both have a year) | `PRODUCTION_YEAR = 2` |
| Title words | `|shared| / max(|A|, |B|)` (Unicode letter/number tokens, accents removed, without "the/part/season/episode") | `NAME = 3` |
| Title prefix | +weight if one title starts with the other | `START_WITH = 6` |

   `score = Σ(component × weight) / Σ(applicable weights) × 100`. Candidates with `score > 15` stay, sorted, up to
   `perAnchor`. `CRITIC_RATING`, `ACTOR`, `DIRECTOR_WRITER` and `STUDIO` are declared but **not used**.
4. With `useSingleAppearance = true`, a recommended item does not show up again for another anchor (`usedUnwatchedIds`).
5. Repeats until it has `anchorCount` groups or runs out of attempts (`2 × played`).

Output: `[{ Name, Id, Recommendations: [{ Name, Id, Genres, CommunityRating, ProductionYear, similarityScore, ImageUrl }] }]`.

## 5. "By taste" algorithm (`getTasteBasedContentfindSimilar`)

**Taste profile** (`buildTasteProfile`): the share of each genre and tag among the played items.

**Score** (`computeTasteSimilarity`):

```
genreScore = Σ share(item genre)
tagScore   = Σ share(item tag) × 1.25
penalty    = 0.85 ^ (genreCount − 4)   if the item has more than 4 genres, otherwise 1
score      = min(1, (0.65 × genreScore + 0.35 × tagScore) × penalty) × 100
```

- **Non-strict mode**: scores the whole unplayed catalog and returns the best `limit` ones (the full list also goes to
  `window.recommendations`, for **Load More**).
- **Strict mode** (used by the app): builds search queries from the played items
  (`extractSearchProfileFromWatched`: the 7 most frequent genres and 7 tags with the `all` operator, average year ± 5,
  rating > `max(average − 0.5, 6)`), filters the played items with `SearchEngine`, recomputes the profile on that
  subset, filters the unplayed items with the new queries and sorts by the score above. The full result goes to
  `window.recommendations` and the **Load More** button shows 6 more per click.
- In practice (`CR-06`, kept on purpose): the search runs in *lax* mode (adds points per query); `all` with 7 genres
  almost never matches and `between` is not a `SearchEngine` operator (it uses `..`), so **only the minimum rating
  filters**. Fixing this changes the recommendations — it is left for the user to decide, testing on the real library.
- Recommended types: the Movies/Shows toggle selects `Movie` or `Series` (both in `RECOMMENDABLE_TYPES` in
  `script.js`, which validates the saved choice). The filter is applied when the lists are built
  (`filterByContentType` in `findSimilar.js`), not at load time: the library cache is shared with CoverMaker, and
  loading fewer types here would make each app reload the other's cache on every visit.
- The "played" status is refreshed on every load (`needsUserData = true`), even with the library coming from the cache.

### 5b. External recommendations (`tmdb.js`, "New to your library")

For extending the library: items **not** in Jellyfin yet, fetched from TMDB (the provider Jellyfin itself uses).

1. Anchors: up to `NEW_CONTENT_ANCHORS = 12` items of the selected type from the base list (picked with
   `selectRandomContents`), i.e. up to ~12 rows of `similarsToShow` cards — the in-library taste section above
   stays first. Their TMDB id comes from `ProviderIds.Tmdb`; when an anchor has none (old cache,
   Meilisearch load), it is resolved with a TMDB `/search/{movie|tv}` by title (+ production year), cached per
   anchor (`resolveAnchorTmdbId`).
2. For each anchor, TMDB `/{movie|tv}/{tmdbId}/similar` and `/recommendations`, pages 1–3 (`TMDB_PAGES`), are
   fetched (`tmdb.js`, `api_key` = the user's own v3 key from `localStorage.tmdbApiKey`; TMDB allows CORS from
   the browser). More pages because page 1 is often full of titles the library already has. Genre ids are
   translated to names with `/genre/{movie|tv}/list` (cached per type).
   **Rate limits** ([developer.themoviedb.org/docs/rate-limiting](https://developer.themoviedb.org/docs/rate-limiting)):
   the legacy 40 req/10 s limit is disabled; a CDN ceiling of ~40–50 req/s per IP remains. `tmdbFetch` keeps a
   sliding window of at most `TMDB_MAX_REQ_PER_SEC = 40` requests/second and, on HTTP 429, waits 2 s and retries
   once. 12 anchors × 6 requests ≈ 72 requests ≈ ~2 s. Per the
   [API terms of use](https://www.themoviedb.org/api-terms-of-use) (non-commercial use requires attribution),
   the footer shows "This product uses the TMDB API but is not endorsed or certified by TMDB."

### 5c. Pages 2–4 data sources (`tmdb.js`)

All TMDB ids are resolved through `resolveAnchorTmdbId` (`ProviderIds.Tmdb`, else a `/search/{movie|tv}` by
title + year, cached per item) — so items from an old cache or a Meilisearch load still work. Everything goes
through the throttled `tmdbFetch` (≤ `TMDB_MAX_REQ_PER_SEC = 40` req/s, 429 → wait + one retry).

- **Completeness — shows** (`getMissingSeasons`): one raw Jellyfin call
  (`/Users/{userId}/Items?IncludeItemTypes=Season&Recursive=true`, `getOwnedSeasonsBySeries` in `script.js`)
  maps series id → owned season numbers. Per library series (max `UPCOMING_MAX_SERIES = 40`), TMDB
  `/tv/{id}` lists all seasons (season 0 "Specials" ignored); seasons not owned become cards
  "Show — Season N" with note "aired/released <date>" / "releases <date>", linking to the TMDB season page.
- **Completeness — movies** (`getMissingSequels`): per library movie (max `UPCOMING_MAX_MOVIES = 20`), TMDB
  `/movie/{id}` → `belongs_to_collection` → `/collection/{id}` parts; parts already in the library
  (`isInLibrary`: TMDB id or title+year) are dropped, the rest become "Collection: Title" cards with a
  released/releases date note. (Standalone sequels outside a TMDB collection cannot be detected.)
- **Actors & directors** (`getFavoritePeopleWorks`): credits of up to `UPCOMING_MAX_CREDIT_ANCHORS = 8`
  watched items of the type are aggregated → top `UPCOMING_MAX_ACTORS = 5` actors + `UPCOMING_MAX_DIRECTORS = 3`
  directors → `/person/{id}/combined_credits`, filtered to the selected type and against the library, noted
  "with/by <name> · released/releases <date>", ranked by rating/popularity (12 cards each).
- **Upcoming** (`getUpcomingReleases`): missing seasons/sequels of the type + people works, filtered to
  future `ReleaseDate`, sorted by date (max 24).

Cards show the note line under the year (`createContentCard` renders `Content.note`).

## 6. Configuration

| What | Where |
|---|---|
| Similarity weights | `WEIGHTS` in `findSimilar.js` |
| Maximum year difference considered | `MAX_YEAR_DIFF = 80` |
| Minimum threshold | `similarityScore > 15` in `findSimilarForOne` |
| Anchors and items per anchor | `ContentsToCheck = 3`, `similarsToShow = 6` in `script.js` |
| Items per Load More click | `similarsToShow` |
| Default image | `noImage` (placehold.co) |
| Card image size | `POSTER_WIDTH × POSTER_HEIGHT = 360 × 540` (portrait, 2× the card), quality 80, in `findSimilar.js` |
| Type toggle (Movies/Shows) | `filterState.type`, `localStorage` key `recommender.type` (default `Movie`) |
| Scope toggle (Watched only/Whole library) | `filterState.scope`, `localStorage` key `recommender.scope` (default `watched`) |
| Source toggle (In library / New TMDB) | `filterState.source`, `localStorage` key `recommender.source` (default `library`; migrated from `recommender.newContent`) |
| Active page | `currentPage`, `localStorage` key `recommender.page` |
| External anchors (New TMDB source) | `NEW_CONTENT_ANCHORS = 12` in `script.js` |
| TMDB API key (external recommendations) | `localStorage` key `tmdbApiKey`, field `#tmdbApiKey` |

## 7. Storage

| Where | Key | Content |
|---|---|---|
| `localStorage` | `server` | Server address |
| `localStorage` | `recommender.type` / `recommender.scope` / `recommender.source` / `recommender.page` | Type/scope/source toggles and the active page |
| `localStorage` | `tmdbApiKey` | TMDB API key for external recommendations (sent only to `api.themoviedb.org`) |
| `localStorage` | `jellyfinAuth` | Session `{ server, serverId, userId, token }` (`Jellyfin` class; never the password) |
| `localStorage` | `username`, `password` | Only from old versions: used once to get the token, then deleted |
| IndexedDB `pageMemoryDB` | Page URL | `[save]` fields (only the server; username and password are no longer saved) |
| IndexedDB `<Server.Id>` | `Tags`, `Genres`, `Studios`, `<libraryId>` | Library cache (`Jellyfin` class) |

Since CoverMaker and this app are on the same origin (`jeffersoncgo.github.io`), this data is **shared** between them.
**Clean Saved Memory** asks for confirmation, resets the page memory (`memory.reset()`) and calls `jellyfin.cleanDb()`
(deletes the Jellyfin cache and reloads); it also works before logging in.

## 8. Tests

`node --test "tests/*.test.js"` (Node 20+): syntax, dependencies in `js/vendor/` present and loaded by `index.html`,
the filter toggles and the Docker files in `index.html`/repo, tokenizer, shuffle, type filter, the
`includePlayed` behavior of `findSimilar`, and the `tmdb.js` helpers (normalization, library-id exclusion,
ranking) with a mocked `fetch`. With `cdn` and `CoverMaker` cloned next to it, it also checks that the
copies are identical to the originals. Runs in CI on every push (`.github/workflows/tests.yml`). Browser tests:
`CoverMaker/tests/browser/cr_auth.js`.

## 9. Running locally

```bash
git clone https://github.com/jeffersoncgo/content-recommender.git
cd content-recommender
python3 -m http.server 8080    # open http://localhost:8080/
```

Or with Docker (nginx serving the static files, published on port 8080):

```bash
docker compose up --build
# or: docker build -t jellyfin-recommender . && docker run -p 8080:80 jellyfin-recommender
```

The browser must reach Jellyfin directly (same network/VPN) and the server must allow CORS for the app's origin
(e.g. `http://localhost:8080` in Dashboard → Networking → CORS hosts).
