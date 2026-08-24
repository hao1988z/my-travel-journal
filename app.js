const cfg = window.TRAVEL_JOURNAL_CONFIG || {};
const missingConfig = !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR_PROJECT_REF");
const client = missingConfig ? null : supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const bucket = cfg.PHOTO_BUCKET || "trip-photos";
const authRedirectUrl = cfg.AUTH_REDIRECT_URL || new URL("./", window.location.href).toString();
const MAX_UPLOAD_FILES = 100;
const UPLOAD_BATCH_SIZE = 3;

const state = {
  user: null,
  trips: [],
  photoUrls: new Map(),
  markers: new Map(),
  editingTrip: null,
  selectedPhotos: [],
  photoPreviewUrls: [],
  stopMarkers: new Map(),
  stopSchemaAvailable: false,
  stopSchemaError: "",
  pendingEmail: "",
  resendTimer: null,
  sharedMode: false,
  sharedTrip: null,
  downloadSelection: new Set(),
  lightboxTrip: null,
  lightboxPhotos: [],
  lightboxIndex: 0,
  lightboxSharedMode: false
};

const $ = (id) => document.getElementById(id);

let map;

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
  $("newTripBtn").addEventListener("click", () => openTripDialog());
  $("closeDialogBtn").addEventListener("click", closeTripDialog);
  $("closeDrawerBtn").addEventListener("click", closeDrawer);
  $("tripForm").addEventListener("submit", saveTrip);
  $("deleteTripBtn").addEventListener("click", deleteCurrentTrip);
  $("closeDayDialogBtn").addEventListener("click", closeDayDialog);
  $("cancelDayDialogBtn").addEventListener("click", closeDayDialog);
  $("dayForm").addEventListener("submit", saveDay);
  $("closeStopDialogBtn").addEventListener("click", closeStopDialog);
  $("cancelStopDialogBtn").addEventListener("click", closeStopDialog);
  $("stopForm").addEventListener("submit", saveStop);
  $("photoInput").addEventListener("change", handlePhotoInput);
  $("searchInput").addEventListener("input", renderTrips);
  $("closeLightboxBtn").addEventListener("click", closePhotoLightbox);
  $("previousPhotoBtn").addEventListener("click", () => moveLightbox(-1));
  $("nextPhotoBtn").addEventListener("click", () => moveLightbox(1));
  $("lightboxDownloadBtn").addEventListener("click", downloadLightboxPhoto);
  $("photoLightbox").addEventListener("click", (event) => {
    if (event.target === $("photoLightbox")) closePhotoLightbox();
  });
  document.addEventListener("keydown", handleLightboxKeyboard);
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
  state.trips = [];
  state.photoUrls.clear();
  refreshMarkers();
  renderTrips();
  closeDrawer();
}

function setSessionUI() {
  const signedIn = !!state.user;
  $("authScreen").hidden = signedIn;
  $("appShell").hidden = !signedIn;
  $("newTripBtn").hidden = !signedIn;
  $("signOutBtn").hidden = !signedIn;
  $("sessionStatus").textContent = signedIn ? `私人雲端 · ${state.user.email}` : "私人雲端";
  if (signedIn) setTimeout(() => map.invalidateSize(), 80);
}

async function loadTrips() {
  const { data, error } = await client
    .from("trips")
    .select("*, trip_photos(*)")
    .order("travel_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) return toast(error.message);
  state.trips = data || [];
  await loadTripStops();
  await hydratePhotoUrls();
  renderTrips();
  refreshMarkers();
}

async function loadTripStops() {
  state.stopSchemaAvailable = false;
  state.stopSchemaError = "";
  state.trips.forEach((trip) => { trip.trip_days = []; });
  if (!state.trips.length) return;

  const tripIds = state.trips.map((trip) => trip.id).filter(Boolean);
  const { data: days, error: daysError } = await client
    .from("trip_days")
    .select("*")
    .in("trip_id", tripIds)
    .order("sort_order", { ascending: true })
    .order("day_number", { ascending: true });

  if (daysError) {
    state.stopSchemaError = daysError.code || daysError.message || "trip_days 讀取失敗";
    if (daysError.code !== "PGRST205") console.error("[loadTripStops.days]", daysError);
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
      .order("sort_order", { ascending: true })
      .order("arrival_time", { ascending: true, nullsFirst: false });

    if (stopsError) {
      state.stopSchemaError = stopsError.code || stopsError.message || "trip_stops 讀取失敗";
      if (stopsError.code !== "PGRST205") console.error("[loadTripStops.stops]", stopsError);
      return;
    }
    stopRows = stops || [];
  }

  const stopsByDay = new Map();
  stopRows.forEach((stop) => {
    if (!stopsByDay.has(stop.day_id)) stopsByDay.set(stop.day_id, []);
    stopsByDay.get(stop.day_id).push(stop);
  });

  const daysByTrip = new Map();
  dayRows.forEach((day) => {
    const normalizedDay = { ...day, trip_stops: stopsByDay.get(day.id) || [] };
    if (!daysByTrip.has(day.trip_id)) daysByTrip.set(day.trip_id, []);
    daysByTrip.get(day.trip_id).push(normalizedDay);
  });

  state.trips.forEach((trip) => {
    trip.trip_days = daysByTrip.get(trip.id) || [];
  });
  state.stopSchemaAvailable = true;
}

async function hydratePhotoUrls() {
  state.photoUrls.clear();
  const paths = [...new Set(state.trips.flatMap((trip) =>
    (trip.trip_photos || []).map((photo) => photo.storage_path).filter(Boolean)
  ))];
  if (!paths.length) return;

  const { data, error } = await client.storage.from(bucket).createSignedUrls(paths, 60 * 60);
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
  const filtered = state.trips.filter((trip) => {
    const haystack = [trip.title, trip.location_name, trip.travel_date, trip.mood, trip.diary, (trip.tags || []).join(" ")]
      .join(" ")
      .toLowerCase();
    return !query || haystack.includes(query);
  });

  $("placeCount").textContent = state.trips.length;
  $("photoCount").textContent = state.trips.reduce((sum, trip) => sum + (trip.trip_photos?.length || 0), 0);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty">還沒有旅途。按右上角「新增旅途」，先放進第一張照片。</div>`;
    return;
  }

  list.innerHTML = filtered.map((trip) => {
    const cover = getCoverUrl(trip);
    return `
      <article class="trip-card" data-trip-id="${trip.id}">
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(trip.location_name)}">` : `<div class="trip-placeholder">📍</div>`}
        <div class="trip-card-body">
          <div class="trip-card-title">
            <span>${escapeHtml(trip.title || trip.location_name)}</span>
            <span>${escapeHtml((trip.mood || "").split(" ")[0])}</span>
          </div>
          <div class="trip-meta">${escapeHtml(trip.location_name)}${trip.travel_date ? ` · ${formatDate(trip.travel_date)}` : ""}</div>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll(".trip-card").forEach((card) => {
    card.addEventListener("click", () => openTrip(card.dataset.tripId));
  });
}

function refreshMarkers() {
  state.markers.forEach((marker) => map.removeLayer(marker));
  state.markers.clear();
  state.stopMarkers.forEach((marker) => map.removeLayer(marker));
  state.stopMarkers.clear();

  const points = [];
  state.trips.forEach((trip) => {
    const lat = numberOrNull(trip.lat);
    const lng = numberOrNull(trip.lng);
    if (lat !== null && lng !== null) {
      const marker = L.marker([lat, lng], { icon: makeMarkerIcon(trip) }).addTo(map);
      marker.on("click", () => openTrip(trip.id));
      state.markers.set(trip.id, marker);
      points.push([lat, lng]);
    }

    getTripStops(trip).forEach((stop, index) => {
      const stopLat = numberOrNull(stop.lat);
      const stopLng = numberOrNull(stop.lng);
      if (stopLat === null || stopLng === null) return;
      const stopMarker = L.marker([stopLat, stopLng], {
        icon: makeStopIcon(index + 1),
        zIndexOffset: 300
      }).addTo(map);
      stopMarker.bindTooltip(`${index + 1}. ${stop.name || "地標"}`, { direction: "top" });
      stopMarker.on("click", () => openTrip(trip.id));
      state.stopMarkers.set(stop.id, stopMarker);
      points.push([stopLat, stopLng]);
    });
  });

  if (points.length) {
    map.fitBounds(points, { padding: [44, 44], maxZoom: 8 });
  }
}

function makeStopIcon(order) {
  return L.divIcon({
    className: "stop-marker-wrap",
    html: `<span class="stop-marker">${escapeHtml(order)}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
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
  state.editingTrip = trip;

  const lat = numberOrNull(trip.lat);
  const lng = numberOrNull(trip.lng);
  if (lat !== null && lng !== null) {
    map.flyTo([lat, lng], 13, { duration: 0.8 });
  }

  renderDrawer(trip, state.sharedMode);
}

function getShareUrl(token) {
  if (!token || !/^https?:$/.test(location.protocol)) return "";
  const url = new URL(location.href);
  url.search = `?share=${encodeURIComponent(token)}`;
  url.hash = "";
  return url.href;
}

function renderDrawer(trip, sharedMode) {
  const shareUrl = getShareUrl(trip.share_token);
  const mapUrl = getMapUrl(trip);
  const tags = (trip.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
  const photos = getTripPhotos(trip).filter((photo) => getPhotoUrl(photo));
  const canDownload = !sharedMode || trip.can_download;
  state.downloadSelection.clear();
  const photoGallery = photos.length
    ? `<div class="photo-gallery">${photos.map((photo, index) => `
        <figure class="photo-tile">
          <button class="photo-open-btn" type="button" data-photo-index="${index}" aria-label="放大第 ${index + 1} 張照片">
            <img src="${escapeHtml(getPhotoUrl(photo))}" alt="${escapeHtml(photo.caption || trip.location_name)}">
            <span class="photo-zoom-badge" aria-hidden="true">放大</span>
          </button>
          ${canDownload ? `
            <label class="photo-select-control" title="選取第 ${index + 1} 張照片">
              <input type="checkbox" data-download-photo-index="${index}">
              <span aria-hidden="true">✓</span>
            </label>
          ` : ""}
          ${!sharedMode ? `<button class="photo-delete-btn" type="button" data-photo-id="${escapeHtml(photo.id)}">刪除</button>` : ""}
        </figure>
      `).join("")}</div>`
    : "";
  const downloadPanel = photos.length && canDownload
    ? `
      <div class="photo-download-panel">
        <div>
          <strong>儲存照片</strong>
          <span id="downloadSelectionStatus">尚未選擇照片</span>
        </div>
        <div class="photo-download-actions">
          <button class="btn btn-soft" type="button" id="selectAllPhotosBtn">全選</button>
          <button class="btn btn-ghost" type="button" id="clearPhotoSelectionBtn">取消選取</button>
          <button class="btn btn-primary" type="button" id="downloadSelectedPhotosBtn" disabled>下載所選</button>
        </div>
      </div>
    `
    : "";
  const guestUpload = sharedMode && trip.can_guest_upload
    ? `
      <label class="guest-upload">
        朋友補照片（一次可選 1～100 張）
        <input type="file" id="guestPhotoInput" accept="image/*" multiple>
        <span class="photo-help">選取後會直接上傳，請保持頁面開啟直到完成。</span>
        <span class="guest-upload-status" id="guestUploadStatus" hidden></span>
      </label>
    `
    : "";
  const itinerary = renderItinerary(trip, sharedMode);

  $("drawerTitle").textContent = trip.title || trip.location_name;
  $("drawerBody").innerHTML = `
    ${photoGallery}
    ${downloadPanel}
    ${itinerary}
    <div class="location-card">
      <div><span>旅行地點</span><strong>${escapeHtml(trip.location_name)}</strong></div>
      ${mapUrl ? `<a class="location-link" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">在地圖查看</a>` : ""}
    </div>
    <div class="chip-row">
      <span class="chip private">${trip.is_shared ? "已開啟分享" : "私人"}</span>
      ${trip.travel_date ? `<span class="chip blue">${formatDate(trip.travel_date)}</span>` : ""}
      ${trip.mood ? `<span class="chip">${escapeHtml(trip.mood)}</span>` : ""}
      ${tags}
    </div>
    ${trip.diary ? `<div class="diary">${escapeHtml(trip.diary)}</div>` : ""}
    <div class="drawer-actions">
      ${!sharedMode ? `<button class="btn btn-primary" id="editTripBtn">編輯</button>` : ""}
      ${!sharedMode && trip.is_shared && shareUrl ? `<button class="btn btn-soft" id="shareTripBtn">分享旅程</button>` : ""}
    </div>
    ${guestUpload}
    ${!sharedMode && trip.is_shared
      ? shareUrl
        ? `<p class="trip-meta">分享連結：${escapeHtml(shareUrl)}</p>`
        : `<p class="trip-meta">請使用 HTTP(S) 網址開啟網站後再建立分享連結。</p>`
      : ""}
  `;

  $("detailDrawer").hidden = false;
  $("editTripBtn")?.addEventListener("click", () => openTripDialog(trip));
  $("addDayBtn")?.addEventListener("click", () => openDayDialog(trip));
  $("addStopBtn")?.addEventListener("click", () => openStopDialog(trip));
  $("shareTripBtn")?.addEventListener("click", () => shareTrip(trip, shareUrl));
  $("guestPhotoInput")?.addEventListener("change", (event) => uploadGuestPhotos(event, trip.share_token));
  $("drawerBody").querySelectorAll(".photo-open-btn").forEach((button) => {
    button.addEventListener("click", () => openPhotoLightbox(trip, sharedMode, Number(button.dataset.photoIndex)));
  });
  $("drawerBody").querySelectorAll("[data-download-photo-index]").forEach((input) => {
    input.addEventListener("change", () => updateDownloadSelection(photos));
  });
  $("selectAllPhotosBtn")?.addEventListener("click", () => selectAllPhotos(photos));
  $("clearPhotoSelectionBtn")?.addEventListener("click", () => clearDownloadSelection(photos));
  $("downloadSelectedPhotosBtn")?.addEventListener("click", (event) => {
    const selected = photos.filter((photo, index) => state.downloadSelection.has(getPhotoSelectionKey(photo, index)));
    downloadPhotos(selected, trip, event.currentTarget);
  });
  $("drawerBody").querySelectorAll(".photo-delete-btn").forEach((button) => {
    button.addEventListener("click", () => deletePhoto(button.dataset.photoId, trip.id));
  });
  $("drawerBody").querySelectorAll("[data-stop-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteStop(button.dataset.stopDelete, trip.id));
  });
}

function getTripDays(trip) {
  return Array.isArray(trip?.trip_days)
    ? [...trip.trip_days].sort((a, b) => Number(a.day_number || 0) - Number(b.day_number || 0))
    : [];
}

function getTripStops(trip) {
  return getTripDays(trip).flatMap((day) => (Array.isArray(day.trip_stops) ? day.trip_stops : []));
}

function formatStopTime(value) {
  return value ? String(value).slice(0, 5) : "";
}

function renderItinerary(trip, sharedMode) {
  const days = getTripDays(trip);
  const stopCount = getTripStops(trip).length;
  const controls = !sharedMode
    ? `<div class="itinerary-actions">
        <button class="btn btn-soft btn-small" type="button" id="addDayBtn">＋ 新增旅行日</button>
        <button class="btn btn-primary btn-small" type="button" id="addStopBtn">＋ 新增地標</button>
      </div>`
    : "";

  const body = days.length
    ? days.map((day) => {
        const stops = Array.isArray(day.trip_stops) ? day.trip_stops : [];
        return `<section class="itinerary-day">
          <header class="itinerary-day-head">
            <div>
              <span class="day-label">DAY ${escapeHtml(day.day_number)}</span>
              <h4>${escapeHtml(day.title || trip.location_name || "旅行日")}</h4>
              ${day.date ? `<time>${formatDate(day.date)}</time>` : ""}
            </div>
            <span>${stops.length} 個地標</span>
          </header>
          <div class="itinerary-stop-list">
            ${stops.length ? stops.map((stop, index) => `
              <article class="itinerary-stop">
                <span class="itinerary-stop-order">${index + 1}</span>
                <div class="itinerary-stop-body">
                  <div class="itinerary-stop-title">
                    <strong>${escapeHtml(stop.name)}</strong>
                    ${stop.arrival_time ? `<time>${formatStopTime(stop.arrival_time)}</time>` : ""}
                  </div>
                  ${stop.address ? `<p>${escapeHtml(stop.address)}</p>` : ""}
                  ${stop.note ? `<small>${escapeHtml(stop.note)}</small>` : ""}
                  ${stop.category || stop.mood ? `<span class="itinerary-stop-meta">${escapeHtml([stop.category, stop.mood].filter(Boolean).join(" · "))}</span>` : ""}
                </div>
                <div class="itinerary-stop-actions">
                  ${numberOrNull(stop.lat) !== null && numberOrNull(stop.lng) !== null
                    ? `<a class="location-link" href="${escapeHtml(getMapUrl(stop))}" target="_blank" rel="noopener noreferrer">地圖 →</a>`
                    : ""}
                  ${!sharedMode ? `<button class="text-danger" type="button" data-stop-delete="${escapeHtml(stop.id)}">刪除</button>` : ""}
                </div>
              </article>
            `).join("") : `<p class="itinerary-day-empty">這一天還沒有地標。</p>`}
          </div>
        </section>`;
      }).join("")
    : `<div class="itinerary-empty">
        <strong>還沒有每日行程</strong>
        <p>${state.stopSchemaError ? "請確認已在目前 Supabase 專案執行 trip_days／trip_stops migration。" : "新增旅行日後，就能在同一天加入多個地標。"}</p>
      </div>`;

  return `<section class="itinerary-panel">
    <div class="itinerary-heading">
      <div><p class="eyebrow">DAY BY DAY</p><h4>每日行程與地標</h4><p class="itinerary-summary">${days.length} 天 · ${stopCount} 個地標</p></div>
      ${controls}
    </div>
    ${body}
  </section>`;
}

function closeDayDialog() {
  if ($("dayDialog").open) $("dayDialog").close();
}

function closeStopDialog() {
  if ($("stopDialog").open) $("stopDialog").close();
}

function openDayDialog(trip = state.editingTrip) {
  if (!trip) return;
  if (!state.stopSchemaAvailable) {
    return toast("請先在目前 Supabase 專案執行 trip_days_stops migration");
  }

  const days = getTripDays(trip);
  const nextDay = days.reduce((max, day) => Math.max(max, Number(day.day_number) || 0), 0) + 1;
  $("dayForm").reset();
  $("dayNumberInput").value = nextDay;
  $("dayDateInput").value = trip.travel_date || "";
  $("dayTitleInput").value = trip.location_name || "";
  state.editingTrip = trip;
  $("dayDialog").showModal();
}

async function saveDay(event) {
  event.preventDefault();
  const trip = state.editingTrip;
  if (!trip) return;

  const dayNumber = Number($("dayNumberInput").value);
  const title = $("dayTitleInput").value.trim() || trip.location_name || `Day ${dayNumber}`;
  if (!Number.isInteger(dayNumber) || dayNumber < 1) return toast("Day 必須是大於 0 的整數");
  if (getTripDays(trip).some((day) => Number(day.day_number) === dayNumber)) {
    return toast(`Day ${dayNumber} 已經存在`);
  }

  const saveButton = $("saveDayBtn");
  saveButton.disabled = true;
  try {
    const { error } = await client.from("trip_days").insert({
      trip_id: trip.id,
      day_number: dayNumber,
      date: $("dayDateInput").value || null,
      title,
      sort_order: dayNumber - 1
    });
    if (error) throw error;
    closeDayDialog();
    await loadTrips();
    openTrip(trip.id);
    toast(`Day ${dayNumber} 已新增`);
  } catch (error) {
    console.error("[saveDay]", error);
    toast(error.message || "旅行日新增失敗");
  } finally {
    saveButton.disabled = false;
  }
}

function openStopDialog(trip = state.editingTrip) {
  if (!trip) return;
  if (!state.stopSchemaAvailable) {
    return toast("請先在目前 Supabase 專案執行 trip_days_stops migration");
  }

  const days = getTripDays(trip);
  if (!days.length) return toast("請先新增旅行日，再加入地標");

  $("stopForm").reset();
  $("stopDayInput").innerHTML = days.map((day) => `
    <option value="${escapeHtml(day.id)}">Day ${escapeHtml(day.day_number)}${day.title ? ` · ${escapeHtml(day.title)}` : ""}</option>
  `).join("");
  $("stopFormStatus").textContent = "同一天可以重複新增多個地標。";
  state.editingTrip = trip;
  $("stopDialog").showModal();
}

async function saveStop(event) {
  event.preventDefault();
  const trip = state.editingTrip;
  const dayId = $("stopDayInput").value;
  const name = $("stopNameInput").value.trim();
  if (!trip || !dayId) return toast("請先選擇旅行日");
  if (!name) return toast("請輸入地標名稱");

  const day = getTripDays(trip).find((item) => String(item.id) === String(dayId));
  const payload = {
    day_id: dayId,
    name,
    address: $("stopAddressInput").value.trim() || null,
    lat: numberOrNull($("stopLatInput").value),
    lng: numberOrNull($("stopLngInput").value),
    arrival_time: $("stopArrivalInput").value || null,
    departure_time: $("stopDepartureInput").value || null,
    category: $("stopCategoryInput").value || null,
    mood: $("stopMoodInput").value || null,
    note: $("stopNoteInput").value.trim() || null,
    sort_order: day?.trip_stops?.length || 0
  };

  if ((payload.lat === null) !== (payload.lng === null)) {
    return toast("緯度與經度請一起填寫");
  }

  const saveButton = $("saveStopBtn");
  saveButton.disabled = true;
  saveButton.textContent = "儲存中";
  try {
    const { error } = await client.from("trip_stops").insert(payload);
    if (error) throw error;
    closeStopDialog();
    await loadTrips();
    openTrip(trip.id);
    toast("地標已新增");
  } catch (error) {
    console.error("[saveStop]", error);
    toast(error.message || "地標新增失敗");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "新增地標";
  }
}

async function deleteStop(stopId, tripId) {
  if (!stopId || !confirm("確定要刪除這個地標嗎？")) return;
  const { data, error } = await client
    .from("trip_stops")
    .delete()
    .eq("id", stopId)
    .select("id");
  if (error) {
    console.error("[deleteStop]", error);
    return toast(error.message || "地標刪除失敗");
  }
  if (!Array.isArray(data) || data.length !== 1) return toast("刪除失敗：找不到這個地標");
  await loadTrips();
  openTrip(tripId);
  toast("地標已刪除");
}

function closeDrawer() {
  $("detailDrawer").hidden = true;
  state.editingTrip = null;
}

function closeTripDialog() {
  clearPhotoPreview();
  state.selectedPhotos = [];
  $("tripDialog").close();
}

function openTripDialog(trip = null) {
  state.editingTrip = trip;
  state.selectedPhotos = [];
  clearPhotoPreview();
  $("dialogTitle").textContent = trip ? "編輯旅途" : "新增旅途";
  $("deleteTripBtn").hidden = !trip;
  $("tripForm").reset();

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
    const existingCount = getTripPhotos(trip).length;
    if (existingCount) {
      $("photoSelectionSummary").textContent = `已上傳 ${existingCount} 張；可在旅程詳情中單張刪除。`;
      $("photoSelectionSummary").hidden = false;
    }
  } else {
    $("dateInput").value = new Date().toISOString().slice(0, 10);
  }

  $("tripDialog").showModal();
}

function clearPhotoPreview() {
  state.photoPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.photoPreviewUrls = [];
  $("photoInput").value = "";
  $("photoPreviewGrid").replaceChildren();
  $("photoPreviewGrid").hidden = true;
  $("photoSelectionSummary").textContent = "";
  $("photoSelectionSummary").hidden = true;
}

function handlePhotoInput(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  const invalidFile = files.find((file) => !file.type.startsWith("image/") || file.size > 10 * 1024 * 1024);
  if (invalidFile) {
    event.target.value = "";
    return toast(`${invalidFile.name} 不是圖片或超過 10MB`);
  }

  const unique = new Map();
  state.selectedPhotos.forEach((file) => unique.set(`${file.name}:${file.size}:${file.lastModified}:${file.type}`, file));
  files.forEach((file) => unique.set(`${file.name}:${file.size}:${file.lastModified}:${file.type}`, file));
  if (unique.size > MAX_UPLOAD_FILES) {
    event.target.value = "";
    return toast(`一次最多選擇 ${MAX_UPLOAD_FILES} 張照片，目前已選 ${state.selectedPhotos.length} 張`);
  }
  state.selectedPhotos = [...unique.values()];
  event.target.value = "";
  renderSelectedPhotoPreviews();
}

function renderSelectedPhotoPreviews() {
  state.photoPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.photoPreviewUrls = state.selectedPhotos.map((file) => URL.createObjectURL(file));
  const grid = $("photoPreviewGrid");
  grid.innerHTML = state.selectedPhotos.map((file, index) => `
    <span class="photo-preview-item">
      <img src="${escapeHtml(state.photoPreviewUrls[index])}" alt="${escapeHtml(file.name)}">
      <button class="photo-preview-remove" type="button" data-preview-index="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button>
    </span>
  `).join("");
  grid.hidden = !state.selectedPhotos.length;
  $("photoSelectionSummary").textContent = state.selectedPhotos.length
    ? `已選擇 ${state.selectedPhotos.length} 張照片`
    : "";
  $("photoSelectionSummary").hidden = !state.selectedPhotos.length;

  grid.querySelectorAll(".photo-preview-remove").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPhotos.splice(Number(button.dataset.previewIndex), 1);
      renderSelectedPhotoPreviews();
    });
  });
}

async function saveTrip(event) {
  event.preventDefault();
  const trip = state.editingTrip;
  const payload = {
    title: $("titleInput").value.trim() || null,
    location_name: $("locationInput").value.trim(),
    lat: numberOrNull($("latInput").value),
    lng: numberOrNull($("lngInput").value),
    travel_date: $("dateInput").value || null,
    mood: $("moodInput").value || null,
    diary: $("diaryInput").value.trim() || null,
    tags: parseTags($("tagsInput").value),
    is_shared: $("sharedInput").checked,
    can_download: $("downloadInput").checked,
    can_guest_upload: $("guestUploadInput").checked,
    updated_at: new Date().toISOString()
  };

  if (!payload.location_name) return toast("請輸入地點名稱");

  let savedTrip = trip;
  const uploadedPhotos = [];
  let committed = false;
  const saveButton = $("saveTripBtn");
  saveButton.disabled = true;
  saveButton.textContent = state.selectedPhotos.length ? `準備上傳 ${state.selectedPhotos.length} 張` : "儲存中";

  try {
    if (!trip) {
      const { data, error } = await client.from("trips").insert(payload).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("旅途建立後沒有回傳 id");
      savedTrip = data;
    }

    await uploadPhotosInBatches(savedTrip.id, state.selectedPhotos, uploadedPhotos, (completed, total) => {
      saveButton.textContent = `上傳中 ${completed}/${total}`;
    });

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
    toast(uploadedPhotos.length ? `旅途已儲存，已上傳 ${uploadedPhotos.length} 張照片` : "旅途已儲存");
    await loadTrips();
    openTrip(savedTrip.id);
  } catch (error) {
    console.error("[saveTrip]", error);
    if (!committed) {
      await rollbackUploadedPhotos(uploadedPhotos);
      if (!trip && savedTrip?.id) await deleteTripRow(savedTrip.id);
    }
    toast(error.message || "旅途儲存失敗");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "儲存";
  }
}

async function uploadPhoto(tripId, file) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${state.user.id}/${tripId}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await client.storage.from(bucket).upload(path, file, {
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

async function uploadPhotosInBatches(tripId, files, uploadedPhotos, onProgress) {
  let completed = 0;
  for (let index = 0; index < files.length; index += UPLOAD_BATCH_SIZE) {
    const batch = files.slice(index, index + UPLOAD_BATCH_SIZE);
    const results = await Promise.all(batch.map((file) => uploadPhoto(tripId, file)));
    results.forEach((result) => {
      uploadedPhotos.push(result.record);
      completed += 1;
      onProgress?.(completed, files.length);
    });
    const failed = results.find((result) => result.error);
    if (failed) throw failed.error;
  }
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
    const { error } = await client.storage.from(bucket).remove([record.storage_path]);
    if (error) console.error("[rollbackUploadedPhoto.storage]", error, record.storage_path);
  }
}

async function rollbackUploadedPhotos(records) {
  for (const record of [...records].reverse()) {
    await rollbackUploadedPhoto(record);
  }
}

async function deletePhoto(photoId, tripId) {
  const trip = state.trips.find((item) => item.id === tripId);
  const photo = getTripPhotos(trip).find((item) => item.id === photoId);
  if (!photo || !confirm("確定要刪除這張照片嗎？")) return;

  const { data, error } = await client
    .from("trip_photos")
    .delete()
    .eq("id", photo.id)
    .eq("trip_id", trip.id)
    .select("id");
  if (error) return toast(error.message);
  if (!Array.isArray(data) || data.length !== 1) return toast("刪除失敗：找不到這張照片");

  let storageClean = true;
  if (photo.storage_path) {
    const { error: storageError } = await client.storage.from(bucket).remove([photo.storage_path]);
    if (storageError) {
      console.error("[deletePhoto.storage]", storageError, photo.storage_path);
      storageClean = false;
    }
  }

  await loadTrips();
  openTrip(tripId);
  toast(storageClean ? "照片已刪除" : "照片紀錄已刪除，但雲端檔案清理失敗");
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
    const { error: storageError } = await client.storage.from(bucket).remove([...new Set(paths)]);
    if (storageError) {
      console.error("[deleteCurrentTrip.storage]", storageError, paths);
      storageClean = false;
    }
  }

  $("tripDialog").close();
  closeDrawer();
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
  return getPhotoUrl(getTripPhotos(trip)[0]);
}

function getPhotoSelectionKey(photo, index) {
  return String(photo.id || photo.storage_path || `${photo.original_name || "photo"}-${index}`);
}

function updateDownloadSelection(photos) {
  state.downloadSelection.clear();
  $("drawerBody").querySelectorAll("[data-download-photo-index]").forEach((input) => {
    const index = Number(input.dataset.downloadPhotoIndex);
    if (input.checked && photos[index]) {
      state.downloadSelection.add(getPhotoSelectionKey(photos[index], index));
    }
  });

  const count = state.downloadSelection.size;
  const status = $("downloadSelectionStatus");
  const button = $("downloadSelectedPhotosBtn");
  if (status) status.textContent = count ? `已選擇 ${count} 張` : "尚未選擇照片";
  if (button) {
    button.disabled = count === 0;
    button.textContent = count ? `下載所選（${count}）` : "下載所選";
  }
}

function selectAllPhotos(photos) {
  $("drawerBody").querySelectorAll("[data-download-photo-index]").forEach((input) => {
    input.checked = true;
  });
  updateDownloadSelection(photos);
}

function clearDownloadSelection(photos) {
  $("drawerBody").querySelectorAll("[data-download-photo-index]").forEach((input) => {
    input.checked = false;
  });
  updateDownloadSelection(photos);
}

function openPhotoLightbox(trip, sharedMode, index) {
  const photos = getTripPhotos(trip).filter((photo) => getPhotoUrl(photo));
  if (!photos.length) return;
  state.lightboxTrip = trip;
  state.lightboxPhotos = photos;
  state.lightboxIndex = Math.min(Math.max(index, 0), photos.length - 1);
  state.lightboxSharedMode = sharedMode;
  renderPhotoLightbox();
  if (!$("photoLightbox").open) $("photoLightbox").showModal();
}

function renderPhotoLightbox() {
  const photo = state.lightboxPhotos[state.lightboxIndex];
  if (!photo || !state.lightboxTrip) return;
  const total = state.lightboxPhotos.length;
  $("lightboxCounter").textContent = `${state.lightboxIndex + 1} / ${total}`;
  $("lightboxImage").src = getPhotoUrl(photo);
  $("lightboxImage").alt = photo.caption || state.lightboxTrip.location_name || "旅行照片";
  $("lightboxCaption").textContent = photo.caption || photo.original_name || state.lightboxTrip.location_name || "";
  $("previousPhotoBtn").hidden = total < 2;
  $("nextPhotoBtn").hidden = total < 2;
  $("lightboxDownloadBtn").hidden = state.lightboxSharedMode && !state.lightboxTrip.can_download;
}

function moveLightbox(offset) {
  const total = state.lightboxPhotos.length;
  if (total < 2) return;
  state.lightboxIndex = (state.lightboxIndex + offset + total) % total;
  renderPhotoLightbox();
}

function handleLightboxKeyboard(event) {
  if (!$("photoLightbox").open) return;
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
}

function closePhotoLightbox() {
  if ($("photoLightbox").open) $("photoLightbox").close();
  $("lightboxImage").removeAttribute("src");
}

async function downloadLightboxPhoto(event) {
  const photo = state.lightboxPhotos[state.lightboxIndex];
  if (!photo || !state.lightboxTrip) return;
  await downloadPhotos([photo], state.lightboxTrip, event.currentTarget);
}

async function downloadPhotos(photos, trip, sourceButton) {
  if (!photos.length) return toast("請先選擇照片");
  if (state.sharedMode && !trip.can_download) return toast("分享者沒有開放下載");

  const originalText = sourceButton?.textContent || "下載";
  if (sourceButton) sourceButton.disabled = true;
  try {
    const files = await fetchPhotoFiles(photos, trip, (completed, total) => {
      if (sourceButton) sourceButton.textContent = `準備中 ${completed}/${total}`;
    });

    const shareData = {
      title: trip.title || trip.location_name || "旅行照片",
      files
    };
    if (isMobileDevice() && navigator.share && navigator.canShare?.(shareData)) {
      try {
        await navigator.share(shareData);
        toast(files.length > 1 ? "已開啟手機的多張儲存選單" : "已開啟手機儲存選單");
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
        console.error("[downloadPhotos.share]", error);
      }
    }

    if (files.length === 1) {
      triggerBlobDownload(files[0], files[0].name);
      toast("照片已開始下載");
      return;
    }

    if (!window.JSZip) throw new Error("多張照片打包元件尚未載入");
    if (sourceButton) sourceButton.textContent = "正在打包 ZIP";
    const zip = new JSZip();
    files.forEach((file) => zip.file(file.name, file));
    const archive = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const archiveName = `${sanitizeFileName(trip.title || trip.location_name || "travel-photos")}.zip`;
    triggerBlobDownload(archive, archiveName);
    toast(`已將 ${files.length} 張照片打包下載`);
  } catch (error) {
    console.error("[downloadPhotos]", error);
    toast(error.message || "照片下載失敗，請稍後再試");
  } finally {
    if (sourceButton) {
      sourceButton.disabled = false;
      sourceButton.textContent = originalText;
    }
  }
}

async function fetchPhotoFiles(photos, trip, onProgress) {
  const files = [];
  const usedNames = new Set();
  for (const [index, photo] of photos.entries()) {
    const response = await fetch(getPhotoUrl(photo));
    if (!response.ok) throw new Error(`第 ${index + 1} 張照片下載失敗：HTTP ${response.status}`);
    const blob = await response.blob();
    const requestedName = photo.original_name || `${trip.title || trip.location_name || "travel-photo"}-${index + 1}.${extensionFromMime(blob.type)}`;
    const name = uniqueDownloadName(sanitizeFileName(requestedName), usedNames);
    files.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
    onProgress?.(index + 1, photos.length);
  }
  return files;
}

function uniqueDownloadName(name, usedNames) {
  let candidate = name || "travel-photo.jpg";
  let suffix = 2;
  const dot = candidate.lastIndexOf(".");
  const base = dot > 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot > 0 ? candidate.slice(dot) : "";
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function sanitizeFileName(value) {
  return String(value || "travel-photo")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "travel-photo";
}

function extensionFromMime(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/heic" || type === "image/heif") return "heic";
  return "jpg";
}

function triggerBlobDownload(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && window.innerWidth <= 1180);
}

async function uploadGuestPhotos(event, shareToken) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  if (files.length > MAX_UPLOAD_FILES) return toast(`一次最多補上 ${MAX_UPLOAD_FILES} 張照片`);
  const invalidFile = files.find((file) => !file.type.startsWith("image/") || file.size > 10 * 1024 * 1024);
  if (invalidFile) return toast(`${invalidFile.name} 不是圖片或超過 10MB`);

  event.target.disabled = true;
  const status = $("guestUploadStatus");
  status.hidden = false;
  status.textContent = `準備上傳 ${files.length} 張照片`;
  let uploadedCount = 0;
  try {
    for (let index = 0; index < files.length; index += UPLOAD_BATCH_SIZE) {
      const batch = files.slice(index, index + UPLOAD_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((file) => uploadGuestPhoto(file, shareToken)));
      uploadedCount += results.filter((result) => result.status === "fulfilled").length;
      status.textContent = `上傳中 ${uploadedCount}/${files.length}`;
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    toast(`已補上 ${uploadedCount} 張照片`);
  } catch (error) {
    console.error("[uploadGuestPhotos]", error);
    toast(uploadedCount ? `已上傳 ${uploadedCount} 張，其餘失敗` : error.message || "上傳失敗");
  } finally {
    event.target.disabled = false;
    event.target.value = "";
    if (uploadedCount) await loadSharedTrip(shareToken);
  }
}

async function uploadGuestPhoto(file, shareToken) {
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
    throw new Error(payload.error || `${file.name} 上傳失敗`);
  }
}

function getTripPhotos(trip) {
  if (!trip) return [];
  return Array.isArray(trip.trip_photos) ? trip.trip_photos : Array.isArray(trip.photos) ? trip.photos : [];
}

function getPhotoUrl(photo) {
  if (!photo) return "";
  return photo.signed_url || state.photoUrls.get(photo.storage_path) || "";
}

function getMapUrl(trip) {
  const lat = numberOrNull(trip.lat);
  const lng = numberOrNull(trip.lng);
  if (lat !== null && lng !== null) {
    return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=14/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}`;
  }
  return trip.location_name
    ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(trip.location_name)}`
    : "";
}

async function shareTrip(trip, shareUrl) {
  const details = [trip.location_name, trip.travel_date ? formatDate(trip.travel_date) : ""].filter(Boolean).join(" · ");
  const payload = {
    title: trip.title || trip.location_name || "旅行日記",
    text: details ? `我的旅行地點：${details}` : "我的旅行日記",
    url: shareUrl
  };

  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error("[shareTrip]", error);
    }
  }
  await copyText(`${payload.text}\n${shareUrl}`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("分享連結已複製");
  } catch (error) {
    console.error("[copyText]", error);
    toast("無法自動複製，請手動複製連結");
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
