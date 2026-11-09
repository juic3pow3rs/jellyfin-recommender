// script_updated.js

// ======================
// Initialization
// ======================
const jellyfinloginActionBtn = document.getElementById('loginAction');
const jellyfinLogoutBtn = document.getElementById('logoutAction');
const cleanMemoryBtn = document.getElementById('cleanMemoryBtn');
const recommendationsContainer = document.getElementById('recommendations-container');

// Item types that can be recommended (playlists, collections, channels… are not)
const RECOMMENDABLE_TYPES = ["Audio", "Video", "Book", "Movie", "Series"];

let ContentsToCheck = 3;
let similarsToShow = 6;
let recommendationsShowed = 0;
// Anchor groups in the external "New to your library" section (each a row of similarsToShow cards).
// Costs ~6 TMDB requests per anchor (2 endpoints x 3 pages), throttled in tmdb.js.
const NEW_CONTENT_ANCHORS = 12;

const noImage = "https://placehold.co/200x280/808080/FFFFFF?text=No+Image"

// --- Filter state (persisted): Movies/Shows, Watched only/Whole library, source In library/New (TMDB) ---
const filterBar = document.getElementById('filter-bar');
const newContentContainer = document.getElementById('new-content-container');
const tmdbKeyInput = document.getElementById('tmdbApiKey');
const filterState = {
  type: localStorage.getItem('recommender.type') || 'Movie',
  scope: localStorage.getItem('recommender.scope') || 'watched',
  // "New (TMDB)" used to be the newContent on/off toggle; migrate the old key
  source: localStorage.getItem('recommender.source') || (localStorage.getItem('recommender.newContent') === 'on' ? 'new' : 'library')
};
if (!RECOMMENDABLE_TYPES.includes(filterState.type)) filterState.type = 'Movie';
if (!['watched', 'all'].includes(filterState.scope)) filterState.scope = 'watched';
if (!['library', 'new'].includes(filterState.source)) filterState.source = 'library';
if (tmdbKeyInput) tmdbKeyInput.value = localStorage.getItem('tmdbApiKey') || '';

// --- Pages (views): recommendations / completeness / people / upcoming ---
const PAGES = ['recommendations', 'completeness', 'people', 'upcoming'];
let currentPage = localStorage.getItem('recommender.page') || 'recommendations';
if (!PAGES.includes(currentPage)) currentPage = 'recommendations';

// Function to generate Jellyfin Content detail URL
function makeContentUrl(id) {
  // Safely construct URL, assuming jellyfin object is available and has Server properties
  if (window.jellyfin && window.jellyfin.Server && window.jellyfin.Server.ExternalAddress && window.jellyfin.Server.Id) {
    return `${window.jellyfin.Server.ExternalAddress}/web/#/details?id=${id}&serverId=${window.jellyfin.Server.Id}`;
  }
  // Fallback if jellyfin object is not ready or incomplete
  console.warn("Jellyfin server details not available, cannot create full Content URL.");
  return `javascript:void(0);`; // Placeholder or error indicator
}

// Function to Create "Because you watched" Container
function createBecauseYouWatchedContainer(Content) {
  const container = document.createElement('div');
  container.classList.add('because-you-watched-container');

  const title = document.createElement('h2');
  title.classList.add('because-you-watched-title');
  // In "Whole library" scope the anchors are not necessarily watched
  title.textContent = filterState.scope === 'all' ? 'Similar to ' : 'Because you watched ';

  // Make an "a" link to the Content, using makeContentUrl function and append to the title element
  const ContentLink = document.createElement('a');
  ContentLink.href = makeContentUrl(Content.Id);
  ContentLink.textContent = Content.Name;
  ContentLink.target = "_blank"; // Open in new tab
  ContentLink.classList.add('Content-link');
  // Add aria-label for accessibility
  ContentLink.setAttribute('aria-label', `View ${Content.Name} on Jellyfin`);

  title.appendChild(ContentLink);
  container.appendChild(title);

  const ContentGrid = document.createElement('div');
  ContentGrid.classList.add('Content-grid');
  container.appendChild(ContentGrid);

  return { container, ContentGrid };
}

// Function to create a single Content card
function createContentCard(Content) {
  const ContentCard = document.createElement('div');
  ContentCard.classList.add('Content-card');
  ContentCard.setAttribute('data-Content-id', Content.Id); // Useful for event listeners later

  // Use a fallback image if Content.ImageUrl is not provided or invalid
  const imageUrl = Content.ImageUrl || noImage;

  // Built with DOM nodes: names come from server metadata and must never be parsed as HTML
  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = `${Content.Name} cover`;
  img.onerror = () => { img.onerror = null; img.src = noImage; };

  const info = document.createElement('div');
  info.classList.add('Content-info');
  const addLine = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.classList.add(className);
    el.textContent = text;
    info.appendChild(el);
  };
  addLine('h3', null, Content.Name);
  // External/TMDB cards often have no score/rating (e.g. unaired seasons): show the line only when present
  if (typeof Content.similarityScore === 'number') addLine('p', 'rating', `Score: ${Content.similarityScore.toFixed(0)}%`);
  if (typeof Content.CommunityRating === 'number') addLine('p', 'rating', `Community Rating: ${Content.CommunityRating.toFixed(2)}`);
  addLine('p', 'year', `Year: ${Content.ProductionYear || 'N/A'}`);
  // External "upcoming & missing" cards carry a note (release date, "with <actor>", …)
  if (Content.note) addLine('p', 'year', Content.note);

  ContentCard.append(img, info);

  // External (TMDB) items open their TMDB page; library items open the Jellyfin details page
  const contentUrl = Content.ExternalUrl || makeContentUrl(Content.Id);

  // Make the Content card clickable to open the Content details in Jellyfin
  ContentCard.addEventListener('click', () => {
    window.open(contentUrl, '_blank');
  });

  // Add keyboard accessibility for card click
  ContentCard.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); // Prevent default scroll or action
      window.open(contentUrl, '_blank');
    }
  });
  ContentCard.setAttribute('tabindex', '0'); // Make it focusable
  // Announced as a link to the item in Jellyfin (Enter/Space open it, see above)
  ContentCard.setAttribute('role', 'link');
  ContentCard.setAttribute('aria-label', `${Content.Name} — open in ${Content.ExternalUrl ? 'TMDB' : 'Jellyfin'}`);

  return ContentCard;
}

// Function to display recommendations
// append: a later batch (infinite scroll) — an empty batch then adds nothing instead of replacing the page
// container: where to render (defaults to the main container; the "new to library" section has its own)
function displayRecommendations(recommendations, { append = false, container = recommendationsContainer, emptyMessage = 'No recommendations found. Try watching more Contents!' } = {}) {
  const loadingMessage = container.querySelector('.loading-message');
  if (loadingMessage) {
    loadingMessage.remove(); // Remove the loading message
  }

  if (!recommendations || recommendations.length === 0) {
    if (append) return;
    // Added after the taste section instead of replacing the whole container (which erased that section too)
    const message = document.createElement('div');
    message.className = 'no-results-message';
    message.textContent = emptyMessage;
    container.appendChild(message);
    return;
  }

  recommendations.forEach(watchedContentData => {
    // Ensure watchedContentData and watchedContentData.Recommendations are valid
    if (!watchedContentData || !watchedContentData.Recommendations) return;

    const { container: groupContainer, ContentGrid } = createBecauseYouWatchedContainer(watchedContentData);
    watchedContentData.Recommendations.forEach(Content => {
      const ContentCardElement = createContentCard(Content);
      ContentGrid.appendChild(ContentCardElement);
    });
    container.appendChild(groupContainer);
  });
}

function createBasedOnTastesContainer(recommendations) {
  const tasteRecommendationsContainer = document.getElementById('taste-recommendations-container');
  if (!tasteRecommendationsContainer) {
    console.error("Taste recommendations container not found.");
    return;
  }

  // tasteRecommendationsContainer.innerHTML = ''; // Clear previous recommendations

  if (!recommendations || recommendations.length === 0) {
    tasteRecommendationsContainer.innerHTML = '<div class="no-results-message">No taste-based recommendations found.</div>';
    return;
  }

  let ContentGrid;
  if(tasteRecommendationsContainer.childElementCount == 0) {
    const title = document.createElement('h2');
    title.classList.add('because-you-watched-title');
    title.textContent = filterState.scope === 'all' ? 'Based on Your Whole Library' : 'Based on Your General Watched Content';
    tasteRecommendationsContainer.appendChild(title);

    ContentGrid = document.createElement('div');
    ContentGrid.classList.add('Content-grid');
    tasteRecommendationsContainer.appendChild(ContentGrid);


    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.classList.add('load-more-btn');
    loadMoreBtn.textContent = 'Load More';
    loadMoreBtn.addEventListener('click', async () => {
      if (recommendationsShowed < (window.recommendations?.length ?? 0)) {
        createBasedOnTastesContainer(window.recommendations.slice(recommendationsShowed, recommendationsShowed + similarsToShow));
      } else {
        loadMoreBtn.style.display = 'none';
      }
    });
    tasteRecommendationsContainer.appendChild(loadMoreBtn);
  } else {
    ContentGrid = tasteRecommendationsContainer.querySelector('.Content-grid');
  }
  recommendations.forEach(Content => {
    const ContentCardElement = createContentCard(Content);
    ContentGrid.appendChild(ContentCardElement);
    recommendationsShowed++;
  });
}

function displayBasedOnYourTastes(recommendations) {
  createBasedOnTastesContainer(recommendations);
}

// Removes only the recommendation sections: the filter bar and the named container elements stay in place
function clearRecommendationSections() {
  recommendationsContainer
    .querySelectorAll('.because-you-watched-container:not(#taste-recommendations-container):not(#new-content-container), .no-results-message, .loading-message')
    .forEach(el => el.remove());
  for (const id of ['taste-recommendations-container', 'new-content-container', 'completeness-container', 'people-container', 'upcoming-container']) {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.style.display = ''; }
  }
}

function showRecommendationsMessage(text) {
  clearRecommendationSections();
  const message = document.createElement('div');
  message.className = 'no-results-message';
  message.textContent = text;
  recommendationsContainer.appendChild(message);
}

// Jellyfin Initialization and Login Logic
// explicitLogin: the Connect button, where typed credentials win over the saved session token
function InitializeJellyfin(explicitLogin = false) {
  const server = document.getElementById("Server").value.trim(); // Trim whitespace
  const username = document.getElementById("Username").value.trim();
  const password = document.getElementById("Password").value.trim();
  // The Jellyfin class keeps the session token after a login; with it, no password is needed
  const hasSavedSession = typeof Jellyfin !== 'undefined' && typeof Jellyfin.getSavedAuth === 'function' && !!Jellyfin.getSavedAuth(server);

  if (!server || (!(username && password) && !hasSavedSession)) {
      showWindow("loginBox"); // Show login if fields are empty
      document.getElementById('loginErrorMessage').innerText = "Please fill in all server details.";
      document.getElementById("loginBtn").setAttribute('logged-in', 'false');
      return;
  }

  // Disable login button temporarily to prevent multiple clicks
  jellyfinloginActionBtn.setAttribute('inactive', 'true');

  // Use window.jellyfin to ensure it's globally accessible if Jellyfin class is loaded
  if (typeof Jellyfin === 'undefined') {
      console.error("Jellyfin class not loaded. Ensure jellyfin.js is correctly included and deferred.");
      showWindow("loginBox");
      document.getElementById('loginErrorMessage').innerText = "Jellyfin library failed to load.";
      jellyfinloginActionBtn.removeAttribute('inactive');
      return;
  }

  window.jellyfin = new Jellyfin(server, username, password, {
    onLoginError: (err, response) => {
      // A password the server rejects is useless: never keep it (older versions saved it)
      if (response?.status === 401) forgetSavedPassword();
      const message = (!response && err?.message) || "Authentication failed. Please check your credentials.";
      showWindow("loginBox"); // Ensure login box is visible on error
      document.getElementById('loginErrorMessage').innerText = message;
      document.getElementById("loginBtn").setAttribute('logged-in', 'false');
      jellyfinloginActionBtn.removeAttribute('inactive');
    },
    onServerSetupError: () => {
      const message = "Server is offline. Please check the address.";
      showWindow("loginBox");
      document.getElementById('loginErrorMessage').innerText = message;
      document.getElementById("loginBtn").setAttribute('logged-in', 'false');
      jellyfinloginActionBtn.removeAttribute('inactive');
    },
    onLoginSuccess: () => {
      // Logged in again (e.g. another account) after recommendations were shown: start over with the new session
      if (window.Played) { location.reload(); return; }
      hideWindow("loginBox"); // Hide login box on successful login
      // The Jellyfin class saved the session token: the password is no longer needed anywhere
      forgetSavedPassword();
      jellyfinloginActionBtn.removeAttribute('inactive');
      if (jellyfinLogoutBtn) jellyfinLogoutBtn.hidden = false;
      document.getElementById("loginBtn").setAttribute('logged-in', 'true');
      if (filterBar) { filterBar.hidden = false; syncToggleButtons(); switchPage(currentPage, false); } // load happens in onLibraryLoad
      // Clear any previous error messages
      document.getElementById('loginErrorMessage').innerText = "";
      // Trigger library load after successful login
      if (window.jellyfin.onLibraryLoad) {
          window.jellyfin.IncludeItemsTypes = ["Audio", "Video", "Book", "Movie", "Series", ]
          window.jellyfin.onLibraryLoad(); // Call the callback if it exists
      }
    },
    onLibraryLoad: async () => { // This callback is directly handled by the Jellyfin class when libraries are ready
      // Fetch and display the current page when libraries are loaded
      await loadCurrentPage();
    },
    onSearchFinish: () => {
      // This callback might be for search results, not directly used here for recommendations.
    }
  }, /* needsUserData: refresh watched status even when the library comes from the cache */ true, { preferCredentials: explicitLogin });
}

// Event listener for the Login/Connect button
jellyfinloginActionBtn.addEventListener('click', () => {
    InitializeJellyfin(true); // Call initialization logic on click
});

// Ends the Jellyfin session (the token stops working) and starts over at the login window
jellyfinLogoutBtn?.addEventListener('click', async () => {
  if (window.jellyfin?.logout) await window.jellyfin.logout();
  location.reload();
});

// Event listener for cleaning memory
cleanMemoryBtn.addEventListener('click', async () => {
  if (!confirm('Clean saved memory? The page memory and the Jellyfin library cache will be erased.')) return;
  // Also works before logging in (there is no jellyfin instance then)
  try { await window.memory?.reset?.(); } catch (error) { console.warn('Could not reset page memory:', error); }
  if (window.jellyfin?.cleanDb) window.jellyfin.cleanDb(); // reloads the page
  else location.reload();
});

// ======================
// Storage Functions
// ======================
function saveFieldsToStorage() {
  const serverInput = document.getElementById("Server");
  let serverValue = serverInput.value.trim();
  // Remove trailing slash if present
  if (serverValue.endsWith("/")) {
    serverValue = serverValue.slice(0, -1);
    serverInput.value = serverValue; // Update input field
  }
  // Only the server address is saved. The login is kept as a session token by the Jellyfin class
  // (localStorage "jellyfinAuth"); username and password are never stored.
  localStorage.setItem("server", serverValue);
}

function loadFieldsFromStorage() {
  const server = localStorage.getItem("server");
  // Saved by older versions: used one last time to get a session token, then removed (forgetSavedPassword)
  const username = localStorage.getItem("username");
  const password = localStorage.getItem("password");

  if (server) document.getElementById("Server").value = server;
  if (username) document.getElementById("Username").value = username;
  if (password) document.getElementById("Password").value = password;
}

// Removes the username/password older versions kept in localStorage and (through the [save] attribute the login
// fields no longer have) in the pageMemory record. The session token makes them unnecessary.
function forgetSavedPassword() {
  localStorage.removeItem("password");
  localStorage.removeItem("username");
  const passwordInput = document.getElementById("Password");
  if (passwordInput) passwordInput.value = "";
  // Rewrites the pageMemory record without the login fields (pageMemory only saves after its restore finished)
  try { window.memory?.savePageInfo?.(); } catch (e) { /* not ready yet: the next save rewrites the record */ }
}

// Load fields on page load
loadFieldsFromStorage();
// Save fields whenever they change
document.getElementById("Server").addEventListener("change", saveFieldsToStorage);
document.getElementById("Username").addEventListener("change", saveFieldsToStorage);
document.getElementById("Password").addEventListener("change", saveFieldsToStorage);

// Initialize Jellyfin connection on page load if credentials exist
document.addEventListener('DOMContentLoaded', () => {
    const server = localStorage.getItem("server");
    const username = localStorage.getItem("username");
    const password = localStorage.getItem("password");

    // Connect when there is a saved session token, or credentials saved by an older version
    const hasSavedSession = typeof Jellyfin !== 'undefined' && typeof Jellyfin.getSavedAuth === 'function' && !!Jellyfin.getSavedAuth(server);
    if (server && ((username && password) || hasSavedSession)) {
        // If login box is hidden (meaning credentials were saved), attempt login
        if (document.getElementById("loginBtn").getAttribute('logged-in') === 'false') {
             InitializeJellyfin();
        }
    } else {
        // If credentials are not saved, ensure login box is visible
        showWindow('loginBox');
    }

    // Initialize memory management
    if (typeof pageMemory !== 'undefined') {
        window.memory = new pageMemory();
        // Add a listener for when memory is empty to potentially start something,
        // but here we expect it to be initialized by Jellyfin's library load.
        window.memory.init();
    } else {
        console.error("pageMemory class not loaded. Ensure memory scripts are included.");
    }
});


// --- Data Fetching Functions ---

// Generic function to get items from Jellyfin library
const getList = async (Library, PlayStatus, type = filterState.type) => {
  // Ensure jellyfin instance is ready
  if (!window.jellyfin || !window.jellyfin.isAuthenticated) {
      console.warn("Jellyfin not authenticated or initialized. Cannot fetch list.");
      return []; // Return empty array if Jellyfin is not ready
  }

  // window.jellyfin.searchParams.Library = Library || 'Filmes'; // Default to 'Filmes'
  window.jellyfin.searchParams.page = 1;
  window.jellyfin.searchParams.offset = 0;
  window.jellyfin.searchParams.limit = 999999; // Fetch all items
  window.jellyfin.searchParams.hasNextPage = true;
  window.jellyfin.searchParams.IncludePeople = false; // Assuming we don't need people data for recommendations

  if (PlayStatus === 'Played') {
    window.jellyfin.searchParams.PlayedOnly = true;
    window.jellyfin.searchParams.UnplayedOnly = false;
  } else if (PlayStatus === 'Unplayed') {
    window.jellyfin.searchParams.PlayedOnly = false;
    window.jellyfin.searchParams.UnplayedOnly = true;
  } else { // 'All': the whole library, regardless of play status
    window.jellyfin.searchParams.PlayedOnly = false;
    window.jellyfin.searchParams.UnplayedOnly = false;
  }

  try {
    const items = await window.jellyfin.searchItems('', '', {});
    // The Jellyfin.js searchItems function returns a promise that resolves with the item list.
    // The Movies/Shows toggle is applied here and not at load time: the library cache is shared with CoverMaker,
    // and loading fewer types there would make each app reload the other's cache on every visit.
    // type = null skips the filter (the "Upcoming & missing" section looks at movies AND shows).
    return type ? filterByContentType(items, type) : (items || []); // Ensure we always return an array
  } catch (error) {
    console.error(`Error fetching ${PlayStatus || 'all'} items from library '${Library}':`, error);
    return []; // Return empty array on error
  }
};

const getPlayed = async Library => {
  return getList(Library, 'Played');
};
const getUnplayed = async Library => {
  return getList(Library, 'Unplayed');
}
const getAll = async Library => {
  return getList(Library, 'All');
}

// The two lists the recommender works with, according to the scope toggle:
// "watched" = played items as anchors, unplayed as candidates (never re-recommends what was watched);
// "all" = the whole library as both anchors and candidates
const getScopeLists = async () => {
  if (filterState.scope === 'all') {
    window.allItems ??= await getAll();
    window.Played = window.allItems;
    window.Unplayed = window.allItems;
    window.watched = window.allItems;
    window.unwatched = window.allItems;
    return { base: window.allItems, candidates: window.allItems, includePlayed: true };
  }
  window.Played ??= await getPlayed();
  window.Unplayed ??= await getUnplayed();
  window.watched = window.Played;
  window.unwatched = window.Unplayed;
  return { base: window.Played, candidates: window.Unplayed, includePlayed: false };
};

// Main function to get suggestions using findSimilar
const getSugestions = async (numberOfRandomWatchedContents = 10, numberOfSimilarContentsPerWatched = 7, useSingleAppearance = true) => {
  try {
    const { base: watchedContents, candidates: unwatchedContents, includePlayed } = await getScopeLists();

    if (!watchedContents || watchedContents.length === 0) {
        console.warn("No base Contents found. Cannot generate recommendations.");
        showRecommendationsMessage(filterState.scope === 'all'
          ? 'The library has no Contents of this type.'
          : 'Watch some Contents to get recommendations!');
        return [];
    }
    if (!unwatchedContents || unwatchedContents.length === 0) {
        console.warn("No candidate Contents found. Cannot generate recommendations.");
        showRecommendationsMessage('No unwatched Contents available.');
        return [];
    }

    // Assuming findSimilar is correctly imported and available
    if (typeof findSimilar !== 'function') {
        console.error("findSimilar function not available. Ensure findSimilar_updated.js is loaded.");
        return [];
    }

    const recommendations = findSimilar(watchedContents, unwatchedContents, numberOfRandomWatchedContents, numberOfSimilarContentsPerWatched, useSingleAppearance, includePlayed);
    return recommendations;

  } catch (error) {
    console.error("Error in getSugestions:", error);
    return []; // Return empty array on error
  }
};

const getSugestionsBasedOnYourTastes = async (isStrict = false) => {
  const { base, candidates } = await getScopeLists();
  window.watched = base;        // Base items (watched, or the whole library in "all" scope)
  window.unwatched = candidates; // Content pool
  
  // window.searchEngine = new SearchEngine();
  
  // return window.searchEngine.search(window.unwatched, window.profileQueries, [
  //   { fields: ['CommunityRating'], type: 'desc' },
  //   { fields: ['ProductionYear'], type: 'desc' }
  // ])
  if (!window.watched || window.watched.length === 0) {
    console.warn("No watched Contents found for taste-based recommendations.");
    return [];
  }
  if (!window.unwatched || window.unwatched.length === 0) {
    console.warn("No unwatched Contents found for taste-based recommendations.");
    return [];
  }

  if (typeof getTasteBasedContentfindSimilar !== 'function') {
    console.error("getTasteBasedContentfindSimilar function not available. Ensure findSimilar.js is loaded.");
    return [];
  }

  const tasteRecommendations = await getTasteBasedContentfindSimilar(window.watched, window.unwatched, 6, isStrict, true); // Limit to 10 for taste-based
  return tasteRecommendations;
}

async function updateTestesSugestions(isStrict) {
  try {
    displayBasedOnYourTastes(await getSugestionsBasedOnYourTastes(isStrict))
  } catch (error) {
    console.error("Error fetching taste-based recommendations:", error);
    const tasteRecommendationsContainer = document.getElementById('taste-recommendations-container');
    if (tasteRecommendationsContainer) {
      tasteRecommendationsContainer.innerHTML = '<div class="no-results-message">Error loading taste-based recommendations.</div>';
    }
  }
}

async function updateRecommendations() {
  try {
    displayRecommendations(await getSugestions(ContentsToCheck, similarsToShow, false))
  } catch (error) {
    console.error("Error fetching recommendations:", error);
    showRecommendationsMessage('Error loading recommendations.');
  }
}

// ======================
// Filter Toggles (Movies/Shows, Watched only/Whole library)
// ======================
function syncToggleButtons() {
  filterBar.querySelectorAll('.toggle-btn').forEach(btn => {
    const active = (btn.dataset.type && btn.dataset.type === filterState.type) ||
                   (btn.dataset.scope && btn.dataset.scope === filterState.scope) ||
                   (btn.dataset.source && btn.dataset.source === filterState.source);
    btn.classList.toggle('active', !!active);
    btn.setAttribute('aria-pressed', String(!!active));
  });
}

filterBar.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.type) filterState.type = btn.dataset.type;
    if (btn.dataset.scope) filterState.scope = btn.dataset.scope;
    if (btn.dataset.source) filterState.source = btn.dataset.source;
    localStorage.setItem('recommender.type', filterState.type);
    localStorage.setItem('recommender.scope', filterState.scope);
    localStorage.setItem('recommender.source', filterState.source);
    syncToggleButtons();
    // Before login nothing is loaded yet; the saved choice is applied on the next login
    if (!window.jellyfin?.isAuthenticated) return;
    await refreshRecommendations();
  });
});
syncToggleButtons();

// The TMDB key is saved on change; the current page is recomputed when it uses TMDB
tmdbKeyInput?.addEventListener('change', () => {
  localStorage.setItem('tmdbApiKey', tmdbKeyInput.value.trim());
  if (window.jellyfin?.isAuthenticated) refreshRecommendations();
});

// Shuffle: reset the anchor memory and recompute, so different anchor movies/shows are picked
const shuffleBtn = document.getElementById('shuffleBtn');
let shuffling = false;
shuffleBtn?.addEventListener('click', async () => {
  if (shuffling || !window.jellyfin?.isAuthenticated) return;
  shuffling = true;
  shuffleBtn.setAttribute('inactive', 'true');
  try {
    await refreshRecommendations();
  } finally {
    shuffling = false;
    shuffleBtn.removeAttribute('inactive');
  }
});

// ======================
// Pages (views): recommendations / collection completeness / actors & directors / upcoming
// ======================
function switchPage(page, load = true) {
  if (!PAGES.includes(page)) page = 'recommendations';
  currentPage = page;
  localStorage.setItem('recommender.page', page);
  document.querySelectorAll('#pageNav .page-btn').forEach(b => {
    const active = b.dataset.page === page;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.page').forEach(p => { p.hidden = p.dataset.page !== page; });
  // Only the toggles relevant to the current page are shown in the filter bar
  filterBar.querySelectorAll('[data-group]').forEach(g => {
    g.hidden = !(g.dataset.group === 'all' || g.dataset.group === page);
  });
  if (load && window.jellyfin?.isAuthenticated) loadCurrentPage();
}

document.querySelectorAll('#pageNav .page-btn').forEach(b => {
  b.addEventListener('click', () => switchPage(b.dataset.page));
});
switchPage(currentPage);

async function loadCurrentPage() {
  if (currentPage === 'recommendations') await loadRecommendationsPage();
  else if (currentPage === 'completeness') await loadCompletenessPage();
  else if (currentPage === 'people') await loadPeoplePage();
  else await loadUpcomingPage();
}

// Recomputes the current page from scratch with the current type/scope/source
async function refreshRecommendations() {
  resetRecommendationState(); // findSimilar.js: anchors/candidates already used
  recommendationsShowed = 0;
  for (const key of ['watched', 'unwatched', 'Played', 'Unplayed', 'allItems', 'recommendations', 'tasteProfile', 'profileQueries', 'searchEngine']) {
    delete window[key];
  }
  clearRecommendationSections();
  await loadCurrentPage();
}

function hintIn(container, text) {
  const el = document.createElement('div');
  el.className = 'no-results-message';
  el.textContent = text;
  container.appendChild(el);
}

function pageTitle(container, text) {
  const h = document.createElement('h2');
  h.classList.add('because-you-watched-title');
  h.textContent = text;
  container.appendChild(h);
}

function renderCardsGrid(container, heading, items) {
  if (heading) {
    const h = document.createElement('h3');
    h.classList.add('upcoming-subheading');
    h.textContent = heading;
    container.appendChild(h);
  }
  if (!items || !items.length) {
    hintIn(container, 'Nothing found for the current selection.');
    return;
  }
  const grid = document.createElement('div');
  grid.classList.add('Content-grid');
  items.forEach(item => grid.appendChild(createContentCard(item)));
  container.appendChild(grid);
}

// Returns the saved TMDB key, or shows a hint in the container and returns null
function tmdbKeyOrHint(container) {
  const apiKey = localStorage.getItem('tmdbApiKey') || '';
  if (!apiKey) {
    hintIn(container, 'Enter your TMDB API key in the bar above to use this view.');
    return null;
  }
  // Fail fast on the wrong kind of key: the v4 Read Access Token (JWT) instead of the v3 API Key (32 hex chars)
  if (typeof tmdbKeyLooksValid === 'function' && !tmdbKeyLooksValid(apiKey)) {
    hintIn(container, 'That does not look like a TMDB v3 API key (32 hex characters). Use the "API Key" from themoviedb.org/settings/api, not the v4 "Read Access Token".');
    return null;
  }
  return apiKey;
}

// --- Page 1: recommendations — source "In library" (taste + because-you-watched) or "New (TMDB)" ---
async function loadRecommendationsPage() {
  const loading = document.createElement('div');
  loading.className = 'loading-message';
  loading.textContent = 'Loading recommendations...';
  recommendationsContainer.appendChild(loading);
  const tasteContainer = document.getElementById('taste-recommendations-container');
  if (filterState.source === 'new') {
    if (tasteContainer) tasteContainer.style.display = 'none';
    if (newContentContainer) newContentContainer.style.display = '';
    await updateNewContent();
  } else {
    if (tasteContainer) tasteContainer.style.display = '';
    if (newContentContainer) newContentContainer.style.display = 'none';
    await updateTestesSugestions(true);
    await updateRecommendations();
  }
}

// "New to your library": recommendations for items NOT in the Jellyfin library yet (via TMDB, tmdb.js)
async function updateNewContent() {
  if (!newContentContainer) return;
  newContentContainer.innerHTML = '';
  recommendationsContainer.querySelector('.loading-message')?.remove();
  const apiKey = tmdbKeyOrHint(newContentContainer);
  if (!apiKey) return;

  try {
    const { base } = await getScopeLists();
    const libraryItems = await getAll(); // everything of this type, to exclude what the user already has
    const { groups, stats } = await getExternalRecommendations(base, libraryItems, filterState.type, apiKey, {
      anchorCount: NEW_CONTENT_ANCHORS,
      perAnchor: similarsToShow
    });
    console.info('[tmdb] anchors:', stats.anchors, '| with TMDB id:', stats.anchorsWithId, '| fetched:', stats.fetched, '| already in library:', stats.excluded, '| groups:', stats.groups);
    pageTitle(newContentContainer, 'New to your library (not in Jellyfin yet)');
    if (!groups.length) {
      let reason = 'no similar title scored high enough for the current anchors.';
      if (stats.anchorsWithId === 0) reason = 'none of the base items could be matched on TMDB (no TMDB id, no title match).';
      else if (stats.fetched === 0) reason = 'TMDB returned nothing for the anchors — see the browser console.';
      else if (stats.excluded >= stats.fetched && stats.fetched > 0) reason = 'every similar title TMDB suggests is already in your library.';
      displayRecommendations([], { container: newContentContainer, emptyMessage: `New to your library: ${reason}` });
      return;
    }
    displayRecommendations(groups, { container: newContentContainer });
  } catch (error) {
    console.error('Error fetching external recommendations:', error);
    // error.message carries the TMDB status (e.g. "TMDB responded 401"), never the key
    hintIn(newContentContainer, `Error loading new-content recommendations (${error.message}). Check the TMDB API key and your network.`);
  }
}

// --- Page 2: collection completeness — whole library; Shows => missing seasons, Movies => sequel parts ---
async function loadCompletenessPage() {
  const container = document.getElementById('completeness-container');
  if (!container) return;
  container.innerHTML = '';
  const apiKey = tmdbKeyOrHint(container);
  if (!apiKey) return;
  try {
    const all = await getList(null, 'All', null); // the whole library, both types
    const ofType = filterByContentType(all, filterState.type);
    if (filterState.type === 'Series') {
      const ownedSeasons = await getOwnedSeasonsBySeries();
      const items = await getMissingSeasons(ofType, ownedSeasons, apiKey);
      pageTitle(container, 'Collection completeness — your shows');
      renderCardsGrid(container, 'Missing / upcoming seasons of your shows', items);
    } else {
      const items = await getMissingSequels(ofType, all, apiKey);
      pageTitle(container, 'Collection completeness — your movies');
      renderCardsGrid(container, 'Sequels / collection parts not in your library', items);
    }
  } catch (error) {
    console.error('Error loading collection completeness:', error);
    hintIn(container, `Error loading collection completeness (${error.message}).`);
  }
}

// --- Page 3: favorite actors & directors — whole library of the selected type ---
async function loadPeoplePage() {
  const container = document.getElementById('people-container');
  if (!container) return;
  container.innerHTML = '';
  const apiKey = tmdbKeyOrHint(container);
  if (!apiKey) return;
  try {
    const all = await getList(null, 'All', null);
    const ofType = filterByContentType(all, filterState.type);
    let anchors = ofType.filter(i => i?.UserData?.Played);
    if (!anchors.length) anchors = ofType; // nothing played of this type: fall back to the whole type
    const { actors, directors } = await getFavoritePeopleWorks(anchors, all, filterState.type, apiKey);
    pageTitle(container, filterState.type === 'Series' ? 'Your favorite actors & directors — shows' : 'Your favorite actors & directors — movies');
    renderCardsGrid(container, 'More from your favorite actors', actors);
    renderCardsGrid(container, 'More from your favorite directors', directors);
  } catch (error) {
    console.error('Error loading favorite people:', error);
    hintIn(container, `Error loading actors & directors (${error.message}).`);
  }
}

// --- Page 4: upcoming releases feed — future-dated items only, whole library of the selected type ---
async function loadUpcomingPage() {
  const container = document.getElementById('upcoming-container');
  if (!container) return;
  container.innerHTML = '';
  const apiKey = tmdbKeyOrHint(container);
  if (!apiKey) return;
  try {
    const all = await getList(null, 'All', null);
    const ofType = filterByContentType(all, filterState.type);
    const watched = ofType.filter(i => i?.UserData?.Played);
    const ownedSeasons = filterState.type === 'Series' ? await getOwnedSeasonsBySeries() : undefined;
    const items = await getUpcomingReleases({ items: ofType, watchedItems: watched, libraryItems: all, ownedSeasons, type: filterState.type, apiKey });
    pageTitle(container, 'Upcoming releases');
    renderCardsGrid(container, 'Releases with a future date', items);
  } catch (error) {
    console.error('Error loading upcoming releases:', error);
    hintIn(container, `Error loading upcoming releases (${error.message}).`);
  }
}

// ======================
// Jellyfin: owned seasons per series (one raw API call)
// ======================
async function getOwnedSeasonsBySeries() {
  const jf = window.jellyfin;
  const url = `${jf.Server.Address}/Users/${jf.User.Id}/Items?IncludeItemTypes=Season&Recursive=true&Fields=ParentId,IndexNumber&Limit=999999`;
  const res = await fetch(url, { headers: { authorization: jf.headers.authorization } });
  if (!res.ok) throw new Error(`Jellyfin responded ${res.status}`);
  const data = await res.json();
  const map = new Map();
  for (const s of data.Items || []) {
    if (!s.ParentId || typeof s.IndexNumber !== 'number') continue;
    if (!map.has(s.ParentId)) map.set(s.ParentId, new Set());
    map.get(s.ParentId).add(s.IndexNumber);
  }
  return map;
}
