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
| `index.html` | Header, login window (`#loginBox`), filter toggles (`#filter-bar`), recommendations container and script loading |
| `style.css` | Dark theme, responsive card grid (≤ 768 px and ≤ 480 px) |
| `script.js` | Login, filter state (type/scope), collecting played/unplayed/all items, rendering the cards |
| `findSimilar.js` | Similarity and taste algorithms, type filter, anchor/candidate state |
| `tmdb.js` | External ("new to your library") recommendations via the TMDB API |
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
     └─ onLibraryLoad
         ├─ updateTestesSugestions(true)           "Based on Your General Watched Content" section
         ├─ updateRecommendations()                "Because you watched" section (3 anchors × 6 items)
         └─ updateNewContent()                     "New to your library" section (only when enabled)
```

Filter toggles (`#filter-bar`, visible after login, persisted in `localStorage` as `recommender.type` /
`recommender.scope`):

- **Type** — `Movie` (Movies) or `Series` (Shows): applied with `filterByContentType` when the lists are built
  (`getList`), not at load time (shared library cache).
- **Scope** — `watched` (default): played items as anchors, unplayed as candidates; `all`: the whole library as
  both anchors and candidates (`findSimilar(…, includePlayed = true)` keeps already watched candidates, and the
  section titles become "Similar to …" / "Based on Your Whole Library").
- **New to library** — `off` (default) / `on`: with `on` and a TMDB API key set, an extra section
  (`#new-content-container`) shows recommendations **outside** the library (see §5b), followed by an
  "In your library" divider (`#new-content-divider`, visible only while the toggle is on) that separates
  it from the in-library sections below.

Changing a toggle (or the TMDB key) calls `refreshRecommendations()`: resets the anchor/candidate state
(`resetRecommendationState`), clears the cached lists and the sections, then recomputes them.

The **Shuffle** button (`#shuffleBtn`, in the filter bar) does the same, so `selectRandomContents` picks
different anchors — for the in-library "Because you watched" groups and the external "New to library" ones
alike. It is disabled while a recompute is running (`[inactive]`).

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

1. Anchors: up to `ContentsToCheck` items of the selected type from the base list (picked with
   `selectRandomContents`). Their TMDB id comes from `ProviderIds.Tmdb`; when an anchor has none (old cache,
   Meilisearch load), it is resolved with a TMDB `/search/{movie|tv}` by title (+ production year), cached per
   anchor (`resolveAnchorTmdbId`).
2. For each anchor, TMDB `/{movie|tv}/{tmdbId}/similar` and `/recommendations`, pages 1–3 (`TMDB_PAGES`), are
   fetched (`tmdb.js`, `api_key` = the user's own v3 key from `localStorage.tmdbApiKey`; TMDB allows CORS from
   the browser). More pages because page 1 is often full of titles the library already has. Genre ids are
   translated to names with `/genre/{movie|tv}/list` (cached per type).
3. Candidates already in the library are dropped: by TMDB id (`buildLibraryTmdbIds`) **and** by normalized
   title + production year (`buildLibraryTitleIndex` / `isInLibrary`), so library items without a `Tmdb`
   provider id still exclude their title. Same title with a distant year is a remake — a different TMDB item —
   and is kept. Duplicates across endpoints/pages/anchors are removed.
4. The rest is ranked with the same `calculateSimilarity` + `> 15` threshold as in-library recommendations
   (`rankExternalCandidates`) and shown per anchor in `#new-content-container`. Cards carry `ExternalUrl`
   (the TMDB page) instead of a Jellyfin details link. To add such an item, search its title in Jellyfin.
5. `getExternalRecommendations` also returns `stats` (anchors, anchors with a TMDB id, fetched, excluded,
   groups); an empty result shows the concrete reason in the section ("already in your library", "could not be
   matched on TMDB", …) and the counts are logged to the console. The key format is checked up front
   (`tmdbKeyLooksValid`: 32 hex chars — the v4 Read Access Token is a JWT and does not work as `api_key=`).

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
| New-to-library toggle | `filterState.newContent`, `localStorage` key `recommender.newContent` (default `off`) |
| TMDB API key (external recommendations) | `localStorage` key `tmdbApiKey`, field `#tmdbApiKey` |

## 7. Storage

| Where | Key | Content |
|---|---|---|
| `localStorage` | `server` | Server address |
| `localStorage` | `recommender.type` / `recommender.scope` / `recommender.newContent` | Filter toggles (Movies/Shows, Watched only/Whole library, New to library) |
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
