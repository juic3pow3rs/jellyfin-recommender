// ======================
// External recommendations (TMDB) — items NOT yet in the Jellyfin library
// ======================
// Jellyfin items carry their TMDB id in ProviderIds.Tmdb. For a few watched anchors we ask TMDB for
// similar/recommended movies or shows, drop everything that already exists in the library and rank the
// rest with the same calculateSimilarity used for in-library recommendations.
// TMDB needs the user's own free API key (https://www.themoviedb.org/settings/api); it is kept in
// localStorage ("tmdbApiKey") and only ever sent to api.themoviedb.org.
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342'; // poster width matching the cards (~180px, 2x)

// The app uses the v3 key as an api_key= query parameter: 32 hex characters. The v4 "API Read Access Token"
// is a JWT (starts with "eyJ") for Bearer-header auth and does not work here.
function tmdbKeyLooksValid(apiKey) {
  return /^[a-f0-9]{32}$/i.test(apiKey || '');
}

const tmdbGenreMaps = {}; // type ('Movie'|'Series') -> { genreId: name }

// Rate limiting (developer.themoviedb.org/docs/rate-limiting): the legacy 40 req/10 s limit is gone, but a
// CDN-level ceiling of roughly 40-50 requests/second per IP remains, and 429 must be respected. Stay below
// it with a sliding window of at most TMDB_MAX_REQ_PER_SEC requests per second, and on a 429 back off and
// retry once.
const TMDB_MAX_REQ_PER_SEC = 40;
const tmdbReqTimes = [];

async function tmdbThrottle() {
  for (;;) {
    const now = Date.now();
    while (tmdbReqTimes.length && now - tmdbReqTimes[0] >= 1000) tmdbReqTimes.shift();
    if (tmdbReqTimes.length < TMDB_MAX_REQ_PER_SEC) {
      tmdbReqTimes.push(now);
      return;
    }
    await new Promise(r => setTimeout(r, 1000 - (now - tmdbReqTimes[0]) + 10));
  }
}

async function tmdbFetch(path, apiKey, retried = false) {
  await tmdbThrottle();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${TMDB_API}${path}${sep}api_key=${encodeURIComponent(apiKey)}`);
  if (res.status === 429 && !retried) {
    await new Promise(r => setTimeout(r, 2000)); // Too Many Requests: back off, then retry once
    return tmdbFetch(path, apiKey, true);
  }
  if (!res.ok) throw new Error(`TMDB responded ${res.status}`);
  return res.json();
}

async function tmdbGenreMap(type, apiKey) {
  if (tmdbGenreMaps[type]) return tmdbGenreMaps[type];
  const kind = type === 'Series' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/genre/${kind}/list?language=en-US`, apiKey);
  const map = {};
  for (const g of data.genres || []) map[g.id] = g.name;
  tmdbGenreMaps[type] = map;
  return map;
}

function tmdbYear(dateStr) {
  const year = parseInt((dateStr || '').slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

// Shapes a TMDB result like a library item so calculateSimilarity and the cards work unchanged.
// ExternalUrl makes the card open the TMDB page instead of a Jellyfin details page.
function normalizeTmdbItem(raw, type, genreMap) {
  const isMovie = type !== 'Series';
  const kind = isMovie ? 'movie' : 'tv';
  return {
    Id: `tmdb-${kind}-${raw.id}`,
    TmdbId: String(raw.id),
    Type: isMovie ? 'Movie' : 'Series',
    Name: (isMovie ? raw.title : raw.name) || (isMovie ? raw.original_title : raw.original_name) || 'Unknown',
    Genres: (raw.genre_ids || []).map(id => genreMap[id]).filter(Boolean),
    CommunityRating: typeof raw.vote_average === 'number' ? raw.vote_average : null,
    ProductionYear: tmdbYear(isMovie ? raw.release_date : raw.first_air_date),
    ReleaseDate: isMovie ? (raw.release_date || null) : (raw.first_air_date || null),
    Popularity: typeof raw.popularity === 'number' ? raw.popularity : null,
    ImageUrl: raw.poster_path ? `${TMDB_IMAGE}${raw.poster_path}` : undefined,
    ExternalUrl: `https://www.themoviedb.org/${kind}/${raw.id}`
  };
}

// TMDB ids of everything already in the library: those must never be recommended as "new"
function buildLibraryTmdbIds(items) {
  const ids = new Set();
  for (const item of items || []) {
    const tmdb = item?.ProviderIds?.Tmdb;
    if (tmdb) ids.add(String(tmdb));
  }
  return ids;
}

function normalizeTitle(name) {
  return (name || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Title index of the library for items whose TMDB id is unknown (old cache, Meilisearch load):
// normalized title -> list of known production years (null when missing)
function buildLibraryTitleIndex(items) {
  const index = new Map();
  for (const item of items || []) {
    const key = normalizeTitle(item?.Name);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item?.ProductionYear ?? null);
  }
  return index;
}

// A candidate counts as "already in the library" when its TMDB id matches, or when title matches and the
// years agree (or one side has no year). Same title with a distant year is a remake: a different TMDB item.
function isInLibrary(candidate, libraryIds, titleIndex) {
  if (libraryIds.has(candidate.TmdbId)) return true;
  const years = titleIndex.get(normalizeTitle(candidate.Name));
  if (!years) return false;
  const y = candidate.ProductionYear;
  return years.some(ly => !y || !ly || Math.abs(ly - y) <= 2);
}

const TMDB_PAGES = 3; // pages per endpoint: page 1 is often full of titles the library already has
const anchorTmdbIdCache = new Map(); // anchor.Id -> tmdb id (or null)

// Anchors usually carry ProviderIds.Tmdb; when they don't (old cache, Meilisearch load), resolve the id
// through a TMDB title search (with the production year when known)
async function resolveAnchorTmdbId(anchor, type, apiKey) {
  if (anchorTmdbIdCache.has(anchor.Id)) return anchorTmdbIdCache.get(anchor.Id);
  let tmdbId = anchor?.ProviderIds?.Tmdb ? String(anchor.ProviderIds.Tmdb) : null;
  if (!tmdbId && anchor?.Name) {
    const kind = type === 'Series' ? 'tv' : 'movie';
    const yearParam = anchor.ProductionYear
      ? (type === 'Series' ? `&first_air_date_year=${anchor.ProductionYear}` : `&year=${anchor.ProductionYear}`)
      : '';
    try {
      const data = await tmdbFetch(`/search/${kind}?language=en-US&query=${encodeURIComponent(anchor.Name)}${yearParam}&page=1`, apiKey);
      const results = data.results || [];
      if (results.length) {
        const norm = s => (s || '').toLowerCase();
        const exact = results.find(r => norm(type === 'Series' ? r.name : r.title) === norm(anchor.Name));
        const best = exact || [...results].sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
        tmdbId = String(best.id);
      }
    } catch (error) {
      console.warn(`TMDB search failed for "${anchor.Name}":`, error.message);
    }
  }
  anchorTmdbIdCache.set(anchor.Id, tmdbId);
  return tmdbId;
}

async function fetchTmdbSimilarForAnchor(anchor, tmdbId, type, apiKey, genreMap) {
  if (!tmdbId) return [];
  const kind = type === 'Series' ? 'tv' : 'movie';
  const requests = [];
  for (const endpoint of ['similar', 'recommendations'])
    for (let page = 1; page <= TMDB_PAGES; page++)
      requests.push(
        tmdbFetch(`/${kind}/${tmdbId}/${endpoint}?language=en-US&page=${page}`, apiKey)
          .then(data => (data.results || []).map(raw => normalizeTmdbItem(raw, type, genreMap)))
          .catch(error => { console.warn(`TMDB ${endpoint} p${page} failed for "${anchor.Name}":`, error.message); return []; })
      );
  const pages = await Promise.all(requests);
  // similar + recommendations (and the pages) overlap: keep one copy of each TMDB id
  return [...new Map(pages.flat().map(c => [c.TmdbId, c])).values()];
}

// Same score and threshold (> 15) as findSimilarForOne, against the library anchor
function rankExternalCandidates(anchor, candidates, rarityProfile, limit = 6) {
  const ownTmdbId = String(anchor?.ProviderIds?.Tmdb || '');
  const scored = [];
  for (const candidate of candidates) {
    if (candidate.TmdbId === ownTmdbId) continue;
    const score = calculateSimilarity(anchor, candidate, rarityProfile);
    if (score > 15) scored.push({ ...candidate, similarityScore: Math.round(score) });
  }
  scored.sort((a, b) => b.similarityScore - a.similarityScore);
  return scored.slice(0, limit);
}

// anchors: library items to base on (already type-filtered); libraryItems: the whole library of that type,
// used to exclude items the user already has. Returns { groups, stats } — stats say why groups can be empty
async function getExternalRecommendations(anchors, libraryItems, type, apiKey, { anchorCount = 3, perAnchor = 6 } = {}) {
  const stats = { anchors: 0, anchorsWithId: 0, fetched: 0, excluded: 0, groups: 0 };
  if (!apiKey || !anchors?.length) return { groups: [], stats };
  const genreMap = await tmdbGenreMap(type, apiKey);
  const libraryIds = buildLibraryTmdbIds(libraryItems);
  const titleIndex = buildLibraryTitleIndex(libraryItems);
  const rarityProfile = buildRarityMap([...(anchors || []), ...(libraryItems || [])]);
  const picked = selectRandomContents(anchors, anchorCount);
  const usedIds = new Set();
  stats.anchors = picked.length;

  const groups = (await Promise.all(picked.map(async anchor => {
    const tmdbId = await resolveAnchorTmdbId(anchor, type, apiKey);
    if (tmdbId) stats.anchorsWithId++;
    const raw = await fetchTmdbSimilarForAnchor(anchor, tmdbId, type, apiKey, genreMap);
    stats.fetched += raw.length;
    const fresh = raw.filter(c => !isInLibrary(c, libraryIds, titleIndex) && !usedIds.has(c.TmdbId));
    stats.excluded += raw.length - fresh.length;
    const recommendations = rankExternalCandidates(anchor, fresh, rarityProfile, perAnchor);
    if (!recommendations.length) return null;
    recommendations.forEach(r => usedIds.add(r.TmdbId));
    return { Name: anchor.Name, Id: anchor.Id, Recommendations: recommendations };
  }))).filter(Boolean);

  stats.groups = groups.length;
  return { groups, stats };
}

// ======================
// Pages 2-4 data: collection completeness, favorite people, upcoming releases.
// TMDB ids are resolved through resolveAnchorTmdbId (ProviderIds.Tmdb, else a TMDB title search), so items
// from an old cache or a Meilisearch load still work. Everything goes through the throttled tmdbFetch.
// ======================
const UPCOMING_MAX_SERIES = 40;        // tv-details requests for season completeness
const UPCOMING_MAX_MOVIES = 20;        // movie-details + collection requests for sequels
const UPCOMING_MAX_CREDIT_ANCHORS = 8; // watched titles whose credits build the favorite people
const UPCOMING_MAX_ACTORS = 5;
const UPCOMING_MAX_DIRECTORS = 3;

// TMDB tv details: every season (season 0 = specials is ignored) with its air date and own poster
async function tmdbTvDetails(tmdbId, apiKey) {
  const data = await tmdbFetch(`/tv/${tmdbId}?language=en-US`, apiKey);
  const seasons = (data.seasons || [])
    .filter(s => s.season_number >= 1 && (s.episode_count > 0 || s.air_date))
    .map(s => ({
      seasonNumber: s.season_number,
      name: s.name || `Season ${s.season_number}`,
      airDate: s.air_date || null,
      episodeCount: s.episode_count || 0,
      posterPath: s.poster_path || null
    }));
  return { seasons, posterPath: data.poster_path || null };
}

// TMDB movie details: the collection it belongs to (for "part x" sequels)
async function tmdbMovieCollectionId(tmdbId, apiKey) {
  const data = await tmdbFetch(`/movie/${tmdbId}?language=en-US`, apiKey);
  return data.belongs_to_collection?.id ? String(data.belongs_to_collection.id) : null;
}

async function tmdbCollection(collectionId, apiKey, genreMap) {
  const data = await tmdbFetch(`/collection/${collectionId}?language=en-US`, apiKey);
  return { name: data.name || 'Collection', parts: (data.parts || []).map(p => normalizeTmdbItem(p, 'Movie', genreMap)) };
}

// Top cast + directors of one title
async function tmdbCredits(tmdbId, type, apiKey) {
  const kind = type === 'Series' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/${kind}/${tmdbId}/credits?language=en-US`, apiKey);
  return {
    cast: (data.cast || []).slice(0, 5).map(c => ({ id: c.id, name: c.name })),
    directors: (data.crew || []).filter(c => c.job === 'Director').map(c => ({ id: c.id, name: c.name }))
  };
}

// All movie/tv works of a person (combined credits, deduped)
async function tmdbPersonWorks(personId, apiKey, genreMap) {
  const data = await tmdbFetch(`/person/${personId}/combined_credits?language=en-US`, apiKey);
  const seen = new Map();
  for (const c of [...(data.cast || []), ...(data.crew || [])]) {
    if (c.media_type !== 'movie' && c.media_type !== 'tv') continue;
    if (!seen.has(c.id)) seen.set(c.id, normalizeTmdbItem(c, c.media_type === 'tv' ? 'Series' : 'Movie', genreMap));
  }
  return [...seen.values()];
}

function upcomingDateNote(prefix, date, today, pastVerb = 'aired') {
  if (!date) return `${prefix} — no date yet`;
  return date > today ? `${prefix} releases ${date}` : `${prefix} ${pastVerb} ${date}`;
}

// Page 2 (shows): seasons of the given library series that TMDB knows but the library does not have.
// ownedSeasons: Map seriesId -> Set(seasonNumber) from Jellyfin.
async function getMissingSeasons(series, ownedSeasons, apiKey) {
  if (!apiKey) return [];
  const today = new Date().toISOString().slice(0, 10);
  const cards = [];
  await Promise.all((series || []).slice(0, UPCOMING_MAX_SERIES).map(async s => {
    const tmdbId = await resolveAnchorTmdbId(s, 'Series', apiKey);
    if (!tmdbId) return;
    let details;
    try { details = await tmdbTvDetails(tmdbId, apiKey); }
    catch (e) { console.warn(`TMDB tv details failed for "${s.Name}":`, e.message); return; }
    const owned = ownedSeasons?.get(s.Id) || new Set();
    for (const sn of details.seasons) {
      if (owned.has(sn.seasonNumber)) continue;
      const poster = sn.posterPath || details.posterPath;
      cards.push({
        Id: `season-${s.Id}-${sn.seasonNumber}`,
        Name: s.Name, // the season + date go in the note line, so the title stays short and readable
        source: 'seasons', // where the recommendation comes from (grouping on the Upcoming page)
        CommunityRating: null,
        ProductionYear: tmdbYear(sn.airDate),
        ReleaseDate: sn.airDate,
        ImageUrl: poster ? `${TMDB_IMAGE}${poster}` : undefined,
        ExternalUrl: `https://www.themoviedb.org/tv/${tmdbId}/season/${sn.seasonNumber}`,
        note: upcomingDateNote(`Season ${sn.seasonNumber}`, sn.airDate, today, 'aired')
      });
    }
  }));
  return cards;
}

// Page 2 (movies): collection parts ("part x") of the given library movies that are not in the library
async function getMissingSequels(movies, libraryItems, apiKey) {
  if (!apiKey) return [];
  const genreMap = await tmdbGenreMap('Movie', apiKey);
  const libraryIds = buildLibraryTmdbIds(libraryItems);
  const titleIndex = buildLibraryTitleIndex(libraryItems);
  const today = new Date().toISOString().slice(0, 10);
  const cards = [];
  await Promise.all((movies || []).slice(0, UPCOMING_MAX_MOVIES).map(async m => {
    const tmdbId = await resolveAnchorTmdbId(m, 'Movie', apiKey);
    if (!tmdbId) return;
    let collection;
    try {
      const cid = await tmdbMovieCollectionId(tmdbId, apiKey);
      if (!cid) return;
      collection = await tmdbCollection(cid, apiKey, genreMap);
    } catch (e) { console.warn(`TMDB collection failed for "${m.Name}":`, e.message); return; }
    for (const p of collection.parts) {
      if (isInLibrary(p, libraryIds, titleIndex)) continue;
      cards.push({ ...p, Name: `${collection.name}: ${p.Name}`, source: 'collections', note: !p.ReleaseDate ? 'No date yet' : (p.ReleaseDate > today ? `Releases ${p.ReleaseDate}` : `Released ${p.ReleaseDate}`) });
    }
  }));
  return cards;
}

// Page 3: other works (of the given type) of the most frequent actors/directors among the anchor items
async function getFavoritePeopleWorks(anchors, libraryItems, type, apiKey) {
  const empty = { actors: [], directors: [] };
  if (!apiKey) return empty;
  const genreMap = { ...(await tmdbGenreMap('Movie', apiKey)), ...(await tmdbGenreMap('Series', apiKey)) };
  const libraryIds = buildLibraryTmdbIds(libraryItems);
  const titleIndex = buildLibraryTitleIndex(libraryItems);
  const today = new Date().toISOString().slice(0, 10);
  const people = new Map();
  const bump = (p, role) => {
    const key = `${role}-${p.id}`;
    const e = people.get(key) || { id: p.id, name: p.name, role, count: 0 };
    e.count++;
    people.set(key, e);
  };
  await Promise.all((anchors || []).slice(0, UPCOMING_MAX_CREDIT_ANCHORS).map(async a => {
    const tmdbId = await resolveAnchorTmdbId(a, type, apiKey);
    if (!tmdbId) return;
    let credits;
    try { credits = await tmdbCredits(tmdbId, type, apiKey); }
    catch (e) { console.warn(`TMDB credits failed for "${a.Name}":`, e.message); return; }
    credits.cast.forEach(c => bump(c, 'actor'));
    credits.directors.forEach(d => bump(d, 'director'));
  }));
  const topPeople = (role, n) => [...people.values()].filter(p => p.role === role).sort((x, y) => y.count - x.count).slice(0, n);
  const actorCards = [], directorCards = [];
  await Promise.all([...topPeople('actor', UPCOMING_MAX_ACTORS), ...topPeople('director', UPCOMING_MAX_DIRECTORS)].map(async person => {
    let works;
    try { works = await tmdbPersonWorks(person.id, apiKey, genreMap); }
    catch (e) { console.warn(`TMDB person credits failed for ${person.name}:`, e.message); return; }
    for (const w of works) {
      if (w.Type !== type) continue;
      if (isInLibrary(w, libraryIds, titleIndex)) continue;
      const future = !!w.ReleaseDate && w.ReleaseDate > today;
      const card = { ...w, source: person.role === 'actor' ? 'actors' : 'directors', note: `${person.role === 'actor' ? 'with' : 'by'} ${person.name}` + (w.ReleaseDate ? ` · ${future ? 'releases' : 'released'} ${w.ReleaseDate}` : '') };
      (person.role === 'actor' ? actorCards : directorCards).push(card);
    }
  }));
  const byRating = (a, b) => (b.CommunityRating || 0) - (a.CommunityRating || 0) || (b.Popularity || 0) - (a.Popularity || 0);
  return { actors: actorCards.sort(byRating).slice(0, 12), directors: directorCards.sort(byRating).slice(0, 12) };
}

// Page 4: everything with a future release date — missing seasons/sequels of the type + people works.
// Every card carries `source` ('seasons' | 'collections' | 'actors' | 'directors') so the page can group by origin.
const UPCOMING_SOURCE_HEADINGS = {
  seasons: 'Upcoming seasons of your shows',
  collections: 'Upcoming sequels / collection parts',
  actors: 'Upcoming from your favorite actors',
  directors: 'Upcoming from your favorite directors'
};

function groupUpcomingBySource(items) {
  return ['seasons', 'collections', 'actors', 'directors']
    .map(source => ({ source, heading: UPCOMING_SOURCE_HEADINGS[source], items: (items || []).filter(c => c.source === source) }))
    .filter(g => g.items.length);
}

async function getUpcomingReleases({ items, watchedItems, libraryItems, ownedSeasons, type, apiKey }) {
  if (!apiKey) return [];
  const today = new Date().toISOString().slice(0, 10);
  let cards = type === 'Series'
    ? await getMissingSeasons(items, ownedSeasons, apiKey)
    : await getMissingSequels(items, libraryItems, apiKey);
  const people = await getFavoritePeopleWorks(watchedItems, libraryItems, type, apiKey);
  cards = cards.concat(people.actors, people.directors);
  return cards
    .filter(c => c.ReleaseDate && c.ReleaseDate > today)
    .sort((a, b) => a.ReleaseDate.localeCompare(b.ReleaseDate))
    .slice(0, 24);
}
