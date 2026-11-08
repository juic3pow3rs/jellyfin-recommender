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
  for (const rel of ['script.js', 'findSimilar.js', 'script_infinity_scroll.js', ...VENDOR.map(f => `js/vendor/${f}`)]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
    assert.doesNotThrow(() => new vm.Script(read(rel), { filename: rel }), rel);
  }
});

test('index.html loads the vendored copies, not the live sites of the other repositories (CR-05)', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /src="https:\/\/jeffersoncgo\.github\.io\//);
  for (const f of VENDOR) assert.match(html, new RegExp(`src="js/vendor/${f.replace('.', '\\.')}"`), f);
});

test('index.html has the Movies/Shows and Watched only/Whole library toggles', () => {
  const html = read('index.html');
  assert.match(html, /id="filter-bar"/);
  for (const v of ['data-type="Movie"', 'data-type="Series"', 'data-scope="watched"', 'data-scope="all"'])
    assert.ok(html.includes(v), v);
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
