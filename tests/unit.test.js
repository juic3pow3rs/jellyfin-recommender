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
  for (const v of ['data-type="Movie"', 'data-type="Series"', 'data-scope="watched"', 'data-scope="all"', 'data-new="off"', 'data-new="on"', 'id="tmdbApiKey"', 'id="new-content-container"'])
    assert.ok(html.includes(v), v);
  assert.match(html, /src="tmdb\.js"/);
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

const loadTmdb = (fetchMock) => {
  const ctx = vm.createContext({ console, fetch: fetchMock, window: {} });
  vm.runInContext(read('findSimilar.js'), ctx, { filename: 'findSimilar.js' });
  vm.runInContext(read('tmdb.js'), ctx, { filename: 'tmdb.js' });
  return ctx;
};

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
  const show = normalize({ id: 1399, name: 'Game of Thrones', genre_ids: [18], vote_average: 8.4, first_air_date: '2011-04-17', poster_path: null }, 'Series', { 18: 'Drama' });
  assert.equal(show.ExternalUrl, 'https://www.themoviedb.org/tv/1399');
  assert.equal(show.ProductionYear, 2011);
  assert.equal(show.ImageUrl, undefined);
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

  assert.equal((await getExt([anchor], library, 'Movie', '')).length, 0, 'no API key -> no external recommendations');
  const groups = await getExt([anchor], library, 'Movie', 'KEY', { anchorCount: 1, perAnchor: 5 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].Name, 'Anchor');
  const ids = groups[0].Recommendations.map(r => r.TmdbId);
  assert.ok(ids.includes('2'), 'fresh item recommended');
  assert.ok(!ids.includes('1'), 'item already in the library is never recommended as new');
  assert.ok(!ids.includes('3'), 'low-similarity item below the threshold is dropped');
  assert.ok(groups[0].Recommendations[0].ExternalUrl.startsWith('https://www.themoviedb.org/movie/'));
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
