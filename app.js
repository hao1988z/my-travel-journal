let cfg = window.TRAVEL_JOURNAL_CONFIG || {};
let missingConfig = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_PROJECT_REF");
let client = null;
let bucket = cfg.PHOTO_BUCKET || "trip-photos";
let authRedirectUrl = cfg.AUTH_REDIRECT_URL || new URL("./", window.location.href).toString();
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const SIGNED_URL_CACHE_TTL_MS = 55 * 60 * 1000;
const SIGNED_URL_BATCH_SIZE = 100;
const MAX_UPLOAD_FILES = 200;
const GUEST_UPLOAD_BATCH_SIZE = 25;
const SHARED_PHOTO_PAGE_SIZE = 36;

const state = {
  user: null,
  trips: [],
  diaries: [],
  photoUrls: new Map(),
  photoUrlCache: new Map(),
  photoUrlRequests: new Map(),
  markers: new Map(),
  editingTrip: null,
  isSavingTrip: false,
  selectedPhotos: [],
  photoPreviewUrls: [],
  pendingGuestUpload: null,
  pendingGuestPreviewUrls: [],
  pendingEmail: "",
  resendTimer: null,
  sharedMode: false,
  sharedTrip: null,
  diaryLoadError: "",
  schemaMode: "modern",
  storageBucket: bucket,
  viewerPhotos: [],
  viewerIndex: 0,
  viewerZoom: 1,
  selectedDownloadIndexes: new Set(),
  sharedPhotoVisibleCount: SHARED_PHOTO_PAGE_SIZE,
  selectedDeleteIndexes: new Set(),
  locationResults: [],
  stopLocationResults: [],
  stopSchemaAvailable: false,
  stopSchemaError: "",
  selectedStopId: null
};

const $ = (id) => document.getElementById(id);

let map;
let detailMap;
let detailMarker;
let detailStopMarkers = [];
let detailRouteLine;

boot();

function applyConfig() {
  cfg = window.TRAVEL_JOURNAL_CONFIG || {};
  missingConfig = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_PROJECT_REF");
  if (missingConfig || typeof supabase === "undefined") {
    client = null;
    return false;
  }

  client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  bucket = cfg.PHOTO_BUCKET || "trip-photos";
  authRedirectUrl = cfg.AUTH_REDIRECT_URL || new URL("./", window.location.href).toString();
  if (state) state.storageBucket = bucket;
  return true;
}

async function ensureConfig() {
  if (applyConfig()) return true;

  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `./config.js?runtime=${Date.now()}`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  } catch (error) {
    console.error("[config.js]", error);
  }

  return applyConfig();
}

async function boot() {
  await ensureConfig();
  initMap();
  bindEvents();

  const shareToken = new URLSearchParams(location.search).get("share");
  if (shareToken) {
    state.sharedMode = true;
    try {
      await loadSharedTrip(shareToken);
    } catch (error) {
      console.error("[loadSharedTrip]", error);
      $("tripList").innerHTML = `<div class="empty">分享旅程目前無法載入，請稍後再試。</div>`;
    }
    return;
  }

  if (missingConfig) {
    $("setupNote").textContent = "請先複製 config.example.js 成 config.js，填入 Supabase URL 和 anon key。";
    return;
  }

  const { data, error: sessionError } = await client.auth.getSession();
  if (sessionError) {
    console.error("[getSession]", sessionError);
    toast("登入狀態讀取失敗，請重新整理");
  }
  state.user = data.session?.user || null;
  setSessionUI();

  client.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user || null;
    setSessionUI();
    if (state.user) loadTrips();
  });

  if (state.user) await loadTrips();
}

function bindEvents() {
  $("authForm").addEventListener("submit", signIn);
  $("signUpBtn").addEventListener("click", signUp);
  setupResendButton();
  $("signOutBtn").addEventListener("click", signOut);
  $("homeDiaryBtn").addEventListener("click", openDiaryLibrary);
  $("homeNewTripBtn").addEventListener("click", () => openTripDialog());
  $("createGroupBtn")?.addEventListener("click", openGroupDialog);
  $("closeDialogBtn").addEventListener("click", closeTripDialog);
  $("closeDrawerBtn").addEventListener("click", closeDrawer);
  $("backToTripsBtn").addEventListener("click", closeTripDetail);
  $("detailEditBtn").addEventListener("click", () => {
    if (state.editingTrip) openTripDialog(state.editingTrip);
  });
  $("detailEditExpensesBtn").addEventListener("click", () => {
    if (state.editingTrip) openTripDialog(state.editingTrip);
  });
  $("detailDownloadBtn").addEventListener("click", () => {
    if (state.editingTrip) downloadCover(state.editingTrip, state.sharedMode);
  });
  $("detailSetCoverBtn").addEventListener("click", openCoverEditor);
  $("photoViewerCloseBtn").addEventListener("click", closePhotoViewer);
  $("coverPickerCloseBtn").addEventListener("click", closeCoverPicker);
  $("coverPickerGrid").addEventListener("click", handleCoverPickerClick);
  $("photoViewerPrevBtn").addEventListener("click", () => changePhotoViewer(-1));
  $("photoViewerNextBtn").addEventListener("click", () => changePhotoViewer(1));
  $("photoViewerZoomOutBtn").addEventListener("click", () => changeViewerZoom(-0.25));
  $("photoViewerZoomResetBtn").addEventListener("click", resetViewerZoom);
  $("photoViewerZoomInBtn").addEventListener("click", () => changeViewerZoom(0.25));
  $("photoViewerImage").addEventListener("click", toggleViewerZoom);
  $("photoViewerStage").addEventListener("wheel", handleViewerWheel, { passive: false });
  $("photoViewerDownloadBtn").addEventListener("click", downloadViewerPhoto);
  $("photoViewerCoverBtn").addEventListener("click", setViewerPhotoAsCover);
  $("photoViewerDeleteBtn").addEventListener("click", deleteViewerPhoto);
 ["detailRecentPhotos", "detailAllPhotos"].forEach((id) => {
   const container = $(id);
   container.addEventListener("click", handleDetailPhotoClick);
   container.addEventListener("keydown", handleDetailPhotoKeydown);
    container.addEventListener("change", handleDetailPhotoSelection);
 });
  $("selectAllDetailPhotosBtn").addEventListener("click", selectAllDetailPhotos);
  $("clearDetailPhotoSelectionBtn").addEventListener("click", clearDetailPhotoSelection);
  $("deleteSelectedDetailPhotosBtn").addEventListener("click", deleteSelectedDetailPhotos);
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => setDetailTab(button.dataset.detailTab));
  });
  $("detailAddStopBtn").addEventListener("click", openStopDialog);
  $("closeStopDialogBtn").addEventListener("click", closeStopDialog);
  $("cancelStopDialogBtn").addEventListener("click", closeStopDialog);
  $("stopForm").addEventListener("submit", saveStop);
  $("searchStopLocationBtn").addEventListener("click", searchStopLocation);
  $("pickStopOnMapBtn").addEventListener("click", pickStopOnMap);
  $("tripForm").addEventListener("submit", saveTrip);
  $("groupForm")?.addEventListener("submit", saveTripGroup);
  $("closeGroupDialogBtn")?.addEventListener("click", closeGroupDialog);
  $("cancelGroupDialogBtn")?.addEventListener("click", closeGroupDialog);
  $("tripDialog").addEventListener("cancel", (event) => {
    if (state.isSavingTrip) event.preventDefault();
  });
  $("deleteTripBtn").addEventListener("click", deleteCurrentTrip);
  $("photoInput").addEventListener("change", handlePhotoInput);
  $("photoPreviewGrid").addEventListener("click", handlePhotoPreviewClick);
  $("searchLocationBtn").addEventListener("click", searchLocation);
  $("locationInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    searchLocation();
  });
  $("searchInput").addEventListener("input", renderTrips);
  document.addEventListener("click", closeTripCardMenus);
  document.querySelectorAll("[data-mobile-nav]").forEach((button) => {
    button.addEventListener("click", () => handleMobileNavigation(button.dataset.mobileNav));
  });
  $("mobileAddBtn").addEventListener("click", () => openActionSheet("quickActionSheet"));
  $("closeQuickActionBtn").addEventListener("click", () => $("quickActionSheet").close());
  $("closeMoreMenuBtn").addEventListener("click", () => $("moreMenuSheet").close());
  $("closeFootprintBtn").addEventListener("click", () => $("footprintSheet").close());
  $("closeStatsBtn").addEventListener("click", () => $("statsSheet").close());
  $("closeDiaryLibraryBtn").addEventListener("click", () => $("diaryLibrarySheet").close());
  $("diaryLibrary").addEventListener("click", handleDiaryLibraryClick);
  $("closeSettingsBtn").addEventListener("click", () => $("settingsSheet").close());
  $("footprintMapBtn").addEventListener("click", () => {
    $("footprintSheet").close();
    handleMobileNavigation("map");
  });
  $("memoryOpenBtn").addEventListener("click", () => {
    const tripId = $("memoryOpenBtn").dataset.tripId;
    if (tripId) openTrip(tripId);
  });
  $("mobileSignOutBtn").addEventListener("click", signOut);
  document.querySelectorAll("[data-quick-action]").forEach((button) => {
    button.addEventListener("click", () => handleQuickAction(button.dataset.quickAction));
  });
  document.querySelectorAll("[data-more-action]").forEach((button) => {
    button.addEventListener("click", () => handleMoreAction(button.dataset.moreAction));
  });
}

function setupResendButton() {
  const actions = $("authForm").querySelector(".auth-buttons");
  if (!actions || $("resendEmailBtn")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "resendEmailBtn";
  button.className = "btn btn-soft";
  button.textContent = "重新寄驗證信";
  button.hidden = true;
  button.addEventListener("click", resendVerificationEmail);
  actions.appendChild(button);
}

function initMap() {
  if (!window.L || !$("map")) {
    console.warn("[initMap] Leaflet or map container is unavailable; continuing without the home map.");
    map = null;
    return false;
  }

  map = L.map("map", { zoomControl: true }).setView([23.6, 121.0], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 19
  }).addTo(map);
  return true;
}

async function signIn(event) {
  event.preventDefault();
  if (!(await ensureConfig())) return toast("請先設定 Supabase config.js");

  const email = $("emailInput").value.trim().toLowerCase();
  const password = $("passwordInput").value;
  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return toast(error.message);
    toast("已登入");
  } catch (error) {
    console.error("[signIn]", error);
    toast("登入失敗，請檢查網路或 Supabase 設定");
  }
}

async function signUp() {
  if (!(await ensureConfig())) return toast("請先設定 Supabase config.js");

  const email = $("emailInput").value.trim().toLowerCase();
  const password = $("passwordInput").value;
  if (!email || password.length < 6) return toast("請輸入 Email 與至少 6 個字元的密碼");

  try {
    const { error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: authRedirectUrl }
    });
    if (error) {
      if (/already|registered|exists/i.test(`${error.code || ""} ${error.message || ""}`)) {
        showResendButton(email);
        return toast("這個 Email 已註冊，請稍後按「重新寄驗證信」");
      }
      return toast(error.message);
    }
    showResendButton(email);
    startResendCooldown();
    toast("帳號已建立，請檢查信箱驗證信");
  } catch (error) {
    console.error("[signUp]", error);
    toast("註冊失敗，請檢查網路或 Supabase 設定");
  }
}

function showResendButton(email) {
  state.pendingEmail = email;
  const button = $("resendEmailBtn");
  if (button) button.hidden = false;
}

function startResendCooldown(seconds = 60) {
  const button = $("resendEmailBtn");
  if (!button) return;
  clearInterval(state.resendTimer);
  let remaining = seconds;
  button.disabled = true;
  button.textContent = `請稍候 ${remaining} 秒`;
  state.resendTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(state.resendTimer);
      state.resendTimer = null;
      button.disabled = false;
      button.textContent = "重新寄驗證信";
      return;
    }
    button.textContent = `請稍候 ${remaining} 秒`;
  }, 1000);
}

async function resendVerificationEmail() {
  if (!(await ensureConfig())) return toast("請先設定 Supabase config.js");

  const email = $("emailInput").value.trim().toLowerCase() || state.pendingEmail;
  if (!email) return toast("請先輸入 Email");

  const { error } = await client.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: authRedirectUrl }
  });
  if (error) {
    console.error("[resendVerificationEmail]", error);
    return toast(error.message || "驗證信重新寄送失敗");
  }

  showResendButton(email);
  startResendCooldown();
  toast("驗證信已重新寄出，請檢查垃圾郵件");
}

async function signOut() {
  const { error } = await client.auth.signOut();
  if (error) return toast(error.message);
  closeActionSheets();
  state.trips = [];
  state.diaries = [];
  clearPhotoUrlCache();
  refreshMarkers();
  renderTrips();
  closeDrawer();
  closeTripDetail();
}

function setSessionUI() {
  const signedIn = !!state.user;
  $("authScreen").hidden = signedIn;
  $("appShell").hidden = !signedIn;
  if (!signedIn) closeTripDetail();
  $("signOutBtn").hidden = !signedIn;
  $("mobileBottomNav").hidden = !signedIn || state.sharedMode;
  $("settingsEmail").textContent = state.user?.email || "登入帳號";
  $("sessionStatus").textContent = signedIn ? `私人雲端 · ${state.user.email}` : "私人雲端";
  if (signedIn) setTimeout(() => map.invalidateSize(), 80);
}

function handleMobileNavigation(destination) {
  if (destination === "home") {
    closeTripDetail();
    closeDrawer();
    setMobileNavActive("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (destination === "map") {
    closeTripDetail();
    closeDrawer();
    setMobileNavActive("map");
    $("map").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => map?.invalidateSize(), 180);
    return;
  }

  if (destination === "diary") {
    setMobileNavActive("diary");
    openDiaryLibrary();
    return;
  }

  if (destination === "more") {
    setMobileNavActive("more");
    openActionSheet("moreMenuSheet");
  }
}

function setMobileNavActive(destination) {
  document.querySelectorAll("[data-mobile-nav]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mobileNav === destination);
  });
}

function openActionSheet(id) {
  const sheet = $(id);
  if (!sheet?.open) sheet?.showModal();
}

function closeActionSheets() {
  ["quickActionSheet", "moreMenuSheet", "footprintSheet", "statsSheet", "diaryLibrarySheet", "settingsSheet"].forEach((id) => {
    const sheet = $(id);
    if (sheet?.open) sheet.close();
  });
}

function handleQuickAction(action) {
  $("quickActionSheet").close();

  if (action === "trip") {
    openTripDialog();
    return;
  }

  const recent = getRecentTrip();
  if (action === "photo") {
    if (!recent) {
      openTripDialog();
      setTimeout(() => $("photoInput").focus(), 80);
      return;
    }
    openTripDialog(recent);
    setTimeout(() => $("photoInput").focus(), 80);
    return;
  }

  if (action === "diary") {
    if (!recent) return openTripDialog();
    if (state.schemaMode === "legacy") {
      openLatestTripTab("diary");
      toast("舊版日記目前可閱讀，編輯入口會在日記模組接入");
      return;
    }
    openTripDialog(recent);
    setTimeout(() => $("diaryInput").focus(), 80);
  }
}

function handleMoreAction(action) {
  $("moreMenuSheet").close();

  if (action === "photos" || action === "timeline") {
    setMobileNavActive("more");
    openLatestTripTab("photos");
    return;
  }

  if (action === "footprints") {
    openFootprints();
    return;
  }

  if (action === "stats") {
    renderTravelStats();
    openActionSheet("statsSheet");
    return;
  }

  if (action === "settings") {
    $("settingsEmail").textContent = state.user?.email || "登入帳號";
    openActionSheet("settingsSheet");
    return;
  }

  if (action === "diary") {
    openDiaryLibrary();
  }
}

function getRecentTrip() {
  return [...state.trips].sort(compareTripsByDate)[0] || null;
}

function openFootprints() {
  closeTripDetail();
  closeDrawer();
  renderFootprints();
  setMobileNavActive("more");
  openActionSheet("footprintSheet");
}

function renderFootprints() {
  const trips = state.trips;
  const countries = [...new Set(trips.map((trip) => getTripCountry(trip)).filter(Boolean))];
  const cities = [...new Set(trips.flatMap((trip) => getTripLocations(trip)).filter((place) => place !== "未記錄地點"))];
  const days = trips.reduce((sum, trip) => sum + getTripDayCount(trip), 0);
  $("footprintStats").innerHTML = [
    ["🌍", countries.length, "個國家"],
    ["🏙️", cities.length, "個城市"],
    ["🧳", trips.length, "趟旅行"],
    ["📅", days, "個旅行日"]
  ].map(([icon, value, label]) => `<div class="footprint-stat"><span>${icon}</span><strong>${value}</strong><small>${label}</small></div>`).join("");

  const grouped = new Map();
  [...trips].sort(compareTripsByDate).forEach((trip) => {
    const year = getTripYear(trip);
    if (!grouped.has(year)) grouped.set(year, []);
    grouped.get(year).push(trip);
  });
  $("footprintYears").innerHTML = [...grouped.entries()].map(([year, yearTrips]) => `
    <section class="footprint-year">
      <div class="footprint-year-head"><h3>${escapeHtml(year)}</h3><span>${yearTrips.length} 趟</span></div>
      <div class="footprint-trip-list">
        ${yearTrips.map((trip) => `<button type="button" data-footprint-trip="${escapeHtml(trip.id)}"><span>${escapeHtml(trip.mood?.split(" ")[0] || "📍")}</span><strong>${escapeHtml(trip.title || trip.location_name || "未命名旅程")}</strong><small>${escapeHtml(trip.location_name || "未記錄地點")}</small></button>`).join("")}
      </div>
    </section>
  `).join("") || `<div class="detail-empty">新增第一趟旅行後，這裡會留下你的足跡。</div>`;
  $("footprintYears").querySelectorAll("[data-footprint-trip]").forEach((button) => {
    button.addEventListener("click", () => {
      $("footprintSheet").close();
      openTrip(button.dataset.footprintTrip);
    });
  });
}

function getTripCountry(trip) {
  return String(trip?.country || trip?.country_name || "").trim();
}

function getTripDayCount(trip) {
  const start = trip?.travel_date || trip?.date_start;
  const end = trip?.travel_date_end || trip?.date_end || start;
  if (!start) return 0;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
}

function renderMemoryOfToday() {
  const section = $("memorySection");
  if (state.sharedMode) {
    section.hidden = true;
    return;
  }
  const memory = findMemoryOfToday();
  if (!memory) {
    section.hidden = true;
    return;
  }

  const image = $("memoryImage");
  const placeholder = $("memoryPlaceholder");
  const cover = getCoverUrl(memory.trip);
  image.hidden = !cover;
  image.src = cover || "";
  placeholder.hidden = !!cover;
  $("memoryDate").textContent = `${memory.year} 年的今天`;
  $("memoryTitle").textContent = memory.trip.title || memory.trip.location_name || "那一天的旅行";
  $("memoryMeta").textContent = [memory.dateLabel, memory.trip.location_name, `${getTripPhotos(memory.trip).length} 張照片`].filter(Boolean).join(" · ");
  $("memoryText").textContent = memory.diary || "那一天留下的照片，正在等你重新翻開。";
  $("memoryOpenBtn").dataset.tripId = memory.trip.id;
  section.hidden = false;
}

function findMemoryOfToday() {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const currentYear = today.getFullYear();
  const candidates = [];
  state.trips.forEach((trip) => {
    const dateText = trip.travel_date || trip.date_start || "";
    const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match || Number(match[1]) >= currentYear) return;
    if (Number(match[2]) !== month || Number(match[3]) !== day) return;
    const diary = getTripDiaryRecords(trip)[0];
    candidates.push({
      trip,
      year: Number(match[1]),
      dateLabel: `${match[1]}.${match[2]}.${match[3]}`,
      diary: diary?.content?.trim() || trip.diary?.trim() || ""
    });
  });
  return candidates.sort((a, b) => b.year - a.year)[0] || null;
}

function renderTravelStats() {
  const trips = state.trips;
  const photos = trips.reduce((sum, trip) => sum + getTripPhotos(trip).length, 0);
  const diaries = trips.reduce((sum, trip) => sum + getTripDiaryRecords(trip).length, 0);
  const days = trips.reduce((sum, trip) => sum + getTripDayCount(trip), 0);
  const cities = [...new Set(trips.flatMap((trip) => getTripLocations(trip)).filter((place) => place !== "未記錄地點"))];
  const countries = [...new Set(trips.map((trip) => getTripCountry(trip)).filter(Boolean))];
  const moodCounts = new Map();
  trips.forEach((trip) => {
    const mood = String(trip.mood || "").split(" ")[0];
    if (mood) moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
  });
  const favoriteMood = [...moodCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  const cityCounts = new Map();
  trips.forEach((trip) => getTripLocations(trip).filter((place) => place !== "未記錄地點").forEach((place) => cityCounts.set(place, (cityCounts.get(place) || 0) + 1)));
  const favoriteCity = [...cityCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  const mostPhotos = [...trips].sort((a, b) => getTripPhotos(b).length - getTripPhotos(a).length)[0];
  const longestTrip = [...trips].sort((a, b) => getTripDayCount(b) - getTripDayCount(a))[0];
  const currentYear = String(new Date().getFullYear());
  const currentYearTrips = trips.filter((trip) => getTripYear(trip) === currentYear);
  $("travelStatsBody").innerHTML = `
    <div class="travel-stats-year">${escapeHtml(currentYear)} MY TRAVEL</div>
    <div class="travel-stat-grid">
      ${[["🧳", trips.length, "趟旅行"], ["📅", days, "旅行日"], ["📷", photos, "張照片"], ["🏙️", cities.length, "個城市"], ["📝", diaries, "篇日記"], ["🌍", countries.length, "個國家"]].map(([icon, value, label]) => `<div class="travel-stat-card"><span>${icon}</span><strong>${value.toLocaleString()}</strong><small>${label}</small></div>`).join("")}
    </div>
    <div class="travel-insights">
      <h3>${currentYear} 的旅行印記</h3>
      <div><span>今年旅行</span><strong>${currentYearTrips.length} 趟</strong></div>
      <div><span>最常去</span><strong>${escapeHtml(favoriteCity)}</strong></div>
      <div><span>照片最多</span><strong>${escapeHtml(mostPhotos?.title || mostPhotos?.location_name || "—")}</strong></div>
      <div><span>旅行最久</span><strong>${escapeHtml(longestTrip ? `${longestTrip.title || longestTrip.location_name || "未命名"} · ${getTripDayCount(longestTrip)} 天` : "—")}</strong></div>
      <div><span>最常出現的心情</span><strong>${escapeHtml(favoriteMood)}</strong></div>
    </div>
  `;
}

function openLatestTripTab(tabName) {
  const recent = getRecentTrip();
  if (!recent) return toast("目前還沒有旅程");
  closeActionSheets();
  openTrip(recent.id);
  setDetailTab(tabName);
}

function openDiaryLibrary() {
  closeTripDetail();
  closeDrawer();
  renderDiaryLibrary();
  openActionSheet("diaryLibrarySheet");
}

function getAllDiaryRecords() {
  const records = [...state.diaries];
  const linkedTripIds = new Set(records.map((diary) => String(diary.trip_id || "")));

  state.trips.forEach((trip) => {
    if (!trip?.diary || linkedTripIds.has(String(trip.id))) return;
    records.push({
      id: `trip-diary-${trip.id}`,
      title: trip.title || trip.location_name || "旅行日記",
      content: trip.diary,
      diary_date: trip.travel_date || trip.date_start || "",
      mood: trip.mood || "",
      trip_id: trip.id
    });
  });

  return records;
}

function renderDiaryLibrary() {
  const list = $("diaryLibrary");
  if (!list) return;

  const diaries = getAllDiaryRecords().sort((a, b) =>
    String(b.diary_date || b.created_at || "").localeCompare(String(a.diary_date || a.created_at || ""))
  );
  list.innerHTML = diaries.length
    ? diaries.map((diary) => {
      const trip = state.trips.find((item) => String(item.id) === String(diary.trip_id));
      const tripLabel = trip?.title || trip?.location_name || "未關聯旅程";
      return `
        <article class="diary-library-entry">
          <div class="diary-library-entry-head">
            <div>
              <p>${escapeHtml(diary.diary_date || "未記錄日期")}</p>
              <h3>${escapeHtml(diary.title || "旅行日記")}</h3>
            </div>
            <span>${escapeHtml(diary.mood || "📝")}</span>
          </div>
          <p class="diary-library-trip">${escapeHtml(tripLabel)}</p>
          <div class="diary-library-content">${escapeHtml(diary.content || "（無內容）")}</div>
          ${trip ? `<button class="text-action diary-library-open" type="button" data-diary-trip-id="${escapeHtml(trip.id)}">查看這趟旅程 →</button>` : ""}
        </article>
      `;
    }).join("")
    : `<div class="detail-empty">${state.diaryLoadError ? `日記載入失敗：${escapeHtml(state.diaryLoadError)}` : "目前沒有可顯示的日記。"}</div>`;
}

function handleDiaryLibraryClick(event) {
  const button = event.target.closest("[data-diary-trip-id]");
  if (!button) return;
  const trip = state.trips.find((item) => String(item.id) === String(button.dataset.diaryTripId));
  if (!trip) return;
  $("diaryLibrarySheet").close();
  openTrip(trip.id);
  setDetailTab("diary");
}

async function loadTrips() {
  restorePhotoUrlCache();
  const modernResult = await client
    .from("trips")
    .select("*, trip_photos(*)")
    .order("travel_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const hasLegacyShape = (modernResult.data || []).some((trip) =>
    trip.name && !trip.location_name && (trip.date_start || trip.photos_meta || trip.expenses)
  );
  if (!modernResult.error && !hasLegacyShape) {
    state.schemaMode = "modern";
    state.storageBucket = bucket;
    state.trips = modernResult.data || [];
    state.diaries = [];
    // Keep the original standalone diary records visible after the UI refactor.
    // The modern trips query does not include the separate diaries table.
    await loadStandaloneDiaries();
  } else {
    // The original app stores photos_meta on trips and diary entries separately.
    // Keep that data readable while the database remains unchanged.
    const legacyResult = await client
      .from("trips")
      .select("*")
      .order("created_at", { ascending: false });
    if (legacyResult.error) return toast(legacyResult.error.message);
    state.schemaMode = "legacy";
    state.storageBucket = bucket;
    state.trips = (legacyResult.data || []).map(normalizeLegacyTrip);
    await loadStandaloneDiaries();
  }

  await loadTripStops();
  // Render the archive first. The home screen only needs one image per trip;
  // detail photos are signed when the user opens that trip.
  renderTrips();
  refreshMarkers();
  hydratePhotoUrls(getInitialPhotoPaths()).then(() => {
    renderTrips();
    refreshMarkers();
  }).catch((error) => {
    console.error("[loadTrips.photoUrls]", error);
  });
}

async function loadTripStops() {
  state.stopSchemaAvailable = false;
  state.stopSchemaError = "";
  state.trips.forEach((trip) => { trip.trip_days = []; });
  // Stops are linked by trip id, so they work with both the modern trip
  // shape and the legacy trip shape used by older records.
  if (!state.trips.length) return;

  // Query the two tables separately. This avoids depending on PostgREST's
  // relationship cache immediately after the additive migration is run.
  const { data: days, error: daysError } = await client
    .from("trip_days")
    .select("*")
    .in("trip_id", state.trips.map((trip) => trip.id))
    .order("day_number", { ascending: true })
    .order("sort_order", { ascending: true });

  if (daysError) {
    if (daysError.code === "PGRST205" || daysError.code === "42P01") {
      state.stopSchemaError = "找不到 trip_days 資料表";
      return;
    }
    state.stopSchemaError = daysError.code || daysError.message || "trip_days 讀取失敗";
    console.error("[loadTripStops.days]", daysError);
    return;
  }

  const dayRows = days || [];
  const dayIds = dayRows.map((day) => day.id).filter(Boolean);
  let stopRows = [];
  if (dayIds.length) {
    const { data: stops, error: stopsError } = await client
      .from("trip_stops")
      .select("*")
      .in("day_id", dayIds)
      .order("sort_order", { ascending: true });

    if (stopsError) {
      if (stopsError.code === "PGRST205" || stopsError.code === "42P01") {
        state.stopSchemaError = "找不到 trip_stops 資料表";
        return;
      }
      state.stopSchemaError = stopsError.code || stopsError.message || "trip_stops 讀取失敗";
      console.error("[loadTripStops.stops]", stopsError);
      return;
    }
    stopRows = stops || [];
  }

  state.stopSchemaAvailable = true;
  state.trips.forEach((trip) => {
    trip.trip_days = dayRows
      .filter((day) => String(day.trip_id) === String(trip.id))
      .map((day) => ({
        ...day,
        trip_stops: stopRows
          .filter((stop) => String(stop.day_id) === String(day.id))
          .sort(compareStops)
      }));
  });
}

function compareStops(a, b) {
  const orderDifference = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  if (orderDifference) return orderDifference;
  return String(a.arrival_time || "99:99").localeCompare(String(b.arrival_time || "99:99"));
}

async function loadStandaloneDiaries() {
  state.diaryLoadError = "";
  let { data, error } = await client
    .from("diaries")
    .select("*")
    .order("diary_date", { ascending: false });

  // Keep compatibility with older diary tables that may not expose diary_date
  // through the current PostgREST schema cache.
  if (error) {
    const fallback = await client.from("diaries").select("*");
    if (!fallback.error) {
      data = fallback.data;
      error = null;
    }
  }

  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") {
      state.diaries = [];
      state.diaryLoadError = "找不到 diaries 資料表";
      return;
    }
    console.error("[loadStandaloneDiaries]", error);
    state.diaries = [];
    state.diaryLoadError = error.message || error.code || "未知錯誤";
    return;
  }
  // The original app relied on Supabase RLS here. Keep that behavior so
  // older rows are not hidden when the ownership column has a legacy name.
  state.diaries = data || [];
  state.trips.forEach((trip) => {
    trip._diaries = state.diaries.filter((diary) => String(diary.trip_id) === String(trip.id));
  });
}

function normalizeLegacyTrip(trip) {
  const photos = parseLegacyPhotos(trip.photos_meta).map((photo, index) => ({
    id: photo.id || `legacy-${trip.id}-${index}`,
    storage_path: photo.path,
    original_name: photo.original_name || photo.name || photo.path.split("/").pop() || `照片 ${index + 1}`,
    caption: photo.caption || "",
    signed_url: photo.signed_url || ""
  }));
  return {
    ...trip,
    title: trip.title ?? trip.name ?? null,
    location_name: trip.location_name ?? trip.location ?? "",
    travel_date: trip.travel_date ?? trip.date_start ?? null,
    travel_date_end: trip.travel_date_end ?? trip.date_end ?? null,
    mood: trip.mood ?? null,
    tags: Array.isArray(trip.tags) ? trip.tags : [],
    cover_path: trip.cover_path || photos[0]?.storage_path || null,
    trip_photos: photos,
    _legacy: true
  };
}

function parseLegacyPhotos(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((photo) => photo && typeof photo.path === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((photo) => photo && typeof photo.path === "string") : [];
  } catch (error) {
    console.error("[parseLegacyPhotos]", error);
    return [];
  }
}

function getInitialPhotoPaths() {
  return state.trips
    .filter((trip) => !trip.parent_trip_id)
    .map((trip) => {
      const displayTrip = getTripDisplayData(trip);
      const members = displayTrip._isGroup
        ? [trip, ...displayTrip._groupChildren]
        : [displayTrip];
      for (const member of members) {
        const photos = getTripPhotos(member);
        const cover = photos.find((photo) => photo.storage_path === member.cover_path);
        const path = cover?.storage_path || photos[0]?.storage_path || "";
        if (path) return path;
      }
      return "";
    })
    .filter(Boolean);
}

function photoUrlCacheKey() {
  const owner = state.user?.id || "guest";
  return `travel-journal:signed-urls:${cfg.SUPABASE_URL}:${state.storageBucket}:${owner}`;
}

function restorePhotoUrlCache() {
  if (!state.user || typeof sessionStorage === "undefined") return;
  try {
    const raw = sessionStorage.getItem(photoUrlCacheKey());
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    entries.forEach(([path, value]) => {
      if (!path || !value?.url || Number(value.expiresAt) <= now) return;
      state.photoUrlCache.set(path, { url: value.url, expiresAt: Number(value.expiresAt) });
      state.photoUrls.set(path, value.url);
    });
  } catch (error) {
    console.warn("[restorePhotoUrlCache]", error);
  }
}

function persistPhotoUrlCache() {
  if (!state.user || typeof sessionStorage === "undefined") return;
  try {
    const entries = [...state.photoUrlCache.entries()]
      .filter(([, value]) => value.expiresAt > Date.now())
      .slice(-500);
    sessionStorage.setItem(photoUrlCacheKey(), JSON.stringify(entries));
  } catch (error) {
    console.warn("[persistPhotoUrlCache]", error);
  }
}

function clearPhotoUrlCache() {
  state.photoUrls.clear();
  state.photoUrlCache.clear();
  state.photoUrlRequests.clear();
  if (state.user && typeof sessionStorage !== "undefined") {
    try { sessionStorage.removeItem(photoUrlCacheKey()); } catch (error) { console.warn("[clearPhotoUrlCache]", error); }
  }
}

function getCachedPhotoUrl(path) {
  if (!path) return "";
  const cached = state.photoUrlCache.get(path);
  if (!cached || cached.expiresAt <= Date.now()) {
    state.photoUrlCache.delete(path);
    state.photoUrls.delete(path);
    return "";
  }
  return cached.url;
}

function cachePhotoUrl(path, signedUrl) {
  if (!path || !signedUrl) return;
  const value = { url: signedUrl, expiresAt: Date.now() + SIGNED_URL_CACHE_TTL_MS };
  state.photoUrlCache.set(path, value);
  state.photoUrls.set(path, signedUrl);
}

async function signPhotoBatch(paths) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!uniquePaths.length) return;
  const { data, error } = await client.storage
    .from(state.storageBucket)
    .createSignedUrls(uniquePaths, SIGNED_URL_TTL_SECONDS);
  if (error) {
    console.error("[signPhotoBatch]", error);
    return;
  }
  uniquePaths.forEach((path, index) => {
    const signedUrl = data?.[index]?.signedUrl;
    if (signedUrl) cachePhotoUrl(path, signedUrl);
  });
  persistPhotoUrlCache();
}

async function hydratePhotoUrls(paths = null) {
  const requestedPaths = [...new Set((paths === null ? getInitialPhotoPaths() : paths).filter(Boolean))];
  const pending = [];
  const newPaths = [];

  requestedPaths.forEach((path) => {
    if (getCachedPhotoUrl(path)) return;
    const existingRequest = state.photoUrlRequests.get(path);
    if (existingRequest) {
      pending.push(existingRequest);
      return;
    }
    newPaths.push(path);
  });

  for (let index = 0; index < newPaths.length; index += SIGNED_URL_BATCH_SIZE) {
    const batch = newPaths.slice(index, index + SIGNED_URL_BATCH_SIZE);
    const request = signPhotoBatch(batch).finally(() => {
      batch.forEach((path) => state.photoUrlRequests.delete(path));
    });
    batch.forEach((path) => state.photoUrlRequests.set(path, request));
    pending.push(request);
  }

  await Promise.all(pending);
}

function getChildTrips(parentId) {
  return state.trips
    .filter((trip) => String(trip.parent_trip_id || "") === String(parentId || ""))
    .sort(compareTripsByDate);
}

function getTripDisplayData(trip) {
  const children = getChildTrips(trip?.id);
  if (!children.length) return trip;

  const members = [trip, ...children];
  const photos = [];
  const seenPhotos = new Set();
  members.flatMap((member) => getTripPhotos(member)).forEach((photo) => {
    const key = photo.id || photo.storage_path || `${photo.original_name || photo.name}:${photos.length}`;
    if (seenPhotos.has(key)) return;
    seenPhotos.add(key);
    photos.push(photo);
  });

  const diaries = members.flatMap((member) => getTripDiaryRecords(member));
  const locations = [...new Set(children.flatMap((member) => getTripLocations(member)))]
    .filter((location) => location && location !== "未記錄地點");
  const dates = members
    .flatMap((member) => [member.travel_date || member.date_start, member.travel_date_end || member.date_end])
    .filter(Boolean)
    .sort();
  const firstChild = children[0] || trip;
  const groupDays = [];
  let dayNumber = 1;
  members.forEach((member) => {
    getTripDays(member).forEach((day) => {
      groupDays.push({
        ...day,
        day_number: dayNumber++,
        title: [member.title || member.location_name, day.title].filter(Boolean).join(" · ")
      });
    });
  });

  return {
    ...trip,
    _isGroup: true,
    _groupChildren: children,
    _diaries: diaries,
    trip_photos: photos,
    trip_days: groupDays,
    title: trip.title || "未命名大行程",
    location_name: locations.join(" / ") || trip.location_name || "未記錄地點",
    travel_date: dates[0] || trip.travel_date || trip.date_start || null,
    travel_date_end: dates[dates.length - 1] || trip.travel_date_end || trip.date_end || null,
    lat: numberOrNull(trip.lat) ?? numberOrNull(firstChild.lat),
    lng: numberOrNull(trip.lng) ?? numberOrNull(firstChild.lng),
    expenses: aggregateGroupExpenses(members)
  };
}

function aggregateGroupExpenses(members) {
  const totals = Object.fromEntries(expenseCategories.map((category) => [category, 0]));
  let hasValue = false;
  members.forEach((member) => {
    const expense = parseExpenseRecord(member.expenses ?? member.expense);
    if (!expense) return;
    const source = expense.twd && typeof expense.twd === "object"
      ? expense.twd
      : (expense.currency === "TWD" || expense.orig_currency === "TWD" ? (expense.original || expense) : null);
    if (!source) return;
    expenseCategories.forEach((category) => {
      const value = Number(source[category]);
      if (!Number.isFinite(value)) return;
      totals[category] += value;
      hasValue = hasValue || value > 0;
    });
  });
  return hasValue
    ? JSON.stringify({ currency: "TWD", orig_currency: "TWD", original: totals, twd: totals, ...totals })
    : null;
}

function getTripTwdExpenseTotal(trip) {
  const expense = parseExpenseRecord(trip?.expenses ?? trip?.expense);
  if (!expense) return 0;
  const source = expense.twd && typeof expense.twd === "object"
    ? expense.twd
    : (expense.currency === "TWD" || expense.orig_currency === "TWD" ? (expense.original || expense) : expense);
  return expenseCategories.reduce((sum, category) => sum + (Number(source?.[category]) || 0), 0);
}

function renderTrips() {
  const list = $("tripList");
  const query = $("searchInput").value.trim().toLowerCase();
  const topLevelTrips = state.trips.filter((trip) => !trip.parent_trip_id);
  const filtered = topLevelTrips
    .map(getTripDisplayData)
    .filter((trip) => tripMatchesQuery(trip, query));
  const sorted = [...filtered].sort(compareTripsByDate);
  const recent = sorted[0];

  renderMemoryOfToday();

  $("placeCount").textContent = topLevelTrips.length;
  $("photoCount").textContent = state.trips.reduce((sum, trip) => sum + (trip.trip_photos?.length || 0), 0);

  if (!filtered.length) {
    $("recentTrip").innerHTML = `<div class="empty recent-empty">${query ? "找不到符合條件的旅程。" : "還沒有最近旅程。"}</div>`;
    list.innerHTML = `<div class="empty">${query ? "請換個關鍵字再試一次。" : "從上方「＋ 新增旅程」開始，先記下下一段旅途。"}</div>`;
    return;
  }

  $("recentTrip").innerHTML = renderRecentTrip(recent);
  bindTripCards($("recentTrip"));

  const grouped = new Map();
  sorted.forEach((trip) => {
    const year = getTripYear(trip);
    if (!grouped.has(year)) grouped.set(year, []);
    grouped.get(year).push(trip);
  });

  list.innerHTML = [...grouped.entries()].map(([year, trips]) => `
    <section class="trip-year-group">
      <div class="trip-year-heading"><h3>${escapeHtml(year)}</h3><span>${trips.length} 趟</span></div>
      <div class="trip-card-grid">${trips.map(renderTripCard).join("")}</div>
    </section>
  `).join("");

  bindTripCards(list);
}

function tripMatchesQuery(trip, query) {
  if (!query) return true;
  const diaryText = getTripDiaryRecords(trip)
    .map((diary) => [diary.title, diary.content].join(" "))
    .join(" ");
  const haystack = [
    trip.title,
    trip.location_name,
    trip.location,
    trip.travel_date,
    trip.date_start,
    trip.travel_date_end,
    trip.date_end,
    trip.mood,
    trip.diary,
    diaryText,
    (trip.tags || []).join(" "),
    ...(trip._groupChildren || []).flatMap((child) => [child.title, child.location_name, child.location, child.travel_date])
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function compareTripsByDate(a, b) {
  const aValue = getTripDateValue(a);
  const bValue = getTripDateValue(b);
  return bValue - aValue;
}

function getTripDateValue(trip) {
  const value = trip?.travel_date || trip?.date_start || trip?.created_at || "";
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getTripYear(trip) {
  const value = trip?.travel_date || trip?.date_start || trip?.created_at || "未分類";
  const match = String(value).match(/^(\d{4})/);
  return match ? match[1] : "未分類";
}

function renderRecentTrip(trip) {
  if (!trip) return `<div class="empty recent-empty">還沒有最近旅程。</div>`;
  const cover = getCoverUrl(trip);
  const photos = getTripPhotos(trip);
  const diaries = getTripDiaryRecords(trip);
  const start = trip.travel_date || trip.date_start || "";
  const end = trip.travel_date_end || trip.date_end || start;
  const title = trip.title || trip.location_name || "未命名旅程";
  const location = trip.location_name || trip.location || "未記錄地點";
  const groupMeta = trip._isGroup ? `<span class="group-badge">大行程 · ${trip._groupChildren.length} 個小行程</span>` : "";
  const stats = trip._isGroup
    ? `大行程 · ${trip._groupChildren.length} 個小行程 · ${photos.length} 張照片 · ${diaries.length} 篇日記`
    : `${formatTripDays(start, end)} · ${photos.length} 張照片 · ${diaries.length} 篇日記`;
  return `
    <article class="recent-trip-card" data-trip-id="${escapeHtml(trip.id)}" tabindex="0" role="button" aria-label="回顧${escapeHtml(title)}">
      <div class="recent-trip-media">
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(location)}" fetchpriority="high" decoding="async">` : `<div class="trip-placeholder">📍</div>`}
        <span class="recent-trip-badge">${trip.is_shared ? "已分享" : "私人"}</span>
        ${groupMeta}
        ${renderTripCardMenu(trip)}
      </div>
      <div class="recent-trip-body">
        <div>
          <p class="section-kicker">最近一次旅行</p>
          <h3>${escapeHtml(title)}</h3>
          <p class="recent-trip-meta">${escapeHtml(formatDateRange(start, end))} · ${escapeHtml(location)}</p>
          <p class="recent-trip-stats">${stats}</p>
        </div>
        <span class="recent-trip-link">回顧 <span aria-hidden="true">→</span></span>
      </div>
    </article>
  `;
}

function renderTripCard(trip) {
  const cover = getCoverUrl(trip);
  const photos = getTripPhotos(trip);
  const diaries = getTripDiaryRecords(trip);
  const start = trip.travel_date || trip.date_start || "";
  const end = trip.travel_date_end || trip.date_end || start;
  const title = trip.title || trip.location_name || "未命名旅程";
  const location = trip.location_name || trip.location || "未記錄地點";
  const groupMeta = trip._isGroup ? `<span class="group-badge">大行程 · ${trip._groupChildren.length} 個小行程</span>` : "";
  const stats = trip._isGroup
    ? `<span>📚 ${trip._groupChildren.length} 小行程</span><span>📷 ${photos.length}</span><span>📝 ${diaries.length}</span>`
    : `<span>📷 ${photos.length}</span><span>📝 ${diaries.length}</span><span>${escapeHtml(formatTripDays(start, end))}</span>`;
  return `
    <article class="trip-card" data-trip-id="${escapeHtml(trip.id)}" tabindex="0" role="button" aria-label="查看${escapeHtml(title)}">
      <div class="trip-card-media">
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(location)}" loading="lazy" decoding="async">` : `<div class="trip-placeholder">📍</div>`}
        <span class="trip-privacy-dot" title="${trip.is_shared ? "已分享" : "私人旅程"}">${trip.is_shared ? "○" : "•"}</span>
        ${groupMeta}
        ${renderTripCardMenu(trip)}
      </div>
      <div class="trip-card-body">
        <div class="trip-card-title"><span>${escapeHtml(title)}</span></div>
        <div class="trip-meta">${escapeHtml(location)}</div>
        <div class="trip-card-date">${escapeHtml(formatDateRange(start, end))}</div>
        <div class="trip-card-stats">${stats}</div>
      </div>
    </article>
  `;
}

function renderTripCardMenu(trip) {
  if (state.sharedMode || trip?._isGroup) return "";
  const shareLabel = trip.is_shared
    ? (trip.share_token ? "複製分享連結" : "修復分享連結")
    : "開啟分享";
  return `
    <div class="trip-card-menu">
      <button class="trip-card-menu-trigger" type="button" data-trip-menu aria-label="${escapeHtml(trip.title || trip.location_name || "旅程")} 的更多操作" title="更多操作">•••</button>
      <div class="trip-card-menu-panel" data-trip-menu-panel hidden>
        <button type="button" data-trip-action="edit">編輯</button>
        <button type="button" data-trip-action="share">${shareLabel}</button>
        <button class="is-danger" type="button" data-trip-action="delete">刪除</button>
      </div>
    </div>
  `;
}

function bindTripCards(container) {
  container.querySelectorAll("[data-trip-id]").forEach((card) => {
    const open = () => openTrip(card.dataset.tripId);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.target.closest("[data-trip-menu]")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });

    const menu = card.querySelector("[data-trip-menu]");
    const panel = card.querySelector("[data-trip-menu-panel]");
    menu?.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTripCardMenus(panel);
      panel.hidden = false;
    });
    menu?.addEventListener("keydown", (event) => event.stopPropagation());
    panel?.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-trip-action]");
      if (!actionButton) return;
      event.stopPropagation();
      handleTripCardAction(card.dataset.tripId, actionButton.dataset.tripAction);
    });
  });
}

function closeTripCardMenus(except = null) {
  document.querySelectorAll("[data-trip-menu-panel]").forEach((panel) => {
    if (panel !== except) panel.hidden = true;
  });
}

function handleTripCardAction(tripId, action) {
  if (state.sharedMode) return toast("分享檢視不可修改旅程");
  const trip = state.trips.find((item) => String(item.id) === String(tripId));
  if (!trip) return;
  closeTripCardMenus();

  if (action === "edit") {
    openTripDialog(trip);
    return;
  }

  if (action === "share") {
    if (!trip.is_shared || !trip.share_token) return toggleTripSharing(trip, true);
    const shareUrl = getShareUrl(trip.share_token);
    if (!shareUrl) return toast("請在 config.js 設定 PUBLIC_APP_URL，或使用 HTTP(S) 網址開啟網站後再分享");
    copyText(shareUrl);
    return;
  }

  if (action === "delete") {
    state.editingTrip = trip;
    deleteCurrentTrip();
  }
}

function refreshMarkers() {
  if (!map) return;

  state.markers.forEach((marker) => map.removeLayer(marker));
  state.markers.clear();

  const points = [];
  state.trips.forEach((trip) => {
    const stops = getTripStops(trip)
      .map((stop, index) => ({ ...stop, index, lat: numberOrNull(stop.lat), lng: numberOrNull(stop.lng) }))
      .filter((stop) => stop.lat !== null && stop.lng !== null);

    if (stops.length) {
      stops.forEach((stop) => {
        const marker = L.marker([stop.lat, stop.lng], { icon: makeStopMarkerIcon(stop.index + 1) }).addTo(map);
        marker.bindPopup(`<strong>${escapeHtml(stop.name)}</strong><br>${escapeHtml(trip.title || trip.location_name || "旅程")}`);
        marker.on("click", () => openTrip(trip.id));
        state.markers.set(`${trip.id}:${stop.id}`, marker);
        points.push([stop.lat, stop.lng]);
      });
      return;
    }

    const lat = numberOrNull(trip.lat);
    const lng = numberOrNull(trip.lng);
    if (lat === null || lng === null) return;
    const marker = L.marker([lat, lng], { icon: makeMarkerIcon(trip) }).addTo(map);
    marker.on("click", () => openTrip(trip.id));
    state.markers.set(trip.id, marker);
    points.push([lat, lng]);
  });

  if (points.length) {
    map.fitBounds(points, { padding: [44, 44], maxZoom: 8 });
  }
}

function makeMarkerIcon(trip) {
  const cover = getCoverUrl(trip);
  const html = cover
    ? `<div class="thumb-marker"><img src="${escapeHtml(cover)}" alt=""></div>`
    : `<div class="thumb-marker" style="display:grid;place-items:center;color:#9b5c2e;">${escapeHtml((trip.mood || "📍").split(" ")[0])}</div>`;
  return L.divIcon({ className: "", html, iconSize: [46, 46], iconAnchor: [23, 23] });
}

async function openTrip(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;

  if (!state.sharedMode) closeDrawer();
  const viewTrip = getTripDisplayData(trip);
  state.editingTrip = viewTrip;

  const lat = numberOrNull(viewTrip.lat);
  const lng = numberOrNull(viewTrip.lng);
  if (lat !== null && lng !== null) {
    map.flyTo([lat, lng], 13, { duration: 0.8 });
  }

  if (state.sharedMode) {
    renderDrawer(viewTrip, true);
    return;
  }

  $("appShell").hidden = true;
  $("tripDetailPage").hidden = false;
  renderTripDetail(viewTrip);
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Render the detail shell immediately, then replace placeholders after the
  // trip's signed URLs are ready. This keeps navigation responsive for large albums.
  await hydratePhotoUrls(getTripPhotos(viewTrip).map((photo) => photo.storage_path).filter(Boolean));
  if (state.editingTrip?.id !== viewTrip.id) return;
  renderTripDetail(viewTrip);
}

function closeTripDetail() {
  const detailPage = $("tripDetailPage");
  if (!detailPage) return;
  detailPage.hidden = true;
  $("appShell").hidden = !(state.user || state.sharedMode);
  state.editingTrip = null;
  if (map) setTimeout(() => map.invalidateSize(), 80);
}

function setDetailTab(tabName) {
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.detailTab === tabName);
  });
  document.querySelectorAll(".detail-panel").forEach((panel) => {
    panel.hidden = panel.id !== `detail-panel-${tabName}`;
  });
  if (tabName === "map" && state.editingTrip) {
    renderDetailMap(state.editingTrip);
  }
}

function renderTripDetail(trip) {
  state.selectedStopId = null;
  state.selectedDeleteIndexes.clear();
  const isGroup = !!trip?._isGroup;
  const photos = getTripPhotos(trip);
  const allowPhotoDelete = !state.sharedMode && !!state.user && !isGroup;
  const diaries = getTripDiaryRecords(trip);
  const cover = getCoverUrl(trip);
  const name = trip.title || trip.location_name || "未命名旅途";
  const location = trip.location_name || trip.location || "未記錄地點";
  const dateStart = trip.travel_date || trip.date_start || "";
  const dateEnd = trip.date_end || trip.travel_date_end || dateStart;
  const dateLabel = formatDateRange(dateStart, dateEnd);
  const mood = trip.mood ? trip.mood.split(" ")[0] : "";
  const tags = Array.isArray(trip.tags) ? trip.tags : [];

  $("detailHeroMedia").innerHTML = cover
    ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(location)}" fetchpriority="high">`
    : `<div class="detail-hero-placeholder">${escapeHtml(mood || "📍")}</div>`;
  $("detailKicker").textContent = `${location}${trip.country ? ` · ${trip.country}` : ""}`;
  $("detailName").textContent = name;
  $("detailHeroMeta").textContent = [dateLabel, mood, ...tags].filter(Boolean).join("  ·  ");
  $("detailPrivacy").textContent = trip.is_shared ? "已開啟分享" : "私人旅途";
  $("detailDownloadBtn").hidden = !cover;
  $("detailEditBtn").hidden = isGroup;
  $("detailEditExpensesBtn").hidden = isGroup;
  $("detailPhotoManagementActions").hidden = isGroup;
  const coverEditorButton = $("detailSetCoverBtn");
  if (coverEditorButton) {
    coverEditorButton.hidden = state.sharedMode || !state.user || photos.length === 0 || isGroup;
  }

  $("detailDays").textContent = formatTripDays(dateStart, dateEnd);
  $("detailPhotoCount").textContent = photos.length;
  $("detailDiaryCount").textContent = diaries.length;
  const locations = getTripLocations(trip);
  const stops = getTripStops(trip);
  const routeLocations = stops.length ? stops.map((stop) => stop.name) : locations;
  $("detailPlaceCount").textContent = stops.length || (locations[0] === "未記錄地點" ? "0" : locations.length);
  $("detailRoute").innerHTML = routeLocations.map((place, index) => `
    ${index ? '<span class="detail-route-arrow" aria-hidden="true">→</span>' : ""}
    <span class="detail-route-stop">${escapeHtml(place)}</span>
  `).join("");
  $("detailCoordinates").textContent = numberOrNull(trip.lat) !== null && numberOrNull(trip.lng) !== null
    ? `${locations.length > 1 ? "主地標座標" : "座標"} ${Number(trip.lat).toFixed(5)}, ${Number(trip.lng).toFixed(5)}`
    : "尚未記錄地圖座標";

  renderDetailSharePanel(trip);

  const diaryPreview = diaries[0]?.content?.trim() || trip.diary?.trim() || "";
  $("detailDiaryPreview").innerHTML = diaries.length
    ? renderDiaryPreview(diaries)
    : escapeHtml(diaryPreview || "這趟旅程還沒有日記，回來時記下一句當時的心情吧。");
  $("detailDiaryPreview").classList.toggle("is-empty", !diaryPreview);
  $("detailDiaryDate").textContent = diaries[0]?.diary_date || dateLabel || "尚未記錄日期";
  $("detailDiaryBody").innerHTML = renderDiaryEntries(diaries, trip.diary);
  $("detailDiaryBody").classList.toggle("is-empty", !diaries.length && !trip.diary);
  $("detailMapSummary").textContent = `${location}${dateLabel ? ` · ${dateLabel}` : ""}`;

  const groupSection = $("detailGroupSection");
  if (groupSection) {
    groupSection.hidden = !isGroup;
    $("detailGroupChildren").innerHTML = isGroup
      ? renderGroupChildren(trip._groupChildren)
      : "";
    $("detailGroupSummary").textContent = isGroup
      ? `${trip._groupChildren.length} 個小行程 · ${photos.length} 張照片 · ${diaries.length} 篇日記 · 約 NT$ ${Math.round(getTripTwdExpenseTotal(trip)).toLocaleString()}`
      : "";
    $("detailGroupChildren")?.querySelectorAll("[data-group-child-id]").forEach((button) => {
      button.addEventListener("click", () => openTrip(button.dataset.groupChildId));
    });
  }

  const recent = photos.slice(0, 6);
  const recentMarkup = renderDetailPhotoGrid(recent, "目前沒有照片", { selectable: allowPhotoDelete, selectionMode: "delete" });
  $("detailRecentPhotos").innerHTML = recentMarkup;
  renderTripItinerary(trip);
  $("detailAllPhotos").innerHTML = renderTravelTimeline(trip, photos, { selectable: allowPhotoDelete });
  const hasPhotoTimes = photos.some((photo) => getPhotoTakenAt(photo) || photo.trip_stop_id);
  $("detailPhotosSummary").textContent = `${photos.length} 張照片${cover ? " · 已設定封面" : ""}${hasPhotoTimes ? " · 依照片時間分組" : " · 目前依旅程日期排列"}`;
  updateDetailDeleteUI();
  renderDetailExpenses(trip);
  $("detailOverviewExpenses").innerHTML = $("detailExpenses").innerHTML;
  setDetailTab("overview");
}

function renderGroupChildren(children = []) {
  return children.length
    ? children.map((child, index) => {
      const photos = getTripPhotos(child);
      const diaries = getTripDiaryRecords(child);
      const start = child.travel_date || child.date_start || "";
      const end = child.travel_date_end || child.date_end || start;
      const title = child.title || child.location_name || "未命名小行程";
      const location = child.location_name || child.location || "未記錄地點";
      const cover = getCoverUrl(child);
      return `
        <button class="group-child-card" type="button" data-group-child-id="${escapeHtml(child.id)}">
          <span class="group-child-index">${index + 1}</span>
          <span class="group-child-media">${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">` : "📍"}</span>
          <span class="group-child-body">
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(location)} · ${escapeHtml(formatDateRange(start, end))}</small>
            <small>📷 ${photos.length} · 📝 ${diaries.length} · 約 NT$ ${Math.round(getTripTwdExpenseTotal(child)).toLocaleString()}</small>
          </span>
          <span class="group-child-arrow" aria-hidden="true">→</span>
        </button>
      `;
    }).join("")
    : `<div class="detail-empty">還沒有加入小行程。</div>`;
}

function renderDetailSharePanel(trip) {
  const panel = $("detailSharePanel");
  if (!panel) return;

  const shareUrl = getShareUrl(trip?.share_token);
  if (state.sharedMode || !trip || !state.user || trip._isGroup) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  panel.hidden = false;
  if (trip.is_shared && shareUrl) {
    panel.innerHTML =
      '<div class="detail-share-heading">' +
        '<div><strong>分享這趟旅程</strong><span>擁有連結的人可以查看你公開的地點與照片</span></div>' +
        '<span class="detail-share-state">已開啟</span>' +
      '</div>' +
      '<div class="detail-share-link-row">' +
        '<input id="detailShareUrlInput" type="text" value="' + escapeHtml(shareUrl) + '" readonly aria-label="分享連結">' +
        '<button class="btn btn-soft" id="detailCopyShareBtn" type="button">複製連結</button>' +
        '<button class="btn btn-primary" id="detailNativeShareBtn" type="button">分享</button>' +
      '</div>';
  } else if (trip.is_shared) {
    panel.innerHTML =
      '<div class="detail-share-heading">' +
        '<div><strong>分享已開啟</strong><span>目前找不到分享 token，請重新建立連結</span></div>' +
      '</div>' +
      '<button class="btn btn-primary" id="detailRepairShareBtn" type="button">重新建立分享連結</button>';
  } else {
    panel.innerHTML =
      '<div class="detail-share-heading">' +
        '<div><strong>分享這趟旅程</strong><span>目前為私人旅程，開啟後才會產生連結</span></div>' +
      '</div>' +
      '<button class="btn btn-primary" id="detailEnableShareBtn" type="button">開啟分享並取得連結</button>';
  }

  $("detailCopyShareBtn")?.addEventListener("click", () => copyText(shareUrl));
  $("detailNativeShareBtn")?.addEventListener("click", async () => {
    if (!navigator.share) return copyText(shareUrl);
    try {
      await navigator.share({
        title: trip.title || trip.location_name || "旅行日記",
        text: [trip.location_name, trip.travel_date ? formatDate(trip.travel_date) : ""].filter(Boolean).join(" · "),
        url: shareUrl
      });
    } catch (error) {
      if (error?.name !== "AbortError") console.error("[nativeShare]", error);
    }
  });
  $("detailEnableShareBtn")?.addEventListener("click", () => toggleTripSharing(trip, true));
  $("detailRepairShareBtn")?.addEventListener("click", () => toggleTripSharing(trip, true));
}

function getTripPhotos(trip) {
  return trip?.trip_photos || trip?.photos || [];
}

async function openCoverEditor() {
  const trip = state.editingTrip;
  if (state.sharedMode || !state.user || !trip) return;
  const photos = getTripPhotos(trip);
  if (!photos.length) return toast("這趟旅程目前沒有照片");
  const picker = $("coverPicker");
  if (!picker) return;
  picker.showModal();
  $("coverPickerStatus").textContent = `正在準備 ${photos.length} 張照片…`;
  renderCoverPicker(trip, photos);
  await hydratePhotoUrls(photos.map((photo) => photo.storage_path));
  if (state.editingTrip && String(state.editingTrip.id) === String(trip.id) && picker.open) {
    $("coverPickerStatus").textContent = `共 ${photos.length} 張照片 · 點選照片即可設為封面`;
    renderCoverPicker(trip, photos);
  }
}

function closeCoverPicker() {
  const picker = $("coverPicker");
  if (picker?.open) picker.close();
}

function renderCoverPicker(trip, photos) {
  const grid = $("coverPickerGrid");
  if (!grid) return;
  grid.innerHTML = photos.map((photo, index) => {
    const url = getPhotoUrl(photo);
    const label = photo.original_name || photo.name || `照片 ${index + 1}`;
    const isCurrent = photo.storage_path && photo.storage_path === trip.cover_path;
    const canUse = !!photo.storage_path;
    return `<button class="cover-picker-card${isCurrent ? " is-current" : ""}" type="button" data-cover-photo-index="${index}" aria-pressed="${isCurrent ? "true" : "false"}" aria-label="${escapeHtml(isCurrent ? `${label}，目前封面` : `將 ${label} 設為封面`)}"${canUse ? "" : " disabled"}>
      <span class="cover-picker-image">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async">` : `<span class="cover-picker-placeholder">照片載入中</span>`}</span>
      <span class="cover-picker-card-foot"><strong>${escapeHtml(label)}</strong><span>${isCurrent ? "目前封面" : "設為封面"}</span></span>
    </button>`;
  }).join("");
}

function handleCoverPickerClick(event) {
  const card = event.target.closest("[data-cover-photo-index]");
  if (!card || card.disabled) return;
  const index = Number(card.dataset.coverPhotoIndex);
  const photo = getTripPhotos(state.editingTrip)[index];
  if (photo) setTripPhotoAsCover(photo);
}

function getTripDiaryRecords(trip) {
  if (Array.isArray(trip?._diaries) && trip._diaries.length) return trip._diaries;
  if (trip?.diary && String(trip.diary).trim()) {
    return [{ title: "旅行日記", content: String(trip.diary), diary_date: trip.travel_date || "", mood: trip.mood || "" }];
  }
  return [];
}

function getTripLocations(trip) {
  const raw = String(trip?.location_name || trip?.location || "").trim();
  if (!raw) return ["未記錄地點"];
  return raw.split(/\s*(?:\/|→)\s*/).map((place) => place.trim()).filter(Boolean);
}

function getTripDays(trip) {
  return Array.isArray(trip?.trip_days) ? [...trip.trip_days].sort((a, b) => {
    const dayDifference = (Number(a.day_number) || 0) - (Number(b.day_number) || 0);
    return dayDifference || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  }) : [];
}

function getTripStops(trip) {
  return getTripDays(trip).flatMap((day) => (day.trip_stops || []).map((stop) => ({ ...stop, day })));
}

function renderTripItinerary(trip) {
  const days = getTripDays(trip);
  const photos = getTripPhotos(trip);
  const addButton = $("detailAddStopBtn");
  const readOnlyGroup = !!trip?._isGroup;
  addButton.disabled = !state.stopSchemaAvailable || readOnlyGroup;
  addButton.title = readOnlyGroup
    ? "請先點入小行程，再新增地標"
    : (state.stopSchemaAvailable ? "新增一天中的地標" : "請先執行 trip_days_stops migration");

  if (!state.stopSchemaAvailable) {
    const stopError = escapeHtml(state.stopSchemaError || "");
    $("detailItinerarySummary").textContent = state.stopSchemaError
      ? "地標資料目前無法讀取，請重新整理"
      : "目前仍使用原本的旅程地點資料";
    $("detailItineraryList").innerHTML = state.stopSchemaError
      ? `<div class="itinerary-empty"><strong>地標資料讀取失敗</strong><p>請確認已登入正確的 Supabase 專案，並重新整理頁面。錯誤代碼：${stopError}</p></div>`
      : `<div class="itinerary-empty"><strong>多地標功能尚未啟用</strong><p>現有旅程不會受到影響。執行專案內的 migration 後，就能建立 Day、地標、抵達時間與每日路線。</p></div>`;
    return;
  }

  const stopCount = days.reduce((sum, day) => sum + (day.trip_stops || []).length, 0);
  $("detailItinerarySummary").textContent = days.length + " 天 · " + stopCount + " 個地標";
  if (!days.length) {
    $("detailItineraryList").innerHTML = "<div class=\"itinerary-empty\"><strong>還沒有每日地標</strong><p>按「新增地標」開始建立這趟旅程的 Day 1。</p></div>";
    return;
  }

  $("detailItineraryList").innerHTML = days.map((day) => {
    const stops = [...(day.trip_stops || [])].sort(compareStops);
    const dayPhotos = photos.filter((photo) => stops.some((stop) => String(stop.id) === String(photo.trip_stop_id))).length;
    return [
      "<section class=\"itinerary-day\" data-day-id=\"", escapeHtml(day.id), "\">",
      "<header class=\"itinerary-day-head\"><div><p class=\"travel-day-label\">DAY ",
      escapeHtml(day.day_number), "</p><h3>", escapeHtml(day.title || formatItineraryDate(day.date) || "未命名的一天"),
      "</h3></div><span>", stops.length, " 個地標", dayPhotos ? " · " + dayPhotos + " 張照片" : "", "</span></header>",
      "<div class=\"itinerary-stop-list\">",
      stops.length ? stops.map((stop, index) => renderItineraryStop(stop, index, photos)).join("") : "<div class=\"itinerary-day-empty\">這天還沒有地標。</div>",
      "</div></section>"
    ].join("");
  }).join("");
  bindItineraryInteractions();
}

function renderItineraryStop(stop, index, photos) {
  const stopPhotos = photos.filter((photo) => String(photo.trip_stop_id) === String(stop.id)).length;
  const time = [stop.arrival_time, stop.departure_time].filter(Boolean).join(" — ");
  const meta = [stop.category, time].filter(Boolean).join(" · ");
  return [
    "<article class=\"itinerary-stop\" draggable=\"true\" data-stop-id=\"", escapeHtml(stop.id),
    "\" data-day-id=\"", escapeHtml(stop.day_id), "\">",
    "<span class=\"itinerary-stop-handle\" aria-hidden=\"true\">☰</span><span class=\"itinerary-stop-order\">",
    index + 1, "</span><div class=\"itinerary-stop-body\"><div class=\"itinerary-stop-title\"><strong>",
    escapeHtml(stop.name), "</strong><time>", escapeHtml(stop.arrival_time || ""),
    "</time></div><p>", escapeHtml(meta || stop.address || "尚未記錄抵達時間"), "</p>",
    stop.note ? "<small>" + escapeHtml(stop.note) + "</small>" : "",
    stopPhotos ? "<span class=\"itinerary-stop-photos\">📷 " + stopPhotos + " 張照片</span>" : "",
    "</div><div class=\"itinerary-stop-actions\"><button class=\"text-action itinerary-stop-map\" type=\"button\" data-stop-map=\"",
    escapeHtml(stop.id), "\">地圖 →</button><button class=\"text-action itinerary-stop-delete\" type=\"button\" data-stop-delete=\"",
    escapeHtml(stop.id), "\">刪除</button></div></article>"
  ].join("");
}

function formatItineraryDate(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[1] + "." + match[2] + "." + match[3] : String(value);
}

function bindItineraryInteractions() {
  const container = $("detailItineraryList");
  let dragged = null;
  container.querySelectorAll(".itinerary-stop").forEach((row) => {
    row.addEventListener("dragstart", () => {
      dragged = row;
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      dragged = null;
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === row || dragged.dataset.dayId !== row.dataset.dayId) return;
      const rect = row.getBoundingClientRect();
      row.parentElement.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
    });
    row.querySelector("[data-stop-map]")?.addEventListener("click", () => {
      state.selectedStopId = row.dataset.stopId;
      setDetailTab("map");
    });
    row.querySelector("[data-stop-delete]")?.addEventListener("click", () => deleteStop(row.dataset.stopId));
  });
  container.querySelectorAll(".itinerary-stop-list").forEach((list) => {
    list.addEventListener("drop", () => persistStopOrder(list));
  });
}

async function persistStopOrder(list) {
  if (state.sharedMode) return toast("分享檢視不可修改地標順序");
  if (!state.stopSchemaAvailable) return;
  const rows = [...list.querySelectorAll(".itinerary-stop")];
  const results = await Promise.all(rows.map((row, index) =>
    client.from("trip_stops").update({ sort_order: index }).eq("id", row.dataset.stopId)
  ));
  const failed = results.find((result) => result.error);
  if (failed) return toast(failed.error.message || "地標排序儲存失敗");
  toast("地標順序已儲存");
}

async function deleteStop(stopId) {
  if (state.sharedMode) return toast("分享檢視不可刪除地標");
  const trip = state.editingTrip;
  const stop = getTripStops(trip).find((item) => String(item.id) === String(stopId));
  if (!stop) return toast("找不到這個地標");
  if (!window.confirm(`確定要刪除「${stop.name}」嗎？`)) return;

  const { data, error } = await client
    .from("trip_stops")
    .delete()
    .eq("id", stopId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[deleteStop]", error);
    return toast(error.message || "地標刪除失敗");
  }
  if (!data) return toast("地標沒有成功刪除，請重新整理後再試");

  const updatedTrip = state.trips.find((item) => String(item.id) === String(trip.id)) || trip;
  updatedTrip.trip_days = (updatedTrip.trip_days || []).map((day) => ({
    ...day,
    trip_stops: (day.trip_stops || []).filter((item) => String(item.id) !== String(stopId))
  }));
  state.editingTrip = updatedTrip;
  refreshMarkers();
  renderTripDetail(updatedTrip);
  setDetailTab("itinerary");
  toast("地標已刪除");
}

function renderDiaryPreview(diaries) {
  return diaries.slice(0, 3).map((diary) => {
    const preview = String(diary.content || "").trim().replace(/\s+/g, " ");
    return `
      <div class="detail-diary-preview-entry">
        <span>${escapeHtml(diary.diary_date || "未記錄日期")}</span>
        <strong>${escapeHtml(diary.title || "旅行日記")}</strong>
        ${preview ? `<small>${escapeHtml(preview.slice(0, 70))}${preview.length > 70 ? "…" : ""}</small>` : ""}
      </div>
    `;
  }).join("");
}

function renderDiaryEntries(diaries, inlineDiary) {
  if (!diaries.length && !inlineDiary) return "這趟旅程還沒有日記。";
  if (!diaries.length) return escapeHtml(inlineDiary);
  return diaries.map((diary) => `
    <article class="detail-diary-entry">
      <div class="detail-diary-entry-head">
        <strong>${escapeHtml(diary.title || "旅行日記")}</strong>
        <span>${escapeHtml([diary.diary_date, diary.mood].filter(Boolean).join(" · "))}</span>
      </div>
      <p>${escapeHtml(diary.content || "（無內容）")}</p>
    </article>
  `).join("");
}

function getPhotoUrl(photo) {
  return photo?.signed_url || (photo?.storage_path ? getCachedPhotoUrl(photo.storage_path) : "") || "";
}

const LAZY_IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
let lazyPhotoObserver = null;

function observeLazyPhotoImages(root = document) {
  const images = root?.querySelectorAll?.("img[data-lazy-src]") || [];
  if (!images.length) return;

  if (!("IntersectionObserver" in window)) {
    images.forEach((image) => {
      image.src = image.dataset.lazySrc;
      image.removeAttribute("data-lazy-src");
    });
    return;
  }

  if (!lazyPhotoObserver) {
    lazyPhotoObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const image = entry.target;
        const src = image.dataset.lazySrc;
        if (src) {
          image.src = src;
          image.removeAttribute("data-lazy-src");
        }
        observer.unobserve(image);
      });
    }, { rootMargin: "360px 0px" });
  }

  images.forEach((image) => lazyPhotoObserver.observe(image));
}

function getPhotoSelectionKey(photo, index) {
  return String(photo?.id || photo?.storage_path || `${photo?.original_name || "photo"}-${index}`);
}

function renderDetailPhotoGrid(photos, emptyText, options = {}) {
  if (!photos.length) return `<div class="detail-empty">${escapeHtml(emptyText)}</div>`;
  const offset = Math.max(0, Number(options.offset) || 0);
  const pageSize = Number(options.limit) > 0 ? Number(options.limit) : photos.length;
  const visiblePhotos = photos.slice(offset, offset + pageSize);
  const tiles = visiblePhotos.map((photo, localIndex) => {
    const index = offset + localIndex;
    const url = getPhotoUrl(photo);
    const label = photo.original_name || photo.name || `照片 ${index + 1}`;
    const selector = options.selectable
      ? options.selectionMode === "delete"
        ? `<label class="photo-download-check" title="選取刪除照片"><input type="checkbox" data-delete-photo-key="${escapeHtml(getPhotoSelectionKey(photo, index))}" aria-label="選取刪除${escapeHtml(label)}"><span aria-hidden="true"></span></label>`
        : `<label class="photo-download-check" title="選取照片"><input type="checkbox" data-download-index="${index}" aria-label="選取${escapeHtml(label)}"><span aria-hidden="true"></span></label>`
      : "";
    const imageAlt = options.lazy ? "" : label;
    const image = options.lazy
      ? `<img src="${LAZY_IMAGE_PLACEHOLDER}" data-lazy-src="${escapeHtml(url)}" alt="" loading="lazy" fetchpriority="low" decoding="async">`
      : `<img src="${escapeHtml(url)}" alt="${escapeHtml(imageAlt)}" loading="lazy" decoding="async">`;
    return url
    ? `<figure class="detail-photo-tile${options.selectable ? " is-selectable" : ""}" data-photo-index="${index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}">${selector}${image}<figcaption>${escapeHtml(label)}</figcaption></figure>`
      : `<figure class="detail-photo-tile is-missing${options.selectable ? " is-selectable" : ""}" data-photo-index="${index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}">${selector}<div>照片載入中</div><figcaption>${escapeHtml(label)}</figcaption></figure>`;
  }).join("");
  const nextOffset = offset + visiblePhotos.length;
  const loadMore = options.limit && nextOffset < photos.length
    ? `<button class="btn btn-soft photo-load-more" type="button" data-load-more-photos>載入更多照片（還有 ${photos.length - nextOffset} 張）</button>`
    : "";
  return `${tiles}${loadMore}`;
}

function renderTravelTimeline(trip, photos, options = {}) {
  if (!photos.length) return `<div class="detail-empty">這趟旅程還沒有照片。</div>`;

  const items = photos.map((photo, index) => getPhotoTimelineItem(trip, photo, index));
  items.sort((a, b) => {
    if (a.sortValue !== b.sortValue) return a.sortValue - b.sortValue;
    return a.index - b.index;
  });

  const dayGroups = new Map();
  items.forEach((item) => {
    if (!dayGroups.has(item.dayKey)) {
      dayGroups.set(item.dayKey, {
        dayNumber: item.dayNumber,
        dateLabel: item.dateLabel,
        events: new Map(),
        items: []
      });
    }
    const day = dayGroups.get(item.dayKey);
    const eventKey = `${item.location}::${item.timeLabel}`;
    if (!day.events.has(eventKey)) {
      day.events.set(eventKey, { location: item.location, timeLabel: item.timeLabel, photos: [] });
    }
    day.events.get(eventKey).photos.push(item);
    day.items.push(item);
  });

  return [...dayGroups.values()].map((day) => `
    <section class="travel-day">
      <header class="travel-day-header">
        <div>
          <p class="travel-day-label">DAY ${escapeHtml(day.dayNumber)} · ${escapeHtml(day.dateLabel)}</p>
          <h3>${escapeHtml([...new Set(day.items.map((item) => item.location))].join(" / "))}</h3>
        </div>
        <span>${day.items.length} 張</span>
      </header>
      <div class="travel-day-events">
        ${[...day.events.values()].map((event) => `
          <article class="travel-event">
            <div class="travel-event-rail" aria-hidden="true"><span></span></div>
            <div class="travel-event-content">
              <div class="travel-event-head">
                <time>${escapeHtml(event.timeLabel)}</time>
                <h4>${escapeHtml(event.location)}</h4>
              </div>
              <div class="detail-photo-grid travel-event-photos">
                ${event.photos.map((item) => renderTimelinePhotoTile(item, options)).join("")}
              </div>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function renderTimelinePhotoTile(item, options = {}) {
  const photo = item.photo;
  const url = getPhotoUrl(photo);
  const label = photo.original_name || photo.name || `照片 ${item.index + 1}`;
  const selector = options.selectable
    ? `<label class="photo-download-check" title="選取刪除照片"><input type="checkbox" data-delete-photo-key="${escapeHtml(getPhotoSelectionKey(photo, item.index))}" aria-label="選取刪除${escapeHtml(label)}"><span aria-hidden="true"></span></label>`
    : "";
  return url
    ? `<figure class="detail-photo-tile${options.selectable ? " is-selectable" : ""}" data-photo-index="${item.index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}">${selector}<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async"><figcaption>${escapeHtml(label)}</figcaption></figure>`
      : `<figure class="detail-photo-tile${options.selectable ? " is-selectable" : ""} is-missing" data-photo-index="${item.index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}">${selector}<div>照片載入中</div><figcaption>${escapeHtml(label)}</figcaption></figure>`;
}

function getPhotoTimelineItem(trip, photo, index) {
  const linkedStop = getTripStops(trip).find((stop) => String(stop.id) === String(photo?.trip_stop_id));
  const takenAt = getPhotoTakenAt(photo);
  const tripStart = parseTimelineDate(trip?.travel_date || trip?.date_start);
  const stopDate = linkedStop?.day?.date ? parseTimelineDate(linkedStop.day.date)?.date : null;
  const date = takenAt?.date || stopDate || tripStart?.date || null;
  const dayKey = date ? toTimelineDateKey(date) : "unknown";
  const dayNumber = tripStart?.date && date
    ? Math.max(1, Math.round((date - tripStart.date) / 86400000) + 1)
    : 1;
  const location = linkedStop?.name || getPhotoTimelineLocation(trip, photo);
  const timeLabel = takenAt?.hasTime
    ? formatTimelineTime(takenAt.date)
    : linkedStop?.arrival_time || "未記錄時間";
  return {
    photo,
    index,
    date,
    dayKey,
    dayNumber,
    dateLabel: date ? formatTimelineDate(date) : "日期未記錄",
    location,
    timeLabel,
    sortValue: date ? date.getTime() : Number.MAX_SAFE_INTEGER
  };
}

function getPhotoTakenAt(photo) {
  const raw = photo?.takenAt ?? photo?.taken_at ?? photo?.capturedAt ?? photo?.captured_at ?? photo?.date_taken;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = parseTimelineDate(raw);
  if (!parsed) return null;
  return { date: parsed.date, hasTime: parsed.hasTime };
}

function parseTimelineDate(raw) {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : { date: raw, hasTime: true };
  }
  if (typeof raw === "number") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : { date, hasTime: true };
  }

  const text = String(raw).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
    return Number.isNaN(date.getTime()) ? null : { date, hasTime: !!match[4] };
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : { date, hasTime: /\d{1,2}:\d{2}/.test(text) };
}

function getPhotoTimelineLocation(trip, photo) {
  const location = photo?.location_name || photo?.location || photo?.place_name || photo?.place || photo?.address;
  if (location) return String(location);
  const gps = photo?.gps && typeof photo.gps === "object" ? photo.gps : photo;
  const lat = numberOrNull(gps?.lat ?? gps?.latitude ?? gps?.gps_lat);
  const lng = numberOrNull(gps?.lng ?? gps?.longitude ?? gps?.gps_lng);
  if (lat !== null && lng !== null) return `GPS ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  return getTripLocations(trip)[0] || "未記錄地點";
}

function toTimelineDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTimelineDate(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatTimelineTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function handleDetailPhotoClick(event) {
  if (event.target.closest(".photo-download-check")) return;
  const tile = event.target.closest("[data-photo-index]");
  if (!tile) return;
  openPhotoViewer(Number(tile.dataset.photoIndex));
}

function handleDetailPhotoKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const tile = event.target.closest("[data-photo-index]");
  if (!tile) return;
  event.preventDefault();
  openPhotoViewer(Number(tile.dataset.photoIndex));
}

function handleDetailPhotoSelection(event) {
  const checkbox = event.target.closest("[data-delete-photo-key]");
  if (!checkbox) return;
  const key = checkbox.dataset.deletePhotoKey;
  if (checkbox.checked) state.selectedDeleteIndexes.add(key);
  else state.selectedDeleteIndexes.delete(key);
  updateDetailDeleteUI();
}

function updateDetailDeleteUI() {
  const button = $("deleteSelectedDetailPhotosBtn");
  if (!button) return;
  const count = state.selectedDeleteIndexes.size;
  button.disabled = count === 0;
  button.textContent = count ? `刪除選取照片（${count}）` : "刪除選取照片（0）";
}

function syncDetailDeleteCheckboxes() {
  document.querySelectorAll("[data-delete-photo-key]").forEach((checkbox) => {
    checkbox.checked = state.selectedDeleteIndexes.has(checkbox.dataset.deletePhotoKey);
  });
  updateDetailDeleteUI();
}

function selectAllDetailPhotos() {
  const trip = state.editingTrip;
  if (!trip || state.sharedMode || trip._isGroup) return;
  state.selectedDeleteIndexes = new Set(getTripPhotos(trip).map((photo, index) => getPhotoSelectionKey(photo, index)));
  syncDetailDeleteCheckboxes();
}

function clearDetailPhotoSelection() {
  state.selectedDeleteIndexes.clear();
  syncDetailDeleteCheckboxes();
}

async function openPhotoViewer(index) {
  const photos = getTripPhotos(state.editingTrip);
  if (!photos[index]) return;
  state.viewerPhotos = photos;
  state.viewerIndex = Math.max(0, Math.min(index, photos.length - 1));
  state.viewerZoom = 1;
  $("photoViewer").showModal();
  await ensurePhotoUrl(state.viewerPhotos[state.viewerIndex]);
  renderPhotoViewer();
}

async function ensurePhotoUrl(photo) {
  if (!photo || getPhotoUrl(photo) || !photo.storage_path) return getPhotoUrl(photo);
  await hydratePhotoUrls([photo.storage_path]);
  return getPhotoUrl(photo);
}

function renderPhotoViewer() {
  const photo = state.viewerPhotos[state.viewerIndex];
  if (!photo) return;
  const url = getPhotoUrl(photo);
  const label = photo.original_name || photo.name || `照片 ${state.viewerIndex + 1}`;
  const linkedStop = getTripStops(state.editingTrip).find((stop) => String(stop.id) === String(photo.trip_stop_id));
  const takenAt = getPhotoTakenAt(photo);
  const viewerLocation = linkedStop?.name || getPhotoTimelineLocation(state.editingTrip, photo);
  $("photoViewerTitle").textContent = label;
  $("photoViewerMeta").textContent = [
    takenAt?.date ? `${takenAt.date.getFullYear()}.${String(takenAt.date.getMonth() + 1).padStart(2, "0")}.${String(takenAt.date.getDate()).padStart(2, "0")}${takenAt.hasTime ? ` · ${formatTimelineTime(takenAt.date)}` : ""}` : "",
    viewerLocation ? `📍 ${viewerLocation}` : ""
  ].filter(Boolean).join("  ");
  $("photoViewerCaption").textContent = photo.caption || "";
  $("photoViewerCounter").textContent = `${state.viewerIndex + 1} / ${state.viewerPhotos.length}`;
  $("photoViewerImage").hidden = !url;
  $("photoViewerImage").src = url;
  applyViewerZoom();
  $("photoViewerMissing").hidden = !!url;
  $("photoViewerPrevBtn").hidden = state.viewerPhotos.length < 2;
  $("photoViewerNextBtn").hidden = state.viewerPhotos.length < 2;
  $("photoViewerDownloadBtn").hidden = !url || (state.sharedMode && !state.editingTrip?.can_download);
  const coverButton = $("photoViewerCoverBtn");
  const canSetCover = !state.sharedMode && !!state.user && !state.editingTrip?._isGroup && !!photo.storage_path;
  if (coverButton) {
    coverButton.hidden = !canSetCover;
    coverButton.disabled = !canSetCover || photo.storage_path === state.editingTrip?.cover_path;
    coverButton.textContent = photo.storage_path === state.editingTrip?.cover_path ? "目前封面" : "設為封面";
  }
  $("photoViewerDeleteBtn").hidden = state.sharedMode || !state.user || !!state.editingTrip?._isGroup;
}

async function changePhotoViewer(direction) {
  if (!state.viewerPhotos.length) return;
  state.viewerIndex = (state.viewerIndex + direction + state.viewerPhotos.length) % state.viewerPhotos.length;
  state.viewerZoom = 1;
  await ensurePhotoUrl(state.viewerPhotos[state.viewerIndex]);
  renderPhotoViewer();
}

function applyViewerZoom() {
  const image = $("photoViewerImage");
  if (!image) return;
  const zoom = Math.min(3, Math.max(1, state.viewerZoom));
  state.viewerZoom = zoom;
  image.style.transform = `scale(${zoom})`;
  image.classList.toggle("is-zoomed", zoom > 1);
  $("photoViewerZoomResetBtn").textContent = `${Math.round(zoom * 100)}%`;
  $("photoViewerZoomOutBtn").disabled = zoom <= 1;
  $("photoViewerZoomInBtn").disabled = zoom >= 3;
}

function changeViewerZoom(step) {
  if (!state.viewerPhotos.length) return;
  state.viewerZoom += step;
  applyViewerZoom();
}

function resetViewerZoom() {
  state.viewerZoom = 1;
  applyViewerZoom();
}

function toggleViewerZoom() {
  state.viewerZoom = state.viewerZoom > 1 ? 1 : 2;
  applyViewerZoom();
}

function handleViewerWheel(event) {
  if (!$("photoViewer")?.open || !state.viewerPhotos.length) return;
  event.preventDefault();
  changeViewerZoom(event.deltaY < 0 ? 0.25 : -0.25);
}

function closePhotoViewer() {
  const viewer = $("photoViewer");
  if (viewer?.open) viewer.close();
  state.viewerPhotos = [];
  state.viewerIndex = 0;
  state.viewerZoom = 1;
}

async function downloadViewerPhoto() {
  const photo = state.viewerPhotos[state.viewerIndex];
  if (!photo) return;
  if (state.sharedMode && !state.editingTrip?.can_download) {
    return toast("分享者沒有開放下載");
  }
  await downloadPhotoFile(photo);
}

async function setViewerPhotoAsCover() {
  const photo = state.viewerPhotos[state.viewerIndex];
  if (photo) await setTripPhotoAsCover(photo);
}

async function setTripPhotoAsCover(photo) {
  const trip = state.editingTrip;
  if (state.sharedMode || !state.user || !trip || trip._isGroup || !photo) return;
  if (!photo.storage_path) return toast("這張照片沒有可使用的檔案路徑");
  if (photo.storage_path === trip.cover_path) return;

  const buttons = [
    $("photoViewerCoverBtn"),
    ...document.querySelectorAll("[data-cover-photo-index]")
  ].filter(Boolean);
  buttons.forEach((button) => {
    button.disabled = true;
    if (button.id === "photoViewerCoverBtn") button.textContent = "儲存中…";
  });
  $("coverPickerStatus")?.replaceChildren(document.createTextNode("正在儲存封面…"));

  try {
    const { data, error } = await client
      .from("trips")
      .update({ cover_path: photo.storage_path })
      .eq("id", trip.id)
      .select("id,cover_path")
      .single();
    if (error) throw error;
    if (!data?.id || data.cover_path !== photo.storage_path) {
      throw new Error("封面設定沒有成功保存");
    }

    trip.cover_path = data.cover_path;
    const currentTrip = state.trips.find((item) => String(item.id) === String(trip.id));
    if (currentTrip) currentTrip.cover_path = data.cover_path;
    renderPhotoViewer();
    renderTrips();
    refreshMarkers();
    renderTripDetail(trip);
    renderCoverPicker(trip, getTripPhotos(trip));
    const pickerStatus = $("coverPickerStatus");
    if (pickerStatus) pickerStatus.textContent = `已設定目前封面 · 共 ${getTripPhotos(trip).length} 張照片`;
    toast("已設定為旅程封面");
  } catch (error) {
    console.error("[setViewerPhotoAsCover]", error);
    if (error?.code === "PGRST204" || error?.code === "42703") {
      toast("設定封面失敗：請先在 Supabase 執行 20260824_cover_path.sql");
    } else {
      toast(`設定封面失敗：${error.message || "請稍後再試"}`);
    }
    renderPhotoViewer();
    renderCoverPicker(trip, getTripPhotos(trip));
    const pickerStatus = $("coverPickerStatus");
    if (pickerStatus) pickerStatus.textContent = `設定失敗：${error.message || "請稍後再試"}`;
  }
}

async function deleteModernTripPhotoRow(photo, trip) {
  let query = client.from("trip_photos").delete({ count: "exact" }).eq("trip_id", trip.id);
  if (photo.id) query = query.eq("id", photo.id);
  else if (photo.storage_path) query = query.eq("storage_path", photo.storage_path);
  else throw new Error("照片缺少可刪除的資料編號");

  const { error, count } = await query;
  if (error) throw error;
  if (count === 0) throw new Error("找不到這張照片，可能已被刪除");

  let verify = client.from("trip_photos").select("id").eq("trip_id", trip.id);
  if (photo.id) verify = verify.eq("id", photo.id);
  else verify = verify.eq("storage_path", photo.storage_path);
  const { data: remaining, error: verifyError } = await verify.limit(1);
  if (verifyError) throw verifyError;
  if (Array.isArray(remaining) && remaining.length) throw new Error("照片資料沒有成功刪除");
  return { id: photo.id, storage_path: photo.storage_path };
}

async function deleteSelectedDetailPhotos() {
  const trip = state.editingTrip;
  if (state.sharedMode || !trip || trip._isGroup) return;
  const photos = getTripPhotos(trip).filter((photo, index) => state.selectedDeleteIndexes.has(getPhotoSelectionKey(photo, index)));
  if (!photos.length) return toast("請先勾選要刪除的照片");
  if (!confirm(`確定要刪除選取的 ${photos.length} 張照片嗎？此動作無法復原。`)) return;

  const button = $("deleteSelectedDetailPhotosBtn");
  if (button) {
    button.disabled = true;
    button.textContent = `刪除中 0/${photos.length}`;
  }

  const deletedPhotos = [];
  try {
    const isLegacy = state.schemaMode === "legacy" || trip._legacy;
    if (isLegacy) {
      const selectedPaths = new Set(photos.map((photo) => photo.storage_path).filter(Boolean));
      const current = parseLegacyPhotos(trip.photos_meta).length
        ? parseLegacyPhotos(trip.photos_meta)
        : getTripPhotos(trip).map((photo) => ({
          path: photo.storage_path,
          original_name: photo.original_name || photo.name || "照片",
        }));
      const next = current.filter((photo) => !selectedPaths.has(photo.path));
      const { data, error } = await client
        .from("trips")
        .update({ photos_meta: JSON.stringify(next) })
        .eq("id", trip.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("照片清單沒有成功更新");
      deletedPhotos.push(...photos);
    } else {
      for (let index = 0; index < photos.length; index += 1) {
        await deleteModernTripPhotoRow(photos[index], trip);
        deletedPhotos.push(photos[index]);
        if (button) button.textContent = `刪除中 ${deletedPhotos.length}/${photos.length}`;
      }
    }

    const paths = deletedPhotos.map((photo) => photo.storage_path).filter(Boolean);
    let storageClean = true;
    if (paths.length) {
      const { error: storageError } = await client.storage.from(state.storageBucket).remove([...new Set(paths)]);
      if (storageError) {
        console.error("[deleteSelectedDetailPhotos.storage]", storageError, paths);
        storageClean = false;
      }
    }

    state.selectedDeleteIndexes.clear();
    await loadTrips();
    const refreshed = state.trips.find((item) => String(item.id) === String(trip.id));
    if (refreshed) {
      await openTrip(refreshed.id);
    } else {
      closeTripDetail();
    }
    toast(storageClean ? `已刪除 ${deletedPhotos.length} 張照片` : `已刪除 ${deletedPhotos.length} 張，但部分雲端檔案清理失敗`);
  } catch (error) {
    console.error("[deleteSelectedDetailPhotos]", error);
    if (deletedPhotos.length) {
      await loadTrips();
      const refreshed = state.trips.find((item) => String(item.id) === String(trip.id));
      if (refreshed) await openTrip(refreshed.id);
      toast(`已刪除 ${deletedPhotos.length} 張；其餘照片刪除失敗：${error.message || "請稍後再試"}`);
    } else {
      toast(`批次刪除失敗：${error.message || "請稍後再試"}`);
    }
  } finally {
    updateDetailDeleteUI();
  }
}

async function deleteViewerPhoto() {
  const trip = state.editingTrip;
  const photo = state.viewerPhotos[state.viewerIndex];
  if (state.sharedMode || !trip || !photo) return;
  if (!confirm(`確定要刪除「${photo.original_name || photo.name || "這張照片"}」嗎？`)) return;

  try {
    if (state.schemaMode === "legacy" || trip._legacy) {
      const current = parseLegacyPhotos(trip.photos_meta).length
        ? parseLegacyPhotos(trip.photos_meta)
        : getTripPhotos(trip).map((item) => ({
          path: item.storage_path,
          original_name: item.original_name || item.name || "照片"
        }));
      const next = current.filter((item) => item.path !== photo.storage_path);
      const { data, error } = await client
        .from("trips")
        .update({ photos_meta: JSON.stringify(next) })
        .eq("id", trip.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("照片清單沒有成功更新");
    } else {
      await deleteModernTripPhotoRow(photo, trip);
    }

    if (photo.storage_path) {
      const { error } = await client.storage.from(state.storageBucket).remove([photo.storage_path]);
      if (error) console.error("[deleteViewerPhoto.storage]", error, photo.storage_path);
    }

    trip.trip_photos = getTripPhotos(trip).filter((item) => item !== photo && item.storage_path !== photo.storage_path);
    state.viewerPhotos = trip.trip_photos;
    if (!state.viewerPhotos.length) {
      closePhotoViewer();
      renderTripDetail(trip);
    } else {
      state.viewerIndex = Math.min(state.viewerIndex, state.viewerPhotos.length - 1);
      renderTripDetail(trip);
      renderPhotoViewer();
    }
    toast("照片已刪除");
  } catch (error) {
    console.error("[deleteViewerPhoto]", error);
    toast(`照片刪除失敗：${error.message || "請稍後再試"}`);
  }
}

async function downloadPhotoFile(photo) {
  await ensurePhotoUrl(photo);
  const url = getPhotoUrl(photo);
  if (!url) return false;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`照片下載失敗：HTTP ${response.status}`);
    const blobUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = photo.original_name || photo.name || "travel-photo.jpg";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    return true;
  } catch (error) {
    console.error("[downloadPhotoFile]", error);
    toast("照片下載失敗，請稍後再試");
    return false;
  }
}

async function downloadAllPhotos(trip, sharedMode = false, selectedPhotos = null) {
  if (sharedMode && !trip?.can_download) {
    return toast("分享者沒有開放下載");
  }

  const photos = selectedPhotos || getTripPhotos(trip);
  if (!photos.length) return toast("這趟旅程沒有可下載的照片");
  if (typeof window.JSZip !== "function") {
    if (selectedPhotos?.length) {
      toast("下載工具未載入，改為逐張下載選取照片…");
      for (const photo of photos) await downloadPhotoFile(photo);
      return;
    }
    return toast("下載工具尚未載入，請重新整理頁面");
  }

  const zip = new window.JSZip();
  const folderName = (trip.title || trip.location_name || "travel-photos")
    .replace(/[\\/:*?"<>|]+/g, "-") || "travel-photos";
  const folder = zip.folder(folderName);
  let completed = 0;
  let failed = 0;

  toast(`正在整理 ${photos.length} 張照片…`);

  for (let start = 0; start < photos.length; start += 4) {
    const batch = photos.slice(start, start + 4);
    await Promise.all(batch.map(async (photo, offset) => {
      try {
        await ensurePhotoUrl(photo);
        const url = getPhotoUrl(photo);
        if (!url) throw new Error("signed URL missing");

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const bytes = await response.arrayBuffer();
        const originalName = photo.original_name || photo.name || `photo-${start + offset + 1}.jpg`;
        const safeName = originalName.replace(/[\\/:*?"<>|]+/g, "-") || `photo-${start + offset + 1}.jpg`;
        folder.file(`${String(start + offset + 1).padStart(3, "0")}-${safeName}`, bytes);
        completed += 1;
      } catch (error) {
        failed += 1;
        console.error("[downloadAllPhotos]", photo, error);
      }
    }));
  }

  if (!completed) return toast("照片目前無法下載");

  try {
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `${folderName}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    toast(failed ? `已下載 ${completed} 張，${failed} 張無法取得` : `已下載全部 ${completed} 張照片`);
  } catch (error) {
    console.error("[downloadAllPhotos] zip", error);
    toast("照片打包失敗，請稍後再試");
  }
}

function renderDetailMap(trip) {
  const mapElement = $("detailMap");
  const lat = numberOrNull(trip.lat);
  const lng = numberOrNull(trip.lng);
  if (!detailMap) {
    detailMap = L.map(mapElement, { zoomControl: true }).setView([23.6, 121], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19
    }).addTo(detailMap);
  }
  if (detailMarker) detailMarker.remove();
  detailStopMarkers.forEach((marker) => marker.remove());
  detailStopMarkers = [];
  if (detailRouteLine) {
    detailRouteLine.remove();
    detailRouteLine = null;
  }

  const stops = getTripStops(trip)
    .map((stop, index) => ({
      ...stop,
      index,
      lat: numberOrNull(stop.lat),
      lng: numberOrNull(stop.lng)
    }))
    .filter((stop) => stop.lat !== null && stop.lng !== null);

  if (stops.length) {
    const points = stops.map((stop) => [stop.lat, stop.lng]);
    detailRouteLine = L.polyline(points, {
      color: "#9b5c2e",
      weight: 3,
      opacity: 0.72,
      dashArray: "7 8"
    }).addTo(detailMap);
    stops.forEach((stop) => {
      const marker = L.marker([stop.lat, stop.lng], {
        icon: makeStopMarkerIcon(stop.index + 1)
      }).addTo(detailMap);
      marker.bindPopup("<strong>" + escapeHtml(stop.name) + "</strong><br>" + escapeHtml(stop.arrival_time || "時間未記錄"));
      detailStopMarkers.push(marker);
    });
    const selected = stops.find((stop) => String(stop.id) === String(state.selectedStopId));
    if (selected) {
      detailMap.setView([selected.lat, selected.lng], 15);
      const selectedMarker = detailStopMarkers[stops.indexOf(selected)];
      selectedMarker?.openPopup();
    } else {
      detailMap.fitBounds(points, { padding: [36, 36], maxZoom: 14 });
    }
    $("detailMapSummary").textContent = "已記錄 " + stops.length + " 個地標 · 路線依排序連線";
    setTimeout(() => detailMap.invalidateSize(), 80);
    return;
  }

  if (lat === null || lng === null) {
    detailMap.setView([23.6, 121], 7);
    $("detailMapSummary").textContent = getTripStops(trip).length
      ? "地標尚未記錄座標"
      : "這趟旅程尚未記錄座標";
  } else {
    detailMap.setView([lat, lng], 13);
    detailMarker = L.marker([lat, lng], { icon: makeMarkerIcon(trip) }).addTo(detailMap);
  }
  setTimeout(() => detailMap.invalidateSize(), 80);
}

function makeStopMarkerIcon(order) {
  return L.divIcon({
    className: "stop-marker-wrap",
    html: "<span class=\"stop-marker\">" + escapeHtml(order) + "</span>",
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function renderDetailExpenses(trip) {
  let expenses = trip.expenses ?? trip.expense ?? null;
  if (typeof expenses === "string") {
    try { expenses = JSON.parse(expenses); } catch (error) { expenses = null; }
  }
  if (!expenses || typeof expenses !== "object") {
    $("detailExpenses").innerHTML = `<div class="detail-empty">這趟旅程尚未記錄花費。</div>`;
    return;
  }
  const categories = [
    ["transport", "交通"],
    ["hotel", "住宿"],
    ["food", "餐飲"],
    ["other", "其他"]
  ];
  const original = expenses.original && typeof expenses.original === "object" ? expenses.original : {};
  const converted = expenses.twd && typeof expenses.twd === "object" ? expenses.twd : {};
  const legacyConverted = Object.fromEntries(categories.map(([key]) => [key, expenses[key]]));
  const totalSource = Object.values(converted).some((value) => Number(value)) ? converted : legacyConverted;
  const hasOriginal = categories.some(([key]) => Number(original[key]) !== 0);
  const rowSource = hasOriginal ? original : totalSource;
  const currency = expenses.currency || expenses.orig_currency || (hasOriginal ? "原幣" : "TWD");
  const rows = categories.filter(([key]) => Number.isFinite(Number(rowSource[key])) && Number(rowSource[key]) !== 0);
  const total = categories.reduce((sum, [key]) => sum + (Number(totalSource[key]) || 0), 0);
  $("detailExpenses").innerHTML = `
    <div class="detail-expense-total"><span>約合台幣</span><strong>${total ? `NT$ ${Math.round(total).toLocaleString()}` : "尚未換算"}</strong></div>
    <div class="detail-expense-list">${rows.length ? rows.map(([key, label]) => {
      const value = Number(rowSource[key]);
      const convertedValue = Number(totalSource[key]);
      const convertedLabel = hasOriginal && Number.isFinite(convertedValue) && convertedValue !== value
        ? `<small>約 NT$ ${Math.round(convertedValue).toLocaleString()}</small>`
        : "";
      return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(currency)} ${value.toLocaleString()}${convertedLabel}</strong></div>`;
    }).join("") : `<div class="detail-empty">尚未記錄支出項目。</div>`}</div>`;
}

const expenseCategories = ["transport", "hotel", "food", "other"];

function parseExpenseRecord(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("[parseExpenseRecord]", error);
    return null;
  }
}

function getExpenseEditorValues(value) {
  const expenses = parseExpenseRecord(value) || {};
  const source = expenses.original && typeof expenses.original === "object"
    ? expenses.original
    : expenses;
  return {
    currency: expenses.orig_currency || expenses.currency || "TWD",
    transport: source.transport ?? "",
    hotel: source.hotel ?? "",
    food: source.food ?? "",
    other: source.other ?? ""
  };
}

function fillExpenseEditor(value) {
  const values = getExpenseEditorValues(value);
  $("expenseCurrencyInput").value = values.currency;
  expenseCategories.forEach((category) => {
    $(`expense${category[0].toUpperCase()}${category.slice(1)}Input`).value = values[category];
  });
}

function readExpenseEditor(existingValue) {
  const existing = parseExpenseRecord(existingValue) || {};
  const values = Object.fromEntries(expenseCategories.map((category) => {
    const id = `expense${category[0].toUpperCase()}${category.slice(1)}Input`;
    const value = Number($(id).value);
    return [category, Number.isFinite(value) && value > 0 ? value : 0];
  }));
  const hasAmount = expenseCategories.some((category) => values[category] > 0);
  if (!hasAmount) return null;

  const currency = $("expenseCurrencyInput").value || "TWD";
  const next = { ...existing, currency, orig_currency: currency, original: values };
  if (currency === "TWD") {
    next.rate = 1;
    expenseCategories.forEach((category) => { next[category] = values[category]; });
    delete next.twd;
  } else if (Number.isFinite(Number(existing.rate)) && Number(existing.rate) > 0) {
    const rate = Number(existing.rate);
    next.twd = Object.fromEntries(expenseCategories.map((category) => [category, Math.round(values[category] * rate)]));
    expenseCategories.forEach((category) => { next[category] = next.twd[category]; });
  } else {
    // Preserve the selected original amounts until a live exchange rate is available.
    expenseCategories.forEach((category) => { next[category] = values[category]; });
  }
  return JSON.stringify(next);
}

function getPublicAppUrl() {
  const configuredUrl = String(
    cfg.PUBLIC_APP_URL || "https://hao1988z.github.io/my-travel-journal/"
  ).trim();
  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      if (/^https?:$/.test(url.protocol)) {
        url.search = "";
        url.hash = "";
        return url.href.replace(/\/+$/, "");
      }
    } catch (error) {
      console.warn("[share] invalid PUBLIC_APP_URL", error);
    }
  }

  if (!/^https?:$/.test(location.protocol)) return "";
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

function getShareUrl(token) {
  const baseUrl = getPublicAppUrl();
  if (!token || !baseUrl) return "";
  const url = new URL(baseUrl);
  url.search = `?share=${encodeURIComponent(token)}`;
  url.hash = "";
  return url.href;
}

function createShareToken() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("此瀏覽器無法安全產生分享 token");
}

async function toggleTripSharing(trip, nextValue = !trip?.is_shared) {
  if (state.sharedMode) return toast("分享檢視不可修改分享設定");
  if (!trip?.id || !client) return toast("目前無法更新分享設定");

  try {
    const payload = { is_shared: Boolean(nextValue) };
    if (payload.is_shared) payload.share_token = trip.share_token || createShareToken();
    const { data, error } = await client
      .from("trips")
      .update(payload)
      .eq("id", trip.id)
      .select("id,is_shared,share_token")
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("旅程沒有成功更新，請重新整理後再試");

    Object.assign(trip, data);
    if (state.sharedTrip && String(state.sharedTrip.id) === String(trip.id)) {
      Object.assign(state.sharedTrip, data);
    }

    renderTrips();
    refreshMarkers();

    if (state.editingTrip && String(state.editingTrip.id) === String(trip.id)) {
      state.editingTrip = trip;
      if (!$('tripDetailPage')?.hidden && !state.sharedMode) {
        const activeTab = document.querySelector("[data-detail-tab].active")?.dataset.detailTab || "overview";
        renderTripDetail(trip);
        setDetailTab(activeTab);
      }
      if (!$('detailDrawer')?.hidden && !state.sharedMode) renderDrawer(trip, false);
    }

    if (!data.is_shared) {
      toast("已關閉分享");
      return;
    }

    const shareUrl = getShareUrl(data.share_token);
    if (!shareUrl) {
      toast("分享已開啟，但尚未設定公開網站網址");
      return;
    }
    if ($("tripDetailPage")?.hidden) {
      await openTrip(trip.id);
    } else {
      renderTripDetail(trip);
    }
    await copyText(shareUrl, "分享已開啟，連結已複製");
  } catch (error) {
    console.error("[toggleTripSharing]", error);
    toast(`分享設定失敗：${error.message || "未知錯誤"}`);
  }
}

function renderDrawer(trip, sharedMode) {
  resetGuestUploadState();
  const cover = getCoverUrl(trip);
  const photos = getTripPhotos(trip);
  state.selectedDownloadIndexes = new Set();
  const shareUrl = getShareUrl(trip.share_token);
  const tags = (trip.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
  const photoButtons = cover
    ? `<button class="btn btn-soft" id="downloadPhotoBtn">${sharedMode && !trip.can_download ? "不可下載" : "下載照片"}</button>`
    : "";
  const downloadAllButton = sharedMode && trip.can_download && photos.length
    ? `<button class="btn btn-primary" id="downloadAllPhotosBtn">下載全部照片（${photos.length}）</button>`
    : "";
 const downloadSelectedButton = sharedMode && trip.can_download && photos.length
   ? `<button class="btn btn-soft" id="downloadSelectedPhotosBtn" type="button" disabled>下載選取照片（0）</button>`
   : "";
  const sharedDownloadActions = sharedMode && trip.can_download && photos.length
    ? `<div class="shared-photo-download-actions">${downloadSelectedButton}${downloadAllButton}</div>`
    : "";
  const guestUpload = sharedMode && trip.can_guest_upload
    ? `
      <div class="guest-upload">
        <label for="guestPhotoInput">朋友補照片（一次最多 ${MAX_UPLOAD_FILES} 張）</label>
        <input type="file" id="guestPhotoInput" accept="image/*" multiple>
        <small>選取後會先預覽，按「確認上傳」才會送出照片。</small>
        <div id="guestUploadPreview" class="guest-upload-preview" hidden></div>
        <div class="guest-upload-actions">
          <button class="btn btn-primary" id="confirmGuestUploadBtn" type="button" disabled>確認上傳（0 張）</button>
          <button class="btn btn-soft" id="cancelGuestUploadBtn" type="button" hidden>取消選取</button>
        </div>
      </div>
    `
    : "";
  const sharedPhotoVisibleCount = Math.max(SHARED_PHOTO_PAGE_SIZE, Number(state.sharedPhotoVisibleCount) || SHARED_PHOTO_PAGE_SIZE);
  const sharedPhotoGallery = sharedMode && photos.length
    ? `
      <section class="shared-photo-section">
        <div class="shared-photo-section-head">
          <div>
            <strong>全部照片</strong>
            <span>${photos.length} 張 · 點選查看</span>
          </div>
          ${sharedDownloadActions}
        </div>
        <div class="detail-photo-grid shared-photo-grid" id="sharedPhotoGrid">
          ${renderDetailPhotoGrid(photos, "目前沒有照片", { selectable: true, lazy: true, limit: sharedPhotoVisibleCount })}
        </div>
      </section>
    `
    : "";
  const sharedItinerary = sharedMode ? renderSharedItinerary(trip) : "";
  const shareButton = !sharedMode && trip.is_shared
    ? shareUrl
      ? `<button class="btn btn-soft" id="copyShareBtn">複製分享連結</button>`
      : `<button class="btn btn-soft" id="repairShareBtn">重新建立分享連結</button>`
    : "";

  $("drawerTitle").textContent = trip.title || trip.location_name;
  $("drawerBody").innerHTML = `
    ${cover ? `<img class="detail-photo" src="${escapeHtml(cover)}" alt="${escapeHtml(trip.location_name)}">` : ""}
    <div class="chip-row">
      <span class="chip private">${trip.is_shared ? "已開啟分享" : "私人"}</span>
      <span class="chip blue">${escapeHtml(trip.location_name)}</span>
    ${trip.travel_date ? `<span class="chip blue">${formatDate(trip.travel_date)}</span>` : ""}
      ${trip.mood ? `<span class="chip">${escapeHtml(trip.mood)}</span>` : ""}
      ${tags}
    </div>
    ${trip.diary ? `<div class="diary">${escapeHtml(trip.diary)}</div>` : ""}
    ${sharedItinerary}
    ${sharedPhotoGallery}
    <div class="drawer-actions">
      ${!sharedMode ? `<button class="btn btn-primary" id="editTripBtn">編輯</button>` : ""}
     ${shareButton}
     ${photoButtons}
   </div>
    ${guestUpload}
    ${!sharedMode && trip.is_shared
      ? shareUrl
        ? `<p class="trip-meta">分享連結：${escapeHtml(shareUrl)}</p>`
        : `<p class="trip-meta">這趟旅程缺少分享 token，請重新建立分享連結。</p>`
      : ""}
  `;

  $("detailDrawer").hidden = false;
  observeLazyPhotoImages($("sharedPhotoGrid"));
  $("editTripBtn")?.addEventListener("click", () => openTripDialog(trip));
  $("copyShareBtn")?.addEventListener("click", () => copyText(shareUrl));
  $("repairShareBtn")?.addEventListener("click", () => toggleTripSharing(trip, true));
  $("sharedPhotoGrid")?.addEventListener("click", handleSharedPhotoGridClick);
  $("sharedPhotoGrid")?.addEventListener("keydown", handleDetailPhotoKeydown);
  $("sharedPhotoGrid")?.addEventListener("change", handleSharedPhotoSelection);
  $("downloadPhotoBtn")?.addEventListener("click", () => downloadCover(trip, sharedMode));
  $("downloadAllPhotosBtn")?.addEventListener("click", () => downloadAllPhotos(trip, sharedMode));
  $("downloadSelectedPhotosBtn")?.addEventListener("click", () => downloadSelectedPhotos(trip, sharedMode));
  $("guestPhotoInput")?.addEventListener("change", (event) => prepareGuestPhotos(event, trip.share_token));
  $("confirmGuestUploadBtn")?.addEventListener("click", () => uploadGuestPhotos(trip.share_token));
  $("cancelGuestUploadBtn")?.addEventListener("click", () => resetGuestUploadState());
}

function handleSharedPhotoGridClick(event) {
  const loadMoreButton = event.target.closest("[data-load-more-photos]");
  if (loadMoreButton) {
    state.sharedPhotoVisibleCount += SHARED_PHOTO_PAGE_SIZE;
    renderDrawer(state.sharedTrip, true);
    return;
  }
  handleDetailPhotoClick(event);
}

function handleSharedPhotoSelection(event) {
  const checkbox = event.target.closest("[data-download-index]");
  if (!checkbox) return;
  const index = Number(checkbox.dataset.downloadIndex);
  if (checkbox.checked) state.selectedDownloadIndexes.add(index);
  else state.selectedDownloadIndexes.delete(index);
  updateSharedDownloadUI();
}

function updateSharedDownloadUI() {
  const button = $("downloadSelectedPhotosBtn");
  if (!button) return;
  const count = state.selectedDownloadIndexes.size;
  button.disabled = count === 0;
  button.textContent = `下載選取照片（${count}）`;
}

async function downloadSelectedPhotos(trip, sharedMode) {
  if (sharedMode && !trip?.can_download) return toast("分享者沒有開放下載");
  const photos = getTripPhotos(trip).filter((_photo, index) => state.selectedDownloadIndexes.has(index));
  if (!photos.length) return toast("請先勾選要下載的照片");
  if (photos.length === 1) {
    await downloadPhotoFile(photos[0]);
    return;
  }
  await downloadAllPhotos(trip, sharedMode, photos);
}

function renderSharedItinerary(trip) {
  const days = getTripDays(trip);
  const stopCount = days.reduce((sum, day) => sum + (day.trip_stops || []).length, 0);
  if (!days.length || !stopCount) return "";

  return `
    <section class="shared-photo-section shared-itinerary-section">
      <div class="shared-photo-section-head">
        <strong>每日行程與地標</strong>
        <span>${days.length} 天 · ${stopCount} 個地標</span>
      </div>
      <div class="itinerary-list shared-itinerary-list">
        ${days.map((day) => {
          const stops = [...(day.trip_stops || [])].sort(compareStops);
          return `
            <section class="itinerary-day">
              <header class="itinerary-day-head">
                <div>
                  <p class="travel-day-label">DAY ${escapeHtml(day.day_number)}</p>
                  <h3>${escapeHtml(day.title || formatItineraryDate(day.date) || "未命名的一天")}</h3>
                </div>
                <span>${stops.length} 個地標</span>
              </header>
              <div class="itinerary-stop-list">
                ${stops.map((stop, index) => renderSharedItineraryStop(stop, index)).join("")}
              </div>
            </section>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderSharedItineraryStop(stop, index) {
  const time = [stop.arrival_time, stop.departure_time].filter(Boolean).join(" — ");
  const meta = [stop.category, time].filter(Boolean).join(" · ");
  const coordinates = numberOrNull(stop.lat) !== null && numberOrNull(stop.lng) !== null
    ? `<a class="text-action itinerary-stop-map" href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(stop.lat)}&mlon=${encodeURIComponent(stop.lng)}#map=17/${encodeURIComponent(stop.lat)}/${encodeURIComponent(stop.lng)}" target="_blank" rel="noopener">地圖 →</a>`
    : "";

  return `
    <article class="itinerary-stop shared-itinerary-stop">
      <span aria-hidden="true"></span>
      <span class="itinerary-stop-order">${index + 1}</span>
      <div class="itinerary-stop-body">
        <div class="itinerary-stop-title">
          <strong>${escapeHtml(stop.name)}</strong>
          ${stop.arrival_time ? `<time>${escapeHtml(stop.arrival_time)}</time>` : ""}
        </div>
        <p>${escapeHtml(meta || stop.address || "尚未記錄時間")}</p>
        ${stop.note ? `<small>${escapeHtml(stop.note)}</small>` : ""}
        ${stop.mood ? `<span class="itinerary-stop-photos">${escapeHtml(stop.mood)}</span>` : ""}
      </div>
      <div class="itinerary-stop-actions">${coordinates}</div>
    </article>
  `;
}

function closeDrawer() {
  $("detailDrawer").hidden = true;
  state.editingTrip = null;
}

function closeTripDialog() {
  if (state.isSavingTrip) return toast("照片正在上傳，請稍候完成");
  clearPhotoPreview();
  $("tripDialog").close();
}

function closeGroupDialog() {
  const dialog = $("groupDialog");
  if (dialog?.open) dialog.close();
}

function openGroupDialog() {
  if (state.sharedMode) return toast("分享檢視不可建立大行程");
  if (state.schemaMode !== "modern") return toast("大行程功能需要目前的 trips schema");

  const candidates = state.trips
    .filter((trip) => !trip.parent_trip_id && getChildTrips(trip.id).length === 0)
    .sort(compareTripsByDate);
  if (candidates.length < 1) return toast("目前沒有可加入大行程的小行程");

  $("groupForm")?.reset();
  $("groupFormStatus").textContent = "選取兩趟以上，就能組成上海・蘇州這類大行程。";
  $("groupTripChoices").innerHTML = candidates.map((trip) => {
    const title = trip.title || trip.location_name || "未命名旅程";
    const start = trip.travel_date || trip.date_start || "";
    const end = trip.travel_date_end || trip.date_end || start;
    return `
      <label class="group-trip-choice">
        <input type="checkbox" name="groupTripIds" value="${escapeHtml(trip.id)}">
        <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(trip.location_name || trip.location || "未記錄地點")} · ${escapeHtml(formatDateRange(start, end))}</small></span>
      </label>
    `;
  }).join("");
  $("groupDialog")?.showModal();
}

async function saveTripGroup(event) {
  event.preventDefault();
  if (state.sharedMode) return toast("分享檢視不可建立大行程");
  if (!client || !state.user) return toast("請先登入");
  if (state.schemaMode !== "modern") return toast("大行程功能需要目前的 trips schema");

  const title = $("groupTitleInput").value.trim();
  const selectedIds = [...document.querySelectorAll('input[name="groupTripIds"]:checked')].map((input) => input.value);
  const children = state.trips.filter((trip) => selectedIds.includes(String(trip.id)));
  if (!title) return toast("請輸入大行程名稱");
  if (children.length < 2) return toast("請至少選擇兩個小行程");

  const dates = children
    .flatMap((trip) => [trip.travel_date || trip.date_start, trip.travel_date_end || trip.date_end])
    .filter(Boolean)
    .sort();
  const locations = [...new Set(children.flatMap((trip) => getTripLocations(trip)))]
    .filter((location) => location !== "未記錄地點");
  const first = children[0];
  const payload = {
    owner_id: state.user.id,
    title,
    location_name: locations.join(" / ") || title,
    lat: numberOrNull(first.lat),
    lng: numberOrNull(first.lng),
    travel_date: dates[0] || null,
    travel_date_end: dates[dates.length - 1] || dates[0] || null,
    mood: null,
    diary: null,
    tags: ["大行程"],
    expenses: null,
    is_shared: false,
    share_token: null,
    can_download: false,
    can_guest_upload: false
  };

  const submitButton = $("saveGroupBtn");
  if (submitButton) submitButton.disabled = true;
  $("groupFormStatus").textContent = "正在建立大行程…";
  let parent = null;
  try {
    const { data, error } = await client.from("trips").insert(payload).select("*").single();
    if (error) throw error;
    parent = data;
    const { data: assigned, error: assignError } = await client
      .from("trips")
      .update({ parent_trip_id: parent.id })
      .eq("owner_id", state.user.id)
      .in("id", selectedIds)
      .select("id");
    if (assignError) {
      const detail = [assignError.message, assignError.details, assignError.hint]
        .filter(Boolean)
        .join(" · ");
      throw new Error(detail || "小行程分組寫入失敗");
    }
    if (!Array.isArray(assigned) || assigned.length !== selectedIds.length) {
      throw new Error("小行程分組未完整寫入，請重新整理後再試");
    }
    closeGroupDialog();
    toast(`已建立「${title}」大行程`);
    await loadTrips();
    openTrip(parent.id);
  } catch (error) {
    console.error("[saveTripGroup]", error);
    if (parent?.id) await deleteTripRow(parent.id);
    const detail = [error?.message, error?.details, error?.hint].filter(Boolean).join(" · ");
    const missingColumn = /parent_trip_id|column .* does not exist|schema cache/i.test(detail);
    const message = missingColumn
      ? "大行程欄位尚未同步，請確認已在目前 Supabase 專案執行 20260825_trip_groups.sql，稍候再試。"
      : detail || "大行程建立失敗";
    toast(message);
    $("groupFormStatus").textContent = "建立失敗：" + message + "。既有旅程沒有被修改。";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function openTripDialog(trip = null) {
  if (state.sharedMode) return toast("分享檢視不可編輯旅程");
  state.editingTrip = trip;
  state.locationResults = [];
  clearPhotoPreview();
  clearLocationResults();
  $("dialogTitle").textContent = trip ? "編輯旅途" : "新增旅途";
  $("deleteTripBtn").hidden = !trip;
  $("tripForm").reset();
  $("photoPreview").hidden = true;
  $("photoPreview").removeAttribute("src");

  if (trip) {
    $("titleInput").value = trip.title || "";
    $("dateInput").value = trip.travel_date || "";
    $("locationInput").value = trip.location_name || "";
    $("latInput").value = trip.lat ?? "";
    $("lngInput").value = trip.lng ?? "";
    $("moodInput").value = trip.mood || "";
    $("diaryInput").value = trip.diary || "";
    $("tagsInput").value = (trip.tags || []).join(", ");
    fillExpenseEditor(trip.expenses ?? trip.expense);
    $("sharedInput").checked = !!trip.is_shared;
    $("downloadInput").checked = !!trip.can_download;
    $("guestUploadInput").checked = !!trip.can_guest_upload;
    const cover = getCoverUrl(trip);
    if (cover) {
      $("photoPreview").src = cover;
      $("photoPreview").hidden = false;
    }
  } else {
    $("dateInput").value = new Date().toISOString().slice(0, 10);
    fillExpenseEditor(null);
  }

  $("tripDialog").showModal();
}

async function openStopDialog() {
  if (state.sharedMode) return toast("分享檢視不可新增地標");
  const trip = state.editingTrip;
  if (!trip) return;
  if (trip._isGroup) return toast("請先點入小行程，再新增地標");
  if (!state.stopSchemaAvailable) return toast("請先執行 trip_days_stops migration");

  try {
    await ensureTripDays(trip);
    populateStopDayOptions(trip);
    resetStopForm();
    $("stopDialog").showModal();
  } catch (error) {
    console.error("[openStopDialog]", error);
    toast(error.message || "每日行程初始化失敗");
  }
}

async function ensureTripDays(trip) {
  if (getTripDays(trip).length) return;
  const start = trip.travel_date || trip.date_start || "";
  const end = trip.travel_date_end || trip.date_end || start;
  const startDate = parseTimelineDate(start)?.date || null;
  const endDate = parseTimelineDate(end)?.date || startDate;
  const dayCount = startDate && endDate
    ? Math.max(1, Math.round((endDate - startDate) / 86400000) + 1)
    : 1;
  const locations = getTripLocations(trip);
  const rows = Array.from({ length: dayCount }, (_, index) => {
    const date = startDate ? new Date(startDate.getTime() + index * 86400000) : null;
    return {
      trip_id: trip.id,
      day_number: index + 1,
      date: date ? toTimelineDateKey(date) : null,
      title: locations[index] || null,
      sort_order: index
    };
  });
  const { error } = await client.from("trip_days").insert(rows);
  if (error) throw error;
  await loadTripStops();
}

function populateStopDayOptions(trip) {
  $("stopDayInput").innerHTML = getTripDays(trip).map((day) => {
    const label = "Day " + day.day_number + (day.title ? " · " + day.title : "");
    return "<option value=\"" + escapeHtml(day.id) + "\">" + escapeHtml(label) + "</option>";
  }).join("");
}

function resetStopForm() {
  $("stopForm").reset();
  $("stopFormStatus").textContent = "";
  $("stopLocationStatus").textContent = "";
  $("stopLocationResults").innerHTML = "";
  $("stopLocationResults").hidden = true;
  state.stopLocationResults = [];
}

function closeStopDialog(reset = true) {
  const dialog = $("stopDialog");
  if (dialog?.open) dialog.close();
  if (reset) resetStopForm();
}

async function saveStop(event) {
  event.preventDefault();
  if (state.sharedMode) return toast("分享檢視不可儲存地標");
  const trip = state.editingTrip;
  if (!trip || !state.stopSchemaAvailable) return;
  const dayId = $("stopDayInput").value;
  const day = getTripDays(trip).find((item) => String(item.id) === String(dayId));
  const name = $("stopNameInput").value.trim();
  if (!day || !name) return toast("請選擇 Day 並輸入地標名稱");

  const payload = {
    day_id: day.id,
    name,
    address: $("stopAddressInput").value.trim() || null,
    lat: numberOrNull($("stopLatInput").value),
    lng: numberOrNull($("stopLngInput").value),
    arrival_time: $("stopArrivalInput").value || null,
    departure_time: $("stopDepartureInput").value || null,
    category: $("stopCategoryInput").value || null,
    mood: $("stopMoodInput").value || null,
    note: $("stopNoteInput").value.trim() || null,
    sort_order: (day.trip_stops || []).length
  };
  if ((payload.lat === null) !== (payload.lng === null)) return toast("緯度與經度請一起填寫");

  const { data: savedStop, error } = await client.from("trip_stops").insert(payload).select("id").single();
  if (error) {
    console.error("[saveStop]", error);
    return toast(error.message || "地標儲存失敗");
  }

  const files = [...$("stopPhotoInput").files];
  if (files.length && savedStop?.id) {
    try {
      await uploadStopPhotos(trip.id, savedStop.id, files);
    } catch (uploadError) {
      console.error("[saveStop.photos]", uploadError);
      toast("地標已加入，但照片上傳失敗：" + uploadError.message);
    }
  }

  await loadTripStops();
  await hydratePhotoUrls(getTripPhotos(trip).map((photo) => photo.storage_path).filter(Boolean));
  renderTripDetail(trip);
  setDetailTab("itinerary");
  toast("已加入 " + name);
  const selectedDay = $("stopDayInput").value;
  resetStopForm();
  $("stopDayInput").value = selectedDay;
  $("stopFormStatus").textContent = "✓ 已加入 " + name + "，可以繼續新增地標";
}

async function uploadStopPhotos(tripId, stopId, files) {
  const uploaded = [];
  try {
    for (const file of files) {
      if (!file.type.startsWith("image/")) throw new Error("只能上傳圖片檔");
      const result = await uploadPhoto(tripId, file);
      if (result.error) {
        await rollbackUploadedPhoto(result.record);
        throw result.error;
      }
      const { error } = await client.from("trip_photos").update({ trip_stop_id: stopId }).eq("id", result.record.id);
      if (error) {
        await rollbackUploadedPhoto(result.record);
        throw error;
      }
      uploaded.push(result.record);
    }
  } catch (error) {
    await Promise.all(uploaded.map((record) => rollbackUploadedPhoto(record)));
    throw error;
  }
}

async function searchStopLocation() {
  const query = [$("stopNameInput").value.trim(), $("stopAddressInput").value.trim()].filter(Boolean).join(", ");
  if (!query) return toast("請先輸入地標名稱");
  const button = $("searchStopLocationBtn");
  button.disabled = true;
  button.textContent = "搜尋中…";
  $("stopLocationStatus").textContent = "正在尋找地標…";
  try {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "5",
      "accept-language": "zh-TW,zh,en"
    });
    const response = await fetch("https://nominatim.openstreetmap.org/search?" + params);
    if (!response.ok) throw new Error("地標搜尋失敗：HTTP " + response.status);
    const results = await response.json();
    state.stopLocationResults = Array.isArray(results) ? results.filter((result) => result.lat && result.lon) : [];
    renderStopLocationResults(query);
  } catch (error) {
    console.error("[searchStopLocation]", error);
    $("stopLocationStatus").textContent = "搜尋失敗，請手動輸入地址或座標。";
  } finally {
    button.disabled = false;
    button.textContent = "搜尋地點";
  }
}

function renderStopLocationResults(query) {
  const results = $("stopLocationResults");
  if (!state.stopLocationResults.length) {
    $("stopLocationStatus").textContent = "找不到「" + query + "」，請換個關鍵字。";
    results.hidden = true;
    return;
  }
  $("stopLocationStatus").textContent = "請選擇正確的地標：";
  results.innerHTML = state.stopLocationResults.map((result, index) => [
    "<button class=\"location-result\" type=\"button\" role=\"option\" data-stop-location-index=\"", index, "\">",
    "<strong>", escapeHtml(result.name || result.display_name?.split(",")[0] || query), "</strong>",
    "<span>", escapeHtml(result.display_name || ""), "</span></button>"
  ].join("")).join("");
  results.hidden = false;
  results.querySelectorAll("[data-stop-location-index]").forEach((button) => {
    button.addEventListener("click", () => selectStopLocation(Number(button.dataset.stopLocationIndex)));
  });
}

function selectStopLocation(index) {
  const result = state.stopLocationResults[index];
  if (!result) return;
  const name = result.name || result.display_name?.split(",")[0] || $("stopNameInput").value.trim();
  $("stopNameInput").value = name;
  $("stopAddressInput").value = result.display_name || "";
  $("stopLatInput").value = Number(result.lat).toFixed(6);
  $("stopLngInput").value = Number(result.lon).toFixed(6);
  $("stopLocationStatus").textContent = "已選擇：" + (result.display_name || name);
  $("stopLocationResults").hidden = true;
}

function pickStopOnMap() {
  if (!state.editingTrip) return;
  closeStopDialog(false);
  setDetailTab("map");
  toast("請在地圖上點選地標位置");
  setTimeout(() => {
    if (!detailMap) return;
    detailMap.once("click", (event) => {
      $("stopLatInput").value = event.latlng.lat.toFixed(6);
      $("stopLngInput").value = event.latlng.lng.toFixed(6);
      $("stopLocationStatus").textContent = "已從地圖取得座標，可繼續填寫地標資料";
      setDetailTab("itinerary");
      $("stopDialog").showModal();
    });
  }, 100);
}

async function searchLocation() {
  const query = $("locationInput").value.trim();
  if (!query) return toast("請先輸入地點名稱");

  const button = $("searchLocationBtn");
  button.disabled = true;
  button.textContent = "搜尋中…";
  $("locationSearchStatus").textContent = "正在尋找地標…";
  clearLocationResults();

  try {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "5",
      "accept-language": "zh-TW,zh,en"
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!response.ok) throw new Error(`地標搜尋失敗：HTTP ${response.status}`);
    const results = await response.json();
    state.locationResults = Array.isArray(results) ? results.filter((result) => result.lat && result.lon) : [];
    renderLocationResults(query);
  } catch (error) {
    console.error("[searchLocation]", error);
    $("locationSearchStatus").textContent = "地標搜尋失敗，請稍後再試或手動輸入座標。";
  } finally {
    button.disabled = false;
    button.textContent = "搜尋地標";
  }
}

function renderLocationResults(query) {
  const results = $("locationResults");
  if (!state.locationResults.length) {
    $("locationSearchStatus").textContent = `找不到「${query}」的地標，請換個關鍵字。`;
    results.hidden = true;
    return;
  }

  $("locationSearchStatus").textContent = "請選擇正確的地標：";
  results.innerHTML = state.locationResults.map((result, index) => `
    <button class="location-result" type="button" role="option" data-location-index="${index}">
      <strong>${escapeHtml(result.name || result.display_name?.split(",")[0] || query)}</strong>
      <span>${escapeHtml(result.display_name || "")}</span>
    </button>
  `).join("");
  results.hidden = false;
  results.querySelectorAll("[data-location-index]").forEach((button) => {
    button.addEventListener("click", () => selectLocationResult(Number(button.dataset.locationIndex)));
  });
}

function selectLocationResult(index) {
  const result = state.locationResults[index];
  if (!result) return;
  const name = result.name || result.display_name?.split(",")[0] || $("locationInput").value.trim();
  $("locationInput").value = name;
  $("latInput").value = Number(result.lat).toFixed(6);
  $("lngInput").value = Number(result.lon).toFixed(6);
  $("locationSearchStatus").textContent = `已選擇：${result.display_name || name}`;
  $("locationResults").hidden = true;

  const lat = numberOrNull(result.lat);
  const lng = numberOrNull(result.lon);
  if (map && lat !== null && lng !== null) map.setView([lat, lng], 13);
}

function clearLocationResults() {
  const results = $("locationResults");
  const status = $("locationSearchStatus");
  if (!results || !status) return;
  results.innerHTML = "";
  results.hidden = true;
  status.textContent = "";
}

function clearPhotoPreview() {
  state.photoPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.photoPreviewUrls = [];
  state.selectedPhotos = [];
  const grid = $("photoPreviewGrid");
  if (grid) {
    grid.innerHTML = "";
    grid.hidden = true;
  }
  const input = $("photoInput");
  if (input) input.value = "";
}

function handlePhotoPreviewClick(event) {
  const button = event.target.closest("[data-remove-photo-index]");
  if (!button) return;
  const index = Number(button.dataset.removePhotoIndex);
  if (!Number.isInteger(index) || !state.selectedPhotos[index]) return;
  state.selectedPhotos.splice(index, 1);
  const [url] = state.photoPreviewUrls.splice(index, 1);
  if (url) URL.revokeObjectURL(url);
  renderSelectedPhotoPreviews();
}

function renderSelectedPhotoPreviews() {
  const grid = $("photoPreviewGrid");
  if (!grid) return;
  grid.innerHTML = state.selectedPhotos.map((file, index) => `
    <figure class="photo-preview-tile">
      <img src="${escapeHtml(state.photoPreviewUrls[index] || "")}" alt="${escapeHtml(file.name)}">
      <button type="button" class="photo-preview-remove" data-remove-photo-index="${index}" aria-label="移除${escapeHtml(file.name)}">×</button>
      <figcaption>${escapeHtml(file.name)}</figcaption>
    </figure>
  `).join("");
  grid.hidden = state.selectedPhotos.length === 0;
}

async function handlePhotoInput(event) {
  const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
  event.target.value = "";
  if (!files.length) return toast("請選擇圖片檔");
  const invalidFile = files.find((file) => file.size > 10 * 1024 * 1024);
  if (invalidFile) return toast(`${invalidFile.name} 超過 10MB，請壓縮或移除後再試`);
  const existing = new Set(state.selectedPhotos.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  const available = files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  const remaining = Math.max(0, MAX_UPLOAD_FILES - state.selectedPhotos.length);
  if (!remaining) return toast(`已達到 ${MAX_UPLOAD_FILES} 張照片上限`);
  if (available.length > remaining) {
    available.length = remaining;
    toast(`最多一次上傳 ${MAX_UPLOAD_FILES} 張照片`);
  }
  available.forEach((file) => {
    state.selectedPhotos.push(file);
    state.photoPreviewUrls.push(URL.createObjectURL(file));
  });
  renderSelectedPhotoPreviews();
}

function setTripSaveStatus(message) {
  const status = $("tripFormStatus");
  if (status) status.textContent = message || "";
}

function updateTripSaveProgress(done, total, fileName = "") {
  const button = $("saveTripBtn");
  const label = total ? `上傳中 ${done}/${total}` : "儲存中…";
  if (button) button.textContent = label;
  setTripSaveStatus(total
    ? `正在上傳第 ${Math.min(done + 1, total)} / ${total} 張${fileName ? `：${fileName}` : ""}`
    : "正在儲存旅程…");
}

async function saveTrip(event) {
  event.preventDefault();
  if (state.sharedMode) return toast("分享檢視不可儲存旅程");
  const trip = state.editingTrip;
  const isShared = $("sharedInput").checked;
  let shareToken = trip?.share_token || null;
  if (isShared && !shareToken) {
    try {
      shareToken = createShareToken();
    } catch (error) {
      console.error("[saveTrip.shareToken]", error);
      return toast(error.message || "無法建立安全分享連結");
    }
  }
  const payload = {
    title: $("titleInput").value.trim() || null,
    location_name: $("locationInput").value.trim(),
    lat: numberOrNull($("latInput").value),
    lng: numberOrNull($("lngInput").value),
    travel_date: $("dateInput").value || null,
    mood: $("moodInput").value || null,
    diary: $("diaryInput").value.trim() || null,
    tags: parseTags($("tagsInput").value),
    expenses: readExpenseEditor(trip?.expenses ?? trip?.expense),
    is_shared: isShared,
    share_token: shareToken,
    can_download: $("downloadInput").checked,
    can_guest_upload: $("guestUploadInput").checked,
    updated_at: new Date().toISOString()
  };

  if (!payload.location_name) return toast("請輸入地點名稱");

  const saveButton = event.submitter || $("saveTripBtn");
  const originalButtonText = saveButton?.textContent || "儲存";
  const totalPhotos = state.selectedPhotos.length;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = totalPhotos ? `上傳中 0/${totalPhotos}` : "儲存中…";
  }
  state.isSavingTrip = true;
  ["photoInput", "closeDialogBtn", "deleteTripBtn"].forEach((id) => {
    const control = $(id);
    if (control) control.disabled = true;
  });
  setTripSaveStatus(totalPhotos ? `準備上傳 ${totalPhotos} 張照片…` : "正在儲存旅程…");

  try {
    if (state.schemaMode === "legacy") {
      return await saveLegacyTrip(trip, payload, updateTripSaveProgress);
    }

    let savedTrip = trip;
    const uploadedPhotos = [];
    let committed = false;

    if (!trip) {
      const { data, error } = await client.from("trips").insert(payload).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("旅途建立後沒有回傳 id");
      savedTrip = data;
    }

    for (let index = 0; index < state.selectedPhotos.length; index += 1) {
      const file = state.selectedPhotos[index];
      updateTripSaveProgress(index, totalPhotos, file.name);
      const result = await uploadPhoto(savedTrip.id, file);
      uploadedPhotos.push(result.record);
      if (result.error) throw result.error;
      updateTripSaveProgress(index + 1, totalPhotos, file.name);
    }

    if (trip) {
      const { data, error } = await client
        .from("trips")
        .update(payload)
        .eq("id", trip.id)
        .select("id")
        .single();
      if (error) throw error;
      if (!data?.id) throw new Error("旅途更新未影響任何資料列");
      savedTrip = { ...trip, ...payload, id: data.id };
    }

    committed = true;
    clearPhotoPreview();
    $("tripDialog").close();
    toast("旅途已儲存");
    await loadTrips();
    openTrip(savedTrip.id);
  } catch (error) {
    console.error("[saveTrip]", error);
    if (!committed) {
      for (const record of uploadedPhotos.reverse()) await rollbackUploadedPhoto(record);
      if (!trip && savedTrip?.id) await deleteTripRow(savedTrip.id);
    }
    toast(error.message || "旅途儲存失敗");
  } finally {
    state.isSavingTrip = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = originalButtonText;
    }
    ["photoInput", "closeDialogBtn", "deleteTripBtn"].forEach((id) => {
      const control = $(id);
      if (control) control.disabled = false;
    });
    setTripSaveStatus("");
  }
}

async function saveLegacyTrip(trip, payload, onProgress = null) {
  const legacyPayload = {
    name: payload.title || payload.location_name,
    location: payload.location_name,
    lat: payload.lat,
    lng: payload.lng,
    date_start: payload.travel_date,
    // The legacy form only edits the start date, so preserve an existing end date.
    date_end: trip?.date_end || payload.travel_date,
    expenses: payload.expenses,
    is_shared: payload.is_shared,
    share_token: payload.share_token
  };
  const legacyPermissionPayload = {
    ...legacyPayload,
    can_download: payload.can_download,
    can_guest_upload: payload.can_guest_upload
  };
  const uploadedPhotos = [];
  let savedId = trip?.id;
  let committed = false;
  try {
    if (trip) {
      let { data, error } = await client
        .from("trips")
        .update(legacyPermissionPayload)
        .eq("id", trip.id)
        .select("id,is_shared,share_token")
        .maybeSingle();
      if (error && isMissingTripExpenseColumn(error)) {
        throw new Error("目前 Supabase trips 表缺少 expenses 欄位，請先執行 expenses migration");
      }
      if (error && isMissingTripPermissionColumn(error)) {
        ({ data, error } = await client
          .from("trips")
          .update({
            name: legacyPayload.name,
            location: legacyPayload.location,
            lat: legacyPayload.lat,
            lng: legacyPayload.lng,
            date_start: legacyPayload.date_start,
            date_end: legacyPayload.date_end,
            expenses: legacyPayload.expenses,
            is_shared: legacyPayload.is_shared,
            share_token: legacyPayload.share_token
          })
          .eq("id", trip.id)
          .select("id,is_shared,share_token")
          .maybeSingle());
      }
      if (error) throw error;
      if (!data) throw new Error("旅程沒有成功更新，請重新整理後再試");
    } else {
      const baseInsert = {
        ...legacyPayload,
        user_id: state.user.id,
        photo_count: 0
      };
      let { data, error } = await client.from("trips").insert({
        ...baseInsert,
        can_download: payload.can_download,
        can_guest_upload: payload.can_guest_upload
      }).select("id").single();
      if (error && isMissingTripPermissionColumn(error)) {
        ({ data, error } = await client.from("trips").insert(baseInsert).select("id").single());
      }
      if (error) throw error;
      savedId = data?.id;
    }

    for (let index = 0; index < state.selectedPhotos.length; index += 1) {
      const file = state.selectedPhotos[index];
      onProgress?.(index, state.selectedPhotos.length, file.name);
      const result = await uploadLegacyPhoto(savedId, file);
      uploadedPhotos.push(result.record);
      if (result.error) throw result.error;
      onProgress?.(index + 1, state.selectedPhotos.length, file.name);
    }

    if (uploadedPhotos.length) {
      const existingPhotos = parseLegacyPhotos(trip?.photos_meta).length
        ? parseLegacyPhotos(trip.photos_meta)
        : getTripPhotos(trip).map((photo) => ({
          path: photo.storage_path,
          original_name: photo.original_name || photo.name || "照片"
        })).filter((photo) => photo.path);
      const mergedPhotos = [
        ...existingPhotos,
        ...uploadedPhotos.map((photo) => ({
          path: photo.storage_path,
          original_name: photo.original_name,
          caption: ""
        }))
      ];
      const { data, error } = await client
        .from("trips")
        .update({ photos_meta: JSON.stringify(mergedPhotos) })
        .eq("id", savedId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("照片清單沒有成功更新，請重新整理後再試");
    }

    committed = true;
    clearPhotoPreview();
    $("tripDialog").close();
    toast("旅途已儲存");
    await loadTrips();
    if (savedId) openTrip(savedId);
  } catch (error) {
    console.error("[saveLegacyTrip]", error);
    if (!committed) {
      for (const record of uploadedPhotos.reverse()) await rollbackUploadedPhoto(record);
      if (!trip && savedId) await deleteTripRow(savedId);
    }
    toast(error.message || "旅途儲存失敗");
  }
}

function isMissingTripPermissionColumn(error) {
  return error?.code === "PGRST204" || error?.code === "42703";
}

function isMissingTripExpenseColumn(error) {
  return isMissingTripPermissionColumn(error) && /expenses?/i.test(error?.message || "");
}

async function uploadPhoto(tripId, file) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${state.user.id}/${tripId}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await client.storage.from(state.storageBucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false
  });
  const record = { storage_path: path, id: null };
  if (uploadError) return { record, error: uploadError };

  const { data, error: insertError } = await client
    .from("trip_photos")
    .insert({
      trip_id: tripId,
      owner_id: state.user.id,
      storage_path: path,
      original_name: file.name
    })
    .select("id, storage_path")
    .single();
  if (insertError) return { record, error: insertError };
  return { record: data, error: null };
}

async function uploadLegacyPhoto(tripId, file) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${state.user.id}/${tripId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await client.storage.from(state.storageBucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false
  });
  return {
    record: { storage_path: path, original_name: file.name, id: null },
    error
  };
}

async function rollbackUploadedPhoto(record) {
  if (!record) return;
  if (record.id) {
    const { data, error } = await client
      .from("trip_photos")
      .delete()
      .eq("id", record.id)
      .select("id");
    if (error || !Array.isArray(data) || data.length !== 1) {
      console.error("[rollbackUploadedPhoto.db]", error || new Error("photo row was not deleted"));
    }
  }
  if (record.storage_path) {
    const { error } = await client.storage.from(state.storageBucket).remove([record.storage_path]);
    if (error) console.error("[rollbackUploadedPhoto.storage]", error, record.storage_path);
  }
}

async function deleteTripRow(id) {
  const { data, error } = await client.from("trips").delete().eq("id", id).select("id");
  if (error || !Array.isArray(data) || data.length !== 1) {
    console.error("[deleteTripRow]", error || new Error("trip row was not deleted"), id);
  }
}

async function deleteCurrentTrip() {
  if (state.sharedMode) return toast("分享檢視不可刪除旅程");
  if (!state.editingTrip) return;
  if (!confirm("確定要刪除這趟旅程嗎？")) return;

  const trip = state.editingTrip;
  const paths = (trip.trip_photos || []).map((photo) => photo.storage_path).filter(Boolean);
  const { data, error } = await client.from("trips").delete().eq("id", trip.id).select("id");
  if (error) return toast(error.message);
  if (!Array.isArray(data) || data.length !== 1) return toast("刪除失敗：找不到可刪除的旅途");

  let storageClean = true;
  if (paths.length) {
    const { error: storageError } = await client.storage.from(state.storageBucket).remove([...new Set(paths)]);
    if (storageError) {
      console.error("[deleteCurrentTrip.storage]", storageError, paths);
      storageClean = false;
    }
  }

  $("tripDialog").close();
  closeDrawer();
  closeTripDetail();
  toast(storageClean ? "已刪除旅途" : "旅途已刪除，但部分照片清理失敗");
  await loadTrips();
}

async function loadSharedTrip(token) {
  if (missingConfig) {
    $("setupNote").textContent = "分享頁需要先設定 Supabase config.js。";
    return;
  }

  $("authScreen").hidden = true;
  $("appShell").hidden = false;
  document.body.classList.add("share-mode");
  $("homeDiaryBtn").hidden = true;
  $("homeNewTripBtn").hidden = true;
  $("mobileBottomNav").hidden = true;
  $("tripDialog")?.close();
  $("stopDialog")?.close();
  $("sessionStatus").textContent = "分享檢視";
  setTimeout(() => map.invalidateSize(), 80);

  const { data, error } = await client.functions.invoke("get-shared-trip", {
    body: { share_token: token }
  });

  const sharedTrip = Array.isArray(data) ? data[0] : data;
  if (error || !sharedTrip?.id || sharedTrip.is_shared !== true) {
    const errorText = [error?.message, error?.context?.statusText].filter(Boolean).join(" ");
    if (error) {
      const status = Number(error.context?.status || error.status || 0);
      console.error("[loadSharedTrip]", { status, error });
    }
    const status = Number(error?.context?.status || error?.status || 0);
    const missingFunction = status === 404 || /function was not found|requested function/i.test(errorText);
    const message = missingFunction
      ? "分享服務尚未部署，或這個分享連結不存在。"
      : "這個分享連結不存在，或已經關閉。";
    $("tripList").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    return;
  }

  state.sharedTrip = {
    ...sharedTrip,
    share_token: token,
    trip_photos: (sharedTrip.photos || sharedTrip.trip_photos || []).filter((photo) => photo.signed_url)
  };
  state.sharedPhotoVisibleCount = SHARED_PHOTO_PAGE_SIZE;
  state.editingTrip = state.sharedTrip;
  state.trips = [state.sharedTrip];
  state.photoUrls.clear();
  state.photoUrlCache.clear();
  state.photoUrlRequests.clear();
  renderTrips();
  refreshMarkers();
  renderDrawer(state.sharedTrip, true);
}

function getCoverUrl(trip) {
  const photos = getTripPhotos(trip);
  const coverPhoto = photos.find((photo) => photo.storage_path === trip.cover_path) || photos[0];
  return coverPhoto?.signed_url || (coverPhoto ? getCachedPhotoUrl(coverPhoto.storage_path) : "") || "";
}

async function downloadCover(trip, sharedMode) {
  if (sharedMode && !trip.can_download) return toast("分享者沒有開放下載");
  const cover = getCoverUrl(trip);
  if (!cover) return;
  try {
    const response = await fetch(cover);
    if (!response.ok) throw new Error(`照片下載失敗：HTTP ${response.status}`);
    const blobUrl = URL.createObjectURL(await response.blob());
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `${(trip.title || trip.location_name || "travel-photo").replace(/[\\/:*?"<>|]+/g, "-")}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (error) {
    console.error("[downloadCover]", error);
    toast("照片下載失敗，請稍後再試");
  }
}

function resetGuestUploadState({ clearInput = true } = {}) {
  state.pendingGuestPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.pendingGuestPreviewUrls = [];
  state.pendingGuestUpload = null;

  const input = $("guestPhotoInput");
  if (clearInput && input) input.value = "";

  const preview = $("guestUploadPreview");
  const confirmButton = $("confirmGuestUploadBtn");
  const cancelButton = $("cancelGuestUploadBtn");
  if (preview) {
    preview.hidden = true;
    preview.innerHTML = "";
  }
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = "確認上傳（0 張）";
  }
  if (cancelButton) cancelButton.hidden = true;
}

function renderGuestUploadPreview() {
  const pending = state.pendingGuestUpload;
  const preview = $("guestUploadPreview");
  const confirmButton = $("confirmGuestUploadBtn");
  const cancelButton = $("cancelGuestUploadBtn");
  if (!pending || !preview || !confirmButton || !cancelButton) return;

  const thumbnails = state.pendingGuestPreviewUrls.map((url, index) => `
    <figure class="guest-upload-preview-tile">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(pending.files[index].name)}">
    </figure>
  `).join("");
  const remaining = pending.files.length - state.pendingGuestPreviewUrls.length;
  preview.innerHTML = `
    <div class="guest-upload-preview-grid">${thumbnails}</div>
    <strong>已選 ${pending.files.length} 張照片${remaining > 0 ? `，另有 ${remaining} 張將一併上傳` : ""}</strong>
  `;
  preview.hidden = false;
  confirmButton.disabled = false;
  confirmButton.textContent = `確認上傳（${pending.files.length} 張）`;
  cancelButton.hidden = false;
}

function prepareGuestPhotos(event, shareToken) {
  if (!state.sharedMode || !state.sharedTrip?.can_guest_upload) {
    resetGuestUploadState();
    return toast("分享者沒有開放補照片");
  }

  const files = [...event.target.files];
  resetGuestUploadState({ clearInput: false });
  if (!files.length) return;
  if (files.length > MAX_UPLOAD_FILES) {
    event.target.value = "";
    return toast(`朋友一次最多上傳 ${MAX_UPLOAD_FILES} 張照片`);
  }
  const oversizedFile = files.find((file) => file.size > 25 * 1024 * 1024);
  if (oversizedFile) {
    event.target.value = "";
    return toast(`「${oversizedFile.name}」超過 25 MB，請先壓縮照片`);
  }
  const invalidFile = files.find((file) => !file.type.startsWith("image/"));
  if (invalidFile) {
    event.target.value = "";
    return toast(`「${invalidFile.name}」不是圖片檔`);
  }

  state.pendingGuestUpload = { files, shareToken };
  state.pendingGuestPreviewUrls = files.slice(0, 12).map((file) => URL.createObjectURL(file));
  renderGuestUploadPreview();
}

async function uploadGuestPhotos(shareToken) {
  const pending = state.pendingGuestUpload;
  if (!state.sharedMode || !state.sharedTrip?.can_guest_upload) {
    resetGuestUploadState();
    return toast("分享者沒有開放補照片");
  }
  if (!pending || pending.shareToken !== shareToken) return toast("請先選取要上傳的照片");

  const files = pending.files;
  const confirmButton = $("confirmGuestUploadBtn");
  const cancelButton = $("cancelGuestUploadBtn");

  let uploadedCount = 0;
  try {
    if (confirmButton) confirmButton.disabled = true;
    if (cancelButton) cancelButton.hidden = true;
    for (let offset = 0; offset < files.length; offset += GUEST_UPLOAD_BATCH_SIZE) {
      const batch = files.slice(offset, offset + GUEST_UPLOAD_BATCH_SIZE);
      const form = new FormData();
      form.append("share_token", shareToken);
      batch.forEach((file) => form.append("photos", file, file.name));

      const response = await fetch(`${cfg.SUPABASE_URL}/functions/v1/upload-shared-photo`, {
        method: "POST",
        headers: {
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`
        },
        body: form
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const missingFunction = response.status === 404 || payload.code === "NOT_FOUND";
        const diagnosticCode = payload.diagnostic_code ? `（錯誤代碼：${payload.diagnostic_code}）` : "";
        throw new Error(missingFunction
          ? "補照片服務尚未部署，請通知網站管理者"
          : `${payload.detail || payload.error || "上傳失敗"}${diagnosticCode}`);
      }

      uploadedCount += Number(payload.count) || batch.length;
      toast(`補照片上傳中：${uploadedCount} / ${files.length}`);
    }

    toast(`${uploadedCount} 張照片已補上`);
    await loadSharedTrip(shareToken);
  } catch (error) {
    console.error("[uploadGuestPhotos]", error);
    toast(`照片上傳中斷：已完成 ${uploadedCount} / ${files.length} 張` + (error.message ? `。${error.message}` : ""));
  } finally {
    resetGuestUploadState();
  }
}

async function copyText(text, successMessage = "分享連結已複製") {
  if (!text) return toast("目前沒有可複製的分享連結");
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
  } catch (error) {
    console.error("[copyText]", error);
    toast(`${successMessage.replace("已複製", "已開啟，但無法自動複製")}，請手動複製連結`);
  }
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseTags(value) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function formatDate(value) {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function formatDateRange(start, end) {
  if (!start) return "尚未記錄日期";
  if (!end || start === end) return formatDate(start);
  return `${formatDate(start)} — ${formatDate(end)}`;
}

function formatTripDays(start, end) {
  if (!start) return "—";
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end || start}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return "—";
  return `${Math.max(1, Math.round((endDate - startDate) / 86400000) + 1)} 天`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2400);
}
