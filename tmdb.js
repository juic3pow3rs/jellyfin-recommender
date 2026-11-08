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

async function tmdbFetch(path, apiKey) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${TMDB_API}${path}${sep}api_key=${encodeURIComponent(apiKey)}`);
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
    Name: (isMovie ? raw.title : raw.name) || (isMovie ? raw.original_title : raw.original_name) || 'Unknown',
    Genres: (raw.genre_ids || []).map(id => genreMap[id]).filter(Boolean),
    CommunityRating: typeof raw.vote_average === 'number' ? raw.vote_average : null,
    ProductionYear: tmdbYear(isMovie ? raw.release_date : raw.first_air_date),
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

async function fetchTmdbSimilarForAnchor(anchor, type, apiKey, genreMap) {
  const tmdbId = anchor?.ProviderIds?.Tmdb;
  if (!tmdbId) return [];
  const kind = type === 'Series' ? 'tv' : 'movie';
  const pages = await Promise.all(['similar', 'recommendations'].map(endpoint =>
    tmdbFetch(`/${kind}/${tmdbId}/${endpoint}?language=en-US&page=1`, apiKey)
      .then(data => (data.results || []).map(raw => normalizeTmdbItem(raw, type, genreMap)))
      .catch(error => { console.warn(`TMDB ${endpoint} failed for ${anchor.Name}:`, error.message); return []; })
  ));
  return pages.flat();
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
// used to exclude items the user already has
async function getExternalRecommendations(anchors, libraryItems, type, apiKey, { anchorCount = 3, perAnchor = 6 } = {}) {
  if (!apiKey || !anchors?.length) return [];
  const genreMap = await tmdbGenreMap(type, apiKey);
  const libraryIds = buildLibraryTmdbIds(libraryItems);
  const rarityProfile = buildRarityMap([...(anchors || []), ...(libraryItems || [])]);
  const withTmdbId = anchors.filter(a => a?.ProviderIds?.Tmdb);
  const picked = selectRandomContents(withTmdbId, anchorCount);
  const usedIds = new Set();

  const groups = (await Promise.all(picked.map(async anchor => {
    const raw = await fetchTmdbSimilarForAnchor(anchor, type, apiKey, genreMap);
    // similar + recommendations often overlap: keep one copy of each TMDB id
    const unique = [...new Map(raw.map(c => [c.TmdbId, c])).values()];
    const fresh = unique.filter(c => !libraryIds.has(c.TmdbId) && !usedIds.has(c.TmdbId));
    const recommendations = rankExternalCandidates(anchor, fresh, rarityProfile, perAnchor);
    if (!recommendations.length) return null;
    recommendations.forEach(r => usedIds.add(r.TmdbId));
    return { Name: anchor.Name, Id: anchor.Id, Recommendations: recommendations };
  }))).filter(Boolean);

  return groups;
}
