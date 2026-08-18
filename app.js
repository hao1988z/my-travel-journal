const cfg = window.TRAVEL_JOURNAL_CONFIG || {};
const missingConfig = !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR_PROJECT_REF");
const client = missingConfig ? null : supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const bucket = cfg.PHOTO_BUCKET || "trip-photos";
const authRedirectUrl = cfg.AUTH_REDIRECT_URL || new URL("./", window.location.href).toString();

const state = {
  user: null,
  trips: [],
  diaries: [],
  photoUrls: new Map(),
  markers: new Map(),
  editingTrip: null,
  selectedPhoto: null,
  photoPreviewUrl: null,
  pendingEmail: "",
  resendTimer: null,
  sharedMode: false,
  sharedTrip: null,
  schemaMode: "modern",
  storageBucket: bucket,
  viewerPhotos: [],
  viewerIndex: 0,
  locationResults: [],
  stopLocationResults: [],
  stopSchemaAvailable: false,
  selectedStopId: null
};

const $ = (id) => document.getElementById(id);

let map;
let detailMap;
let detailMarker;
let detailStopMarkers = [];
let detailRouteLine;

boot();

async function boot() {
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
  $("homeNewTripBtn").addEventListener("click", () => openTripDialog());
  $("closeDialogBtn").addEventListener("click", closeTripDialog);
  $("closeDrawerBtn").addEventListener("click", closeDrawer);
  $("backToTripsBtn").addEventListener("click", closeTripDetail);
  $("detailEditBtn").addEventListener("click", () => {
    if (state.editingTrip) openTripDialog(state.editingTrip);
  });
  $("detailDownloadBtn").addEventListener("click", () => {
    if (state.editingTrip) downloadCover(state.editingTrip, state.sharedMode);
  });
  $("photoViewerCloseBtn").addEventListener("click", closePhotoViewer);
  $("photoViewerPrevBtn").addEventListener("click", () => changePhotoViewer(-1));
  $("photoViewerNextBtn").addEventListener("click", () => changePhotoViewer(1));
  $("photoViewerDownloadBtn").addEventListener("click", downloadViewerPhoto);
  ["detailRecentPhotos", "detailAllPhotos"].forEach((id) => {
    const container = $(id);
    container.addEventListener("click", handleDetailPhotoClick);
    container.addEventListener("keydown", handleDetailPhotoKeydown);
  });
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
  $("deleteTripBtn").addEventListener("click", deleteCurrentTrip);
  $("photoInput").addEventListener("change", handlePhotoInput);
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
  $("closeSettingsBtn").addEventListener("click", () => $("settingsSheet").close());
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
  map = L.map("map", { zoomControl: true }).setView([23.6, 121.0], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 19
  }).addTo(map);
}

async function signIn(event) {
  event.preventDefault();
  if (missingConfig) return toast("請先設定 Supabase config.js");

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
  if (missingConfig) return toast("請先設定 Supabase config.js");

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
  if (missingConfig) return toast("請先設定 Supabase config.js");

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
  state.photoUrls.clear();
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
    openLatestTripTab("diary");
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
  ["quickActionSheet", "moreMenuSheet", "settingsSheet"].forEach((id) => {
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
    if (!recent || state.schemaMode === "legacy") {
      openTripDialog();
      setTimeout(() => $("photoInput").focus(), 80);
      if (state.schemaMode === "legacy") toast("舊版資料請用新旅程流程加入照片");
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
    handleMobileNavigation("map");
    return;
  }

  if (action === "settings") {
    $("settingsEmail").textContent = state.user?.email || "登入帳號";
    openActionSheet("settingsSheet");
  }
}

function getRecentTrip() {
  return [...state.trips].sort(compareTripsByDate)[0] || null;
}

function openLatestTripTab(tabName) {
  const recent = getRecentTrip();
  if (!recent) return toast("目前還沒有旅程");
  closeActionSheets();
  openTrip(recent.id);
  setDetailTab(tabName);
}

async function loadTrips() {
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
    state.storageBucket = "photos";
    state.trips = (legacyResult.data || []).map(normalizeLegacyTrip);
    await loadStandaloneDiaries();
  }

  await loadTripStops();
  await hydratePhotoUrls();
  renderTrips();
  refreshMarkers();
}

async function loadTripStops() {
  state.stopSchemaAvailable = false;
  state.trips.forEach((trip) => { trip.trip_days = []; });
  if (state.schemaMode !== "modern" || !state.trips.length) return;

  const { data, error } = await client
    .from("trip_days")
    .select("*, trip_stops(*)")
    .in("trip_id", state.trips.map((trip) => trip.id))
    .order("day_number", { ascending: true })
    .order("sort_order", { ascending: true });

  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return;
    console.error("[loadTripStops]", error);
    return;
  }

  state.stopSchemaAvailable = true;
  state.trips.forEach((trip) => {
    trip.trip_days = (data || [])
      .filter((day) => String(day.trip_id) === String(trip.id))
      .map((day) => ({
        ...day,
        trip_stops: [...(day.trip_stops || [])].sort(compareStops)
      }));
  });
}

function compareStops(a, b) {
  const orderDifference = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  if (orderDifference) return orderDifference;
  return String(a.arrival_time || "99:99").localeCompare(String(b.arrival_time || "99:99"));
}

async function loadStandaloneDiaries() {
  const { data, error } = await client
    .from("diaries")
    .select("*")
    .eq("user_id", state.user.id)
    .order("diary_date", { ascending: false });
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") {
      state.diaries = [];
      return;
    }
    console.error("[loadStandaloneDiaries]", error);
    state.diaries = [];
    return;
  }
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

async function hydratePhotoUrls() {
  state.photoUrls.clear();
  const paths = [...new Set(state.trips.flatMap((trip) =>
    (trip.trip_photos || []).map((photo) => photo.storage_path).filter(Boolean)
  ))];
  if (!paths.length) return;

  const { data, error } = await client.storage.from(state.storageBucket).createSignedUrls(paths, 60 * 60);
  if (error) {
    console.error("[hydratePhotoUrls]", error);
    return;
  }
  paths.forEach((path, index) => {
    const signedUrl = data?.[index]?.signedUrl;
    if (signedUrl) state.photoUrls.set(path, signedUrl);
  });
}

function renderTrips() {
  const list = $("tripList");
  const query = $("searchInput").value.trim().toLowerCase();
  const filtered = state.trips.filter((trip) => tripMatchesQuery(trip, query));
  const sorted = [...filtered].sort(compareTripsByDate);
  const recent = sorted[0];

  $("placeCount").textContent = state.trips.length;
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
    (trip.tags || []).join(" ")
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
  return `
    <article class="recent-trip-card" data-trip-id="${escapeHtml(trip.id)}" tabindex="0" role="button" aria-label="回顧${escapeHtml(title)}">
      <div class="recent-trip-media">
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(location)}" fetchpriority="high">` : `<div class="trip-placeholder">📍</div>`}
        <span class="recent-trip-badge">${trip.is_shared ? "已分享" : "私人"}</span>
        ${renderTripCardMenu(trip)}
      </div>
      <div class="recent-trip-body">
        <div>
          <p class="section-kicker">最近一次旅行</p>
          <h3>${escapeHtml(title)}</h3>
          <p class="recent-trip-meta">${escapeHtml(formatDateRange(start, end))} · ${escapeHtml(location)}</p>
          <p class="recent-trip-stats">${formatTripDays(start, end)} · ${photos.length} 張照片 · ${diaries.length} 篇日記</p>
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
  return `
    <article class="trip-card" data-trip-id="${escapeHtml(trip.id)}" tabindex="0" role="button" aria-label="查看${escapeHtml(title)}">
      <div class="trip-card-media">
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(location)}" loading="lazy">` : `<div class="trip-placeholder">📍</div>`}
        <span class="trip-privacy-dot" title="${trip.is_shared ? "已分享" : "私人旅程"}">${trip.is_shared ? "○" : "•"}</span>
        ${renderTripCardMenu(trip)}
      </div>
      <div class="trip-card-body">
        <div class="trip-card-title"><span>${escapeHtml(title)}</span></div>
        <div class="trip-meta">${escapeHtml(location)}</div>
        <div class="trip-card-date">${escapeHtml(formatDateRange(start, end))}</div>
        <div class="trip-card-stats"><span>📷 ${photos.length}</span><span>📝 ${diaries.length}</span><span>${escapeHtml(formatTripDays(start, end))}</span></div>
      </div>
    </article>
  `;
}

function renderTripCardMenu(trip) {
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
    if (!shareUrl) return toast("請使用 HTTP(S) 網址開啟網站後再分享");
    copyText(shareUrl);
    return;
  }

  if (action === "delete") {
    state.editingTrip = trip;
    deleteCurrentTrip();
  }
}

function refreshMarkers() {
  state.markers.forEach((marker) => map.removeLayer(marker));
  state.markers.clear();

  const points = [];
  state.trips.forEach((trip) => {
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

function openTrip(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;

  if (!state.sharedMode) closeDrawer();
  state.editingTrip = trip;

  const lat = numberOrNull(trip.lat);
  const lng = numberOrNull(trip.lng);
  if (lat !== null && lng !== null) {
    map.flyTo([lat, lng], 13, { duration: 0.8 });
  }

  if (state.sharedMode) {
    renderDrawer(trip, true);
    return;
  }

  $("appShell").hidden = true;
  $("tripDetailPage").hidden = false;
  renderTripDetail(trip);
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  const photos = getTripPhotos(trip);
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

  const diaryPreview = diaries[0]?.content?.trim() || trip.diary?.trim() || "";
  $("detailDiaryPreview").innerHTML = diaries.length
    ? renderDiaryPreview(diaries)
    : escapeHtml(diaryPreview || "這趟旅程還沒有日記，回來時記下一句當時的心情吧。");
  $("detailDiaryPreview").classList.toggle("is-empty", !diaryPreview);
  $("detailDiaryDate").textContent = diaries[0]?.diary_date || dateLabel || "尚未記錄日期";
  $("detailDiaryBody").innerHTML = renderDiaryEntries(diaries, trip.diary);
  $("detailDiaryBody").classList.toggle("is-empty", !diaries.length && !trip.diary);
  $("detailMapSummary").textContent = `${location}${dateLabel ? ` · ${dateLabel}` : ""}`;

  const recent = photos.slice(0, 6);
  const recentMarkup = renderDetailPhotoGrid(recent, "目前沒有照片");
  $("detailRecentPhotos").innerHTML = recentMarkup;
  renderTripItinerary(trip);
  $("detailAllPhotos").innerHTML = renderTravelTimeline(trip, photos);
  const hasPhotoTimes = photos.some((photo) => getPhotoTakenAt(photo) || photo.trip_stop_id);
  $("detailPhotosSummary").textContent = `${photos.length} 張照片${cover ? " · 已設定封面" : ""}${hasPhotoTimes ? " · 依照片時間分組" : " · 目前依旅程日期排列"}`;
  renderDetailExpenses(trip);
  $("detailOverviewExpenses").innerHTML = $("detailExpenses").innerHTML;
  setDetailTab("overview");
}

function getTripPhotos(trip) {
  return trip?.trip_photos || trip?.photos || [];
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
  addButton.disabled = !state.stopSchemaAvailable;
  addButton.title = state.stopSchemaAvailable ? "新增一天中的地標" : "請先執行 trip_days_stops migration";

  if (!state.stopSchemaAvailable) {
    $("detailItinerarySummary").textContent = "目前仍使用原本的旅程地點資料";
    $("detailItineraryList").innerHTML = [
      "<div class=\"itinerary-empty\"><strong>多地標功能尚未啟用</strong>",
      "<p>現有旅程不會受到影響。執行專案內的 migration 後，就能建立 Day、地標、抵達時間與每日路線。</p></div>"
    ].join("");
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
    "</div><button class=\"text-action itinerary-stop-map\" type=\"button\" data-stop-map=\"",
    escapeHtml(stop.id), "\">地圖 →</button></article>"
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
  });
  container.querySelectorAll(".itinerary-stop-list").forEach((list) => {
    list.addEventListener("drop", () => persistStopOrder(list));
  });
}

async function persistStopOrder(list) {
  if (!state.stopSchemaAvailable) return;
  const rows = [...list.querySelectorAll(".itinerary-stop")];
  const results = await Promise.all(rows.map((row, index) =>
    client.from("trip_stops").update({ sort_order: index }).eq("id", row.dataset.stopId)
  ));
  const failed = results.find((result) => result.error);
  if (failed) return toast(failed.error.message || "地標排序儲存失敗");
  toast("地標順序已儲存");
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
  return photo?.signed_url || (photo?.storage_path ? state.photoUrls.get(photo.storage_path) : "") || "";
}

function renderDetailPhotoGrid(photos, emptyText) {
  if (!photos.length) return `<div class="detail-empty">${escapeHtml(emptyText)}</div>`;
  return photos.map((photo, index) => {
    const url = getPhotoUrl(photo);
    const label = photo.original_name || photo.name || `照片 ${index + 1}`;
    return url
      ? `<figure class="detail-photo-tile" data-photo-index="${index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(label)}</figcaption></figure>`
      : `<figure class="detail-photo-tile is-missing" data-photo-index="${index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}"><div>照片載入中</div><figcaption>${escapeHtml(label)}</figcaption></figure>`;
  }).join("");
}

function renderTravelTimeline(trip, photos) {
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
                ${event.photos.map((item) => renderTimelinePhotoTile(item)).join("")}
              </div>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function renderTimelinePhotoTile(item) {
  const photo = item.photo;
  const url = getPhotoUrl(photo);
  const label = photo.original_name || photo.name || `照片 ${item.index + 1}`;
  return url
    ? `<figure class="detail-photo-tile" data-photo-index="${item.index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(label)}</figcaption></figure>`
    : `<figure class="detail-photo-tile is-missing" data-photo-index="${item.index}" tabindex="0" role="button" aria-label="查看${escapeHtml(label)}"><div>照片載入中</div><figcaption>${escapeHtml(label)}</figcaption></figure>`;
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

async function openPhotoViewer(index) {
  const photos = getTripPhotos(state.editingTrip);
  if (!photos[index]) return;
  state.viewerPhotos = photos;
  state.viewerIndex = Math.max(0, Math.min(index, photos.length - 1));
  $("photoViewer").showModal();
  await ensurePhotoUrl(state.viewerPhotos[state.viewerIndex]);
  renderPhotoViewer();
}

async function ensurePhotoUrl(photo) {
  if (!photo || getPhotoUrl(photo) || !photo.storage_path) return getPhotoUrl(photo);
  const { data, error } = await client.storage.from(state.storageBucket).createSignedUrl(photo.storage_path, 60 * 60);
  if (error) {
    console.error("[ensurePhotoUrl]", error);
    return "";
  }
  const signedUrl = data?.signedUrl || "";
  if (signedUrl) state.photoUrls.set(photo.storage_path, signedUrl);
  return signedUrl;
}

function renderPhotoViewer() {
  const photo = state.viewerPhotos[state.viewerIndex];
  if (!photo) return;
  const url = getPhotoUrl(photo);
  const label = photo.original_name || photo.name || `照片 ${state.viewerIndex + 1}`;
  $("photoViewerTitle").textContent = label;
  $("photoViewerCaption").textContent = photo.caption || "";
  $("photoViewerCounter").textContent = `${state.viewerIndex + 1} / ${state.viewerPhotos.length}`;
  $("photoViewerImage").hidden = !url;
  $("photoViewerImage").src = url;
  $("photoViewerMissing").hidden = !!url;
  $("photoViewerPrevBtn").hidden = state.viewerPhotos.length < 2;
  $("photoViewerNextBtn").hidden = state.viewerPhotos.length < 2;
  $("photoViewerDownloadBtn").hidden = !url;
}

async function changePhotoViewer(direction) {
  if (!state.viewerPhotos.length) return;
  state.viewerIndex = (state.viewerIndex + direction + state.viewerPhotos.length) % state.viewerPhotos.length;
  await ensurePhotoUrl(state.viewerPhotos[state.viewerIndex]);
  renderPhotoViewer();
}

function closePhotoViewer() {
  const viewer = $("photoViewer");
  if (viewer?.open) viewer.close();
  state.viewerPhotos = [];
  state.viewerIndex = 0;
}

async function downloadViewerPhoto() {
  const photo = state.viewerPhotos[state.viewerIndex];
  if (!photo) return;
  await ensurePhotoUrl(photo);
  const url = getPhotoUrl(photo);
  if (!url) return toast("照片目前無法下載");
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
  } catch (error) {
    console.error("[downloadViewerPhoto]", error);
    toast("照片下載失敗，請稍後再試");
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

function getShareUrl(token) {
  if (!token || !/^https?:$/.test(location.protocol)) return "";
  const url = new URL(location.href);
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
      toast("分享已開啟；請在正式 HTTP(S) 網址查看分享連結");
      return;
    }
    await copyText(shareUrl, "分享已開啟，連結已複製");
  } catch (error) {
    console.error("[toggleTripSharing]", error);
    toast(`分享設定失敗：${error.message || "未知錯誤"}`);
  }
}

function renderDrawer(trip, sharedMode) {
  const cover = getCoverUrl(trip);
  const shareUrl = getShareUrl(trip.share_token);
  const tags = (trip.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
  const photoButtons = cover
    ? `<button class="btn btn-soft" id="downloadPhotoBtn">${sharedMode && !trip.can_download ? "不可下載" : "下載照片"}</button>`
    : "";
  const guestUpload = sharedMode && trip.can_guest_upload
    ? `
      <label class="guest-upload">
        朋友補照片
        <input type="file" id="guestPhotoInput" accept="image/*">
      </label>
    `
    : "";
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
  $("editTripBtn")?.addEventListener("click", () => openTripDialog(trip));
  $("copyShareBtn")?.addEventListener("click", () => copyText(shareUrl));
  $("repairShareBtn")?.addEventListener("click", () => toggleTripSharing(trip, true));
  $("downloadPhotoBtn")?.addEventListener("click", () => downloadCover(trip, sharedMode));
  $("guestPhotoInput")?.addEventListener("change", (event) => uploadGuestPhoto(event, trip.share_token));
}

function closeDrawer() {
  $("detailDrawer").hidden = true;
  state.editingTrip = null;
}

function closeTripDialog() {
  clearPhotoPreview();
  state.selectedPhoto = null;
  $("tripDialog").close();
}

function openTripDialog(trip = null) {
  state.editingTrip = trip;
  state.selectedPhoto = null;
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
  }

  $("tripDialog").showModal();
}

async function openStopDialog() {
  const trip = state.editingTrip;
  if (!trip) return;
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
  await hydratePhotoUrls();
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
  if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl);
  state.photoPreviewUrl = null;
  $("photoPreview").removeAttribute("src");
  $("photoPreview").hidden = true;
}

async function handlePhotoInput(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("請選擇圖片檔");
  state.selectedPhoto = file;
  if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl);
  state.photoPreviewUrl = URL.createObjectURL(file);
  $("photoPreview").src = state.photoPreviewUrl;
  $("photoPreview").hidden = false;
}

async function saveTrip(event) {
  event.preventDefault();
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
    is_shared: isShared,
    share_token: shareToken,
    can_download: $("downloadInput").checked,
    can_guest_upload: $("guestUploadInput").checked,
    updated_at: new Date().toISOString()
  };

  if (!payload.location_name) return toast("請輸入地點名稱");

  if (state.schemaMode === "legacy") {
    if (state.selectedPhoto) {
      return toast("舊版旅程的照片請從原本相簿流程上傳，這次不會覆蓋既有照片");
    }
    return saveLegacyTrip(trip, payload);
  }

  let savedTrip = trip;
  let uploadedPhoto = null;
  let committed = false;

  try {
    if (!trip) {
      const { data, error } = await client.from("trips").insert(payload).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("旅途建立後沒有回傳 id");
      savedTrip = data;
    }

    if (state.selectedPhoto) {
      const result = await uploadPhoto(savedTrip.id, state.selectedPhoto);
      uploadedPhoto = result.record;
      if (result.error) throw result.error;
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
      await rollbackUploadedPhoto(uploadedPhoto);
      if (!trip && savedTrip?.id) await deleteTripRow(savedTrip.id);
    }
    toast(error.message || "旅途儲存失敗");
  }
}

async function saveLegacyTrip(trip, payload) {
  const legacyPayload = {
    name: payload.title || payload.location_name,
    location: payload.location_name,
    lat: payload.lat,
    lng: payload.lng,
    date_start: payload.travel_date,
    // The legacy form only edits the start date, so preserve an existing end date.
    date_end: trip?.date_end || payload.travel_date,
    is_shared: payload.is_shared,
    share_token: payload.share_token
  };
  try {
    let savedId = trip?.id;
    if (trip) {
      const { data, error } = await client
        .from("trips")
        .update(legacyPayload)
        .eq("id", trip.id)
        .select("id,is_shared,share_token")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("旅程沒有成功更新，請重新整理後再試");
    } else {
      const { data, error } = await client.from("trips").insert({
        ...legacyPayload,
        user_id: state.user.id,
        photo_count: 0
      }).select("id").single();
      if (error) throw error;
      savedId = data?.id;
    }
    clearPhotoPreview();
    $("tripDialog").close();
    toast("旅途已儲存");
    await loadTrips();
    if (savedId) openTrip(savedId);
  } catch (error) {
    console.error("[saveLegacyTrip]", error);
    toast(error.message || "旅途儲存失敗");
  }
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
  $("sessionStatus").textContent = "分享檢視";
  setTimeout(() => map.invalidateSize(), 80);

  const { data, error } = await client.functions.invoke("get-shared-trip", {
    body: { share_token: token }
  });

  if (error || !data?.id || data.is_shared !== true) {
    if (error) console.error("[loadSharedTrip]", error);
    $("tripList").innerHTML = `<div class="empty">這個分享連結不存在，或已經關閉。</div>`;
    return;
  }

  state.sharedTrip = {
    ...data,
    share_token: token,
    trip_photos: (data.photos || []).filter((photo) => photo.signed_url)
  };
  state.trips = [state.sharedTrip];
  state.photoUrls = new Map();
  renderTrips();
  refreshMarkers();
  renderDrawer(state.sharedTrip, true);
}

function getCoverUrl(trip) {
  const photos = getTripPhotos(trip);
  const coverPhoto = photos.find((photo) => photo.storage_path === trip.cover_path) || photos[0];
  return coverPhoto?.signed_url || (coverPhoto ? state.photoUrls.get(coverPhoto.storage_path) : "") || "";
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

async function uploadGuestPhoto(event, shareToken) {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("請選擇圖片檔");

  const form = new FormData();
  form.append("share_token", shareToken);
  form.append("photo", file);

  const response = await fetch(`${cfg.SUPABASE_URL}/functions/v1/upload-shared-photo`, {
    method: "POST",
    headers: {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`
    },
    body: form
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    return toast(payload.error || "上傳失敗");
  }

  toast("照片已補上");
  await loadSharedTrip(shareToken);
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
