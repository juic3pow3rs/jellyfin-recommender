// Checks that need no browser. Run from the repository root: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VENDOR = ['common.js', 'base.js', 'object.js', 'controller.js', 'observer.js', 'pagememory.js', 'windowsHandle.js', 'fetchqueue.js', 'jellyfin.js', 'search.js'];

test('every script parses, and every vendored dependency is present', () => {
  for (const rel of ['script.js', 'findSimilar.js', 'tmdb.js', 'script_infinity_scroll.js', ...VENDOR.map(f => `js/vendor/${f}`)]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
    assert.doesNotThrow(() => new vm.Script(read(rel), { filename: rel }), rel);
  }
});

test('index.html loads the vendored copies, not the live sites of the other repositories (CR-05)', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /src="https:\/\/jeffersoncgo\.github\.io\//);
  for (const f of VENDOR) assert.match(html, new RegExp(`src="js/vendor/${f.replace('.', '\\.')}"`), f);
});

test('index.html has the filter toggles and the external-recommendation controls', () => {
  const html = read('index.html');
  assert.match(html, /id="filter-bar"/);
  for (const v of ['data-type="Movie"', 'data-type="Series"', 'data-scope="watched"', 'data-scope="all"', 'data-source="library"', 'data-source="new"', 'id="tmdbApiKey"', 'id="new-content-container"', 'id="shuffleBtn"', 'id="upcoming-container"', 'data-page="recommendations"', 'data-page="completeness"', 'data-page="people"', 'data-page="upcoming"', 'id="page-completeness"', 'id="page-people"', 'id="page-upcoming"', 'id="completeness-container"', 'id="people-container"'])
    assert.ok(html.includes(v), v);
  assert.match(html, /src="tmdb\.js"/);
  // Required by the TMDB API terms of use (attribution)
  assert.ok(html.includes('uses the'), 'TMDB attribution notice missing');
  assert.ok(/TMDB<\/a> API but is not endorsed or certified by TMDB/.test(html), 'TMDB attribution text missing');
});

test('external section size and TMDB rate-limit cap are configured in the sources', () => {
  assert.ok(read('script.js').includes('NEW_CONTENT_ANCHORS = 12'), 'NEW_CONTENT_ANCHORS = 12 missing');
  assert.ok(read('tmdb.js').includes('TMDB_MAX_REQ_PER_SEC = 40'), 'TMDB_MAX_REQ_PER_SEC = 40 missing (stay below TMDB ~50 rps ceiling)');
});

test('Docker setup serves the static app', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /FROM nginx/);
  assert.match(dockerfile, /COPY \. \/usr\/share\/nginx\/html/);
  assert.match(read('docker-compose.yml'), /build: \./);
  assert.ok(fs.existsSync(path.join(ROOT, '.dockerignore')));
});

const loadFindSimilar = (extra = {}) => {
  const ctx = vm.createContext({ console, Math, JSON, Set, Map, window: {}, ...extra });
  vm.runInContext(read('findSimilar.js'), ctx, { filename: 'findSimilar.js' });
  return ctx;
};

test('filterByContentType keeps only the selected type', () => {
  const ctx = loadFindSimilar();
  const filter = vm.runInContext('filterByContentType', ctx);
  const items = [{ Id: 'a', Type: 'Movie' }, { Id: 'b', Type: 'Series' }, { Id: 'c' }, { Id: 'd', Type: 'Episode' }];
  assert.equal(JSON.stringify(filter(items, 'Movie').map(i => i.Id)), '["a"]');
  assert.equal(JSON.stringify(filter(items, 'Series').map(i => i.Id)), '["b"]');
  assert.equal(filter(null, 'Movie').length, 0);
});

test('findSimilar: watched items are excluded by default and kept with includePlayed (whole-library scope)', () => {
  const ctx = loadFindSimilar({ jellyfin: { makeImageUrl: () => 'img' } });
  const findSimilar = vm.runInContext('findSimilar', ctx);
  const reset = vm.runInContext('resetRecommendationState', ctx);
  const mk = (Id, played) => ({ Id, Name: 'Item ' + Id, Type: 'Movie', Genres: ['Action'], ProductionYear: 2000, CommunityRating: 8, UserData: { Played: played } });
  const anchors = [mk('p1', true)];
  const candidates = [mk('u1', false), mk('p2', true)];

  reset();
  const defIds = findSimilar(anchors, candidates, 1, 5, false).flatMap(g => g.Recommendations.map(r => r.Id));
  assert.ok(defIds.includes('u1'));
  assert.ok(!defIds.includes('p2'), 'a played item must not be recommended by default');
  assert.ok(vm.runInContext('usedWatchedIds.size', ctx) > 0);

  reset();
  assert.equal(vm.runInContext('usedWatchedIds.size', ctx), 0, 'resetRecommendationState clears the anchors');
  const allIds = findSimilar(anchors, candidates, 1, 5, false, true).flatMap(g => g.Recommendations.map(r => r.Id));
  assert.ok(allIds.includes('u1') && allIds.includes('p2'), 'includePlayed keeps played items as candidates');
});

const loadTmdb = (fetchMock, extra = {}) => {
  const ctx = vm.createContext({ console, fetch: fetchMock, window: {}, ...extra });
  vm.runInContext(read('findSimilar.js'), ctx, { filename: 'findSimilar.js' });
  vm.runInContext(read('tmdb.js'), ctx, { filename: 'tmdb.js' });
  return ctx;
};

test('tmdb.js: tmdbFetch retries once on HTTP 429 and still throws on other errors', async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => ({ ok: 1 }) };
  };
  const ctx = loadTmdb(fetchMock, { setTimeout: (cb) => cb() });
  const tmdbFetchFn = vm.runInContext('tmdbFetch', ctx);
  const data = await tmdbFetchFn('/configuration', 'KEY');
  assert.equal(calls, 2, '429 -> one retry');
  assert.equal(JSON.stringify(data), '{"ok":1}');

  const ctx401 = loadTmdb(async () => ({ ok: false, status: 401 }), { setTimeout: (cb) => cb() });
  const tmdbFetch401 = vm.runInContext('tmdbFetch', ctx401);
  await assert.rejects(tmdbFetch401('/configuration', 'BAD'), /TMDB responded 401/);
});

test('tmdb.js: normalizeTmdbItem shapes movies and shows like library items', () => {
  const ctx = loadTmdb(async () => ({ ok: true, json: async () => ({}) }));
  const normalize = vm.runInContext('normalizeTmdbItem', ctx);
  const genreMap = { 28: 'Action', 878: 'Science Fiction' };
  const movie = normalize({ id: 27205, title: 'Inception', genre_ids: [28, 878], vote_average: 8.3, release_date: '2010-07-16', poster_path: '/p.jpg' }, 'Movie', genreMap);
  assert.equal(movie.TmdbId, '27205');
  assert.equal(movie.Name, 'Inception');
  assert.equal(JSON.stringify([...movie.Genres].sort()), '["Action","Science Fiction"]');
  assert.equal(movie.CommunityRating, 8.3);
  assert.equal(movie.ProductionYear, 2010);
  assert.equal(movie.ImageUrl, 'https://image.tmdb.org/t/p/w342/p.jpg');
  assert.equal(movie.ExternalUrl, 'https://www.themoviedb.org/movie/27205');
  assert.equal(movie.ReleaseDate, '2010-07-16');
  const show = normalize({ id: 1399, name: 'Game of Thrones', genre_ids: [18], vote_average: 8.4, first_air_date: '2011-04-17', poster_path: null }, 'Series', { 18: 'Drama' });
  assert.equal(show.ExternalUrl, 'https://www.themoviedb.org/tv/1399');
  assert.equal(show.ProductionYear, 2011);
  assert.equal(show.ImageUrl, undefined);
});

test('tmdb.js: tmdbKeyLooksValid accepts only 32-hex v3 keys, not the v4 token', () => {
  const ctx = loadTmdb(async () => ({ ok: true, json: async () => ({}) }));
  const valid = vm.runInContext('tmdbKeyLooksValid', ctx);
  assert.ok(valid('0123456789abcdef0123456789abcdef'));
  assert.ok(valid('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  assert.ok(!valid('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc'), 'v4 Read Access Token (JWT) must be rejected');
  assert.ok(!valid(''));
  assert.ok(!valid('short'));
  assert.ok(!valid('z'.repeat(32)));
});

test('tmdb.js: buildLibraryTmdbIds collects the Tmdb provider ids of the library', () => {
  const ctx = loadTmdb(async () => ({ ok: true, json: async () => ({}) }));
  const build = vm.runInContext('buildLibraryTmdbIds', ctx);
  const ids = build([{ ProviderIds: { Tmdb: 27205 } }, { ProviderIds: { Imdb: 'tt123' } }, { Id: 'x' }, null]);
  assert.equal(ids.size, 1);
  assert.ok(ids.has('27205'));
});

test('tmdb.js: getExternalRecommendations excludes what is already in the library and ranks the rest', async () => {
  const genreList = { genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }] };
  const similar = { results: [
    { id: 1, title: 'Library Hit', genre_ids: [28, 878], vote_average: 9.0, release_date: '2010-01-01', poster_path: '/a.jpg' },
    { id: 2, title: 'Fresh Pick', genre_ids: [28, 878], vote_average: 8.5, release_date: '2011-01-01', poster_path: '/b.jpg' },
    { id: 3, title: 'Unrelated', genre_ids: [], vote_average: 1.0, release_date: '1950-01-01' }
  ] };
  const fetchMock = async (url) => ({ ok: true, json: async () => (url.includes('/genre/') ? genreList : similar) });
  const ctx = loadTmdb(fetchMock);
  const getExt = vm.runInContext('getExternalRecommendations', ctx);
  const anchor = { Id: 'a1', Name: 'Anchor', Type: 'Movie', Genres: ['Action', 'Science Fiction'], ProductionYear: 2010, CommunityRating: 8.5, ProviderIds: { Tmdb: '100' }, UserData: { Played: true } };
  const library = [anchor, { Id: 'l1', Type: 'Movie', ProviderIds: { Tmdb: '1' }, Genres: ['Action'] }];

  assert.equal((await getExt([anchor], library, 'Movie', '')).groups.length, 0, 'no API key -> no external recommendations');
  const { groups, stats } = await getExt([anchor], library, 'Movie', 'KEY', { anchorCount: 1, perAnchor: 5 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].Name, 'Anchor');
  const ids = groups[0].Recommendations.map(r => r.TmdbId);
  assert.ok(ids.includes('2'), 'fresh item recommended');
  assert.ok(!ids.includes('1'), 'item already in the library is never recommended as new');
  assert.ok(!ids.includes('3'), 'low-similarity item below the threshold is dropped');
  assert.ok(groups[0].Recommendations[0].ExternalUrl.startsWith('https://www.themoviedb.org/movie/'));
  assert.equal(stats.anchorsWithId, 1);
  assert.ok(stats.fetched > 0 && stats.excluded >= 1, 'stats report fetched/excluded counts');
});

test('tmdb.js: isInLibrary matches by TMDB id or by title+year (remakes stay)', () => {
  const ctx = loadTmdb(async () => ({ ok: true, json: async () => ({}) }));
  const isInLibrary = vm.runInContext('isInLibrary', ctx);
  const buildIndex = vm.runInContext('buildLibraryTitleIndex', ctx);
  const index = buildIndex([{ Name: 'The Thing', ProductionYear: 1982 }, { Name: 'No Year' }, { Name: 'Ação!' }]);
  const ids = new Set(['42']);
  assert.ok(isInLibrary({ TmdbId: '42' }, ids, index), 'TMDB id match');
  assert.ok(isInLibrary({ TmdbId: '7', Name: 'the thing', ProductionYear: 1982 }, ids, index), 'title+year match, case-insensitive');
  assert.ok(!isInLibrary({ TmdbId: '8', Name: 'The Thing', ProductionYear: 2011 }, ids, index), 'same title, distant year = remake, kept');
  assert.ok(isInLibrary({ TmdbId: '9', Name: 'No Year', ProductionYear: 2020 }, ids, index), 'library side without year matches');
  assert.ok(isInLibrary({ TmdbId: '10', Name: 'Acao', ProductionYear: 2001 }, ids, index), 'accents/punctuation normalized');
  assert.ok(!isInLibrary({ TmdbId: '11', Name: 'Something Else', ProductionYear: 2001 }, ids, index));
});

test('tmdb.js: library items without a TMDB id still exclude their title from the recommendations', async () => {
  const genreList = { genres: [{ id: 28, name: 'Action' }] };
  const similar = { results: [
    { id: 7, title: 'In Library By Title', genre_ids: [28], vote_average: 9.0, release_date: '2010-01-01', poster_path: '/a.jpg' },
    { id: 8, title: 'Remake Year', genre_ids: [28], vote_average: 8.6, release_date: '1990-01-01' },
    { id: 9, title: 'Fresh Pick', genre_ids: [28], vote_average: 8.4, release_date: '2012-01-01', poster_path: '/b.jpg' }
  ] };
  const fetchMock = async (url) => ({ ok: true, json: async () => (url.includes('/genre/') ? genreList : similar) });
  const ctx = loadTmdb(fetchMock);
  const getExt = vm.runInContext('getExternalRecommendations', ctx);
  const anchor = { Id: 'a1', Name: 'Anchor', Type: 'Movie', Genres: ['Action'], ProductionYear: 2010, CommunityRating: 8.5, ProviderIds: { Tmdb: '100' } };
  // l1 has NO ProviderIds.Tmdb but the same title/year as candidate 7; l2 same title as candidate 8 but year 2010
  const library = [anchor,
    { Id: 'l1', Name: 'In Library By Title', Type: 'Movie', ProductionYear: 2010, Genres: ['Action'] },
    { Id: 'l2', Name: 'Remake Year', Type: 'Movie', ProductionYear: 2010, Genres: ['Action'] }];
  const { groups, stats } = await getExt([anchor], library, 'Movie', 'KEY', { anchorCount: 1, perAnchor: 5 });
  const ids = groups.flatMap(g => g.Recommendations.map(r => r.TmdbId));
  assert.ok(!ids.includes('7'), 'same title+year without TMDB id on the library item -> excluded');
  assert.ok(ids.includes('8'), 'same title, different year (remake) -> kept');
  assert.ok(ids.includes('9'), 'unrelated fresh title -> kept');
  assert.ok(stats.excluded >= 1);
});

const upcomingMocks = () => {
  const genreList = { genres: [{ id: 28, name: 'Action' }] };
  const tvDetails = { poster_path: '/tv.jpg', seasons: [
    { season_number: 0, name: 'Specials', air_date: '2019-01-01', episode_count: 5 },
    { season_number: 1, air_date: '2020-01-01', episode_count: 10 },
    { season_number: 2, air_date: '2021-01-01', episode_count: 10 },
    { season_number: 3, air_date: '2022-05-01', episode_count: 8 },
    { season_number: 4, air_date: '2099-01-01', episode_count: 8, poster_path: '/s4.jpg' }
  ] };
  const movieDetails = { belongs_to_collection: { id: 999 } };
  const collection = { name: 'Anchor Collection', parts: [
    { id: 100, title: 'Anchor', release_date: '2010-01-01', vote_average: 8, popularity: 90, genre_ids: [28], poster_path: '/a.jpg' },
    { id: 101, title: 'Anchor Part 2', release_date: '2011-01-01', vote_average: 7.5, popularity: 60, genre_ids: [28] },
    { id: 102, title: 'Anchor Part 3', release_date: '2099-06-01', vote_average: 0, popularity: 10, genre_ids: [28] }
  ] };
  const credits = { cast: [{ id: 55, name: 'Star Actor' }], crew: [{ id: 66, name: 'Top Director', job: 'Director' }] };
  const person55 = { cast: [{ id: 201, media_type: 'movie', title: 'Actor Movie', release_date: '2015-01-01', vote_average: 8, popularity: 50, genre_ids: [28], poster_path: '/p.jpg' }], crew: [] };
  const person66 = { cast: [], crew: [{ id: 202, media_type: 'movie', title: 'Director Movie', release_date: '2099-03-01', vote_average: 0, popularity: 5, genre_ids: [28] }] };
  const search = { results: [{ id: 300, name: 'My Show', popularity: 10 }] };
  return async (url) => {
    const json = async () => {
      if (url.includes('/genre/')) return genreList;
      if (url.includes('/search/tv')) return search;
      if (url.includes('/tv/300')) return tvDetails;
      if (url.includes('/movie/100/credits')) return credits;
      if (url.includes('/movie/100?')) return movieDetails;
      if (url.includes('/collection/999')) return collection;
      if (url.includes('/person/55/')) return person55;
      if (url.includes('/person/66/')) return person66;
      throw new Error('unexpected ' + url);
    };
    return { ok: true, json };
  };
};

test('tmdb.js: getMissingSeasons excludes owned seasons/specials and resolves ids via search when missing', async () => {
  const ctx = loadTmdb(upcomingMocks(), { setTimeout: (cb) => cb() });
  const getMissingSeasons = vm.runInContext('getMissingSeasons', ctx);
  const series = [{ Id: 's1', Name: 'My Show', Type: 'Series', ProductionYear: 2020, ProviderIds: {} }]; // no Tmdb id -> search fallback
  const owned = new Map([['s1', new Set([1, 2])]]);
  const cards = await getMissingSeasons(series, owned, 'KEY');
  assert.equal(cards.length, 2, 'only the missing seasons (3, 4); owned 1-2 and specials excluded');
  assert.ok(cards.every(c => c.Name === 'My Show'), 'card title is the show name, not a long "Show — Season N"');
  assert.ok(cards.find(c => c.note.includes('Season 4')).note.includes('releases 2099-01-01'));
  assert.ok(cards.find(c => c.note.includes('Season 3')).note.includes('aired 2022-05-01'), 'past seasons say "aired", not "aired/released"');
  assert.ok(cards[0].ExternalUrl.includes('/tv/300/season/'));
  assert.ok(cards.find(c => c.note.includes('Season 4')).ImageUrl.includes('/s4.jpg'), 'season poster preferred');
  assert.ok(cards.find(c => c.note.includes('Season 3')).ImageUrl.includes('/tv.jpg'), 'falls back to the series poster');
});

test('tmdb.js: getMissingSequels excludes library parts by tmdb id AND by title+year', async () => {
  const ctx = loadTmdb(upcomingMocks(), { setTimeout: (cb) => cb() });
  const getMissingSequels = vm.runInContext('getMissingSequels', ctx);
  const movie = { Id: 'm1', Name: 'Anchor', Type: 'Movie', ProviderIds: { Tmdb: '100' } };
  const library = [movie, { Id: 'l1', Name: 'Anchor Part 2', Type: 'Movie', ProductionYear: 2011 }]; // no Tmdb id -> title match
  const cards = await getMissingSequels([movie], library, 'KEY');
  assert.ok(!cards.some(c => c.TmdbId === '100'), 'owned by tmdb id excluded');
  assert.ok(!cards.some(c => c.TmdbId === '101'), 'owned by title+year (no tmdb id) excluded');
  assert.ok(cards.some(c => c.TmdbId === '102'), 'missing sequel kept');
  assert.ok(cards.find(c => c.TmdbId === '102').note.includes('Releases 2099-06-01'));
  assert.ok(cards.find(c => c.TmdbId === '102').Name.includes('Anchor Collection'));
});

test('tmdb.js: getFavoritePeopleWorks groups works by actor/director with date notes', async () => {
  const ctx = loadTmdb(upcomingMocks(), { setTimeout: (cb) => cb() });
  const getPeople = vm.runInContext('getFavoritePeopleWorks', ctx);
  const anchor = { Id: 'm1', Name: 'Anchor', Type: 'Movie', ProviderIds: { Tmdb: '100' }, UserData: { Played: true } };
  const { actors, directors } = await getPeople([anchor], [anchor], 'Movie', 'KEY');
  assert.ok(actors.some(c => c.Name === 'Actor Movie' && c.note.includes('with Star Actor')), JSON.stringify(actors.map(a => a.note)));
  assert.ok(directors.some(c => c.Name === 'Director Movie' && c.note.includes('by Top Director') && c.note.includes('releases 2099-03-01')));
});

test('tmdb.js: getUpcomingReleases returns only future-dated items, sorted by date', async () => {
  const ctx = loadTmdb(upcomingMocks(), { setTimeout: (cb) => cb() });
  const getUpcoming = vm.runInContext('getUpcomingReleases', ctx);
  const movie = { Id: 'm1', Name: 'Anchor', Type: 'Movie', ProviderIds: { Tmdb: '100' }, UserData: { Played: true } };
  const series = [{ Id: 's1', Name: 'My Show', Type: 'Series', ProviderIds: { Tmdb: '300' } }];
  const cards = await getUpcoming({ items: [movie], watchedItems: [movie], libraryItems: [movie, series], ownedSeasons: new Map([['s1', new Set([1, 2])]]), type: 'Movie', apiKey: 'KEY' });
  const names = cards.map(c => c.Name).join(' | ');
  assert.ok(names.includes('Anchor Part 3') && names.includes('Director Movie'), names);
  assert.ok(!names.includes('Actor Movie') && !names.includes('Anchor Part 2'), 'past-dated items excluded');
  const dates = cards.map(c => c.ReleaseDate);
  assert.equal(JSON.stringify(dates), JSON.stringify([...dates].sort()), 'sorted by release date');
});

test('tmdb.js: anchors without a Tmdb provider id are resolved through a TMDB title search', async () => {
  const genreList = { genres: [{ id: 28, name: 'Action' }] };
  const search = { results: [{ id: 555, title: 'Anchor Movie', popularity: 42 }] };
  const similar = { results: [{ id: 9, title: 'Fresh Pick', genre_ids: [28], vote_average: 8.4, release_date: '2012-01-01', poster_path: '/b.jpg' }] };
  const fetchMock = async (url) => ({
    ok: true,
    json: async () => (url.includes('/genre/') ? genreList : url.includes('/search/') ? search : similar)
  });
  const ctx = loadTmdb(fetchMock);
  const getExt = vm.runInContext('getExternalRecommendations', ctx);
  const anchor = { Id: 'a1', Name: 'Anchor Movie', Type: 'Movie', Genres: ['Action'], ProductionYear: 2010, CommunityRating: 8.5, ProviderIds: {}, UserData: { Played: true } };
  const { groups, stats } = await getExt([anchor], [anchor], 'Movie', 'KEY', { anchorCount: 1, perAnchor: 5 });
  assert.equal(stats.anchorsWithId, 1, 'search fallback resolved the TMDB id');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].Recommendations[0].TmdbId, '9');
});

test('tokenizeName: same tokens as before for ASCII titles, accents and other scripts kept (CR-11)', () => {
  const ctx = loadFindSimilar();
  const tokenize = vm.runInContext('tokenizeName', ctx);
  const old = name => (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1 && !['the', 'part', 'season', 'episode'].includes(w));
  for (const title of ['The Matrix Reloaded', 'Spider-Man: No Way Home', "Ocean's Eleven (2001)", 'Star Wars: Episode IV']) {
    assert.equal(JSON.stringify(tokenize(title)), JSON.stringify(old(title)), title);
  }
  assert.equal(JSON.stringify(tokenize('Ação Total')), '["acao","total"]');
  assert.equal(tokenize('千と千尋 の神隠し').length, 2);
});

test('selectRandomContents: returns distinct items and every item can come first', () => {
  const ctx = loadFindSimilar();
  const pick = vm.runInContext('selectRandomContents', ctx);
  const items = [1, 2, 3, 4, 5].map(Id => ({ Id }));
  const firsts = new Map();
  for (let i = 0; i < 5000; i++) {
    const out = pick(items, 3);
    assert.equal(new Set(out.map(o => o.Id)).size, 3);
    firsts.set(out[0].Id, (firsts.get(out[0].Id) || 0) + 1);
  }
  for (const [, count] of firsts) assert.ok(Math.abs(count - 1000) < 150, `biased pick: ${JSON.stringify([...firsts])}`);
});

test('vendored copies match their sources (when the repositories are checked out side by side)', (t) => {
  const sources = { 'jellyfin.js': '../CoverMaker/js/jellyfin.js', 'windowsHandle.js': '../CoverMaker/js/windowsHandle.js' };
  for (const f of VENDOR) if (!sources[f]) sources[f] = `../cdn/js/${f}`;
  const available = Object.entries(sources).filter(([, src]) => fs.existsSync(path.join(ROOT, src)));
  if (!available.length) return t.skip('cdn / CoverMaker not checked out next to this repository');
  for (const [f, src] of available) assert.equal(read(`js/vendor/${f}`), read(src), `js/vendor/${f} differs from ${src}`);
});
