// Firebase + Firestore online sync
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, getDoc,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDpNrt6vuF7wlc4LiUpDTqADKjSgT57Zcw",
  authDomain: "alice-trip-planner.firebaseapp.com",
  projectId: "alice-trip-planner",
  storageBucket: "alice-trip-planner.firebasestorage.app",
  messagingSenderId: "872286083995",
  appId: "1:872286083995:web:7e2b2a97b433a1be421f3e",
  measurementId: "G-6JMN169DN7"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let firebaseReady = false;
let unsubscribeTrips = null;
let remoteTrips = [];
let suppressRemoteWrite = false;

async function ensureFirebaseAuth() {
  if (auth.currentUser) {
    firebaseReady = true;
    return auth.currentUser;
  }
  const result = await signInAnonymously(auth);
  firebaseReady = true;
  return result.user;
}

function startTripsSync() {
  if (unsubscribeTrips) unsubscribeTrips();

  unsubscribeTrips = onSnapshot(
    collection(db, "trips"),
    (snapshot) => {
      remoteTrips = snapshot.docs.map(d => {
        const data = d.data() || {};
        return {
          id: d.id,
          trip: data.trip || {},
          places: Array.isArray(data.places) ? data.places : [],
          updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || ""
        };
      });

      // Keep a local cache so the app still has something to show if needed.
      localStorage.setItem(TRIPS_STORAGE_KEY, JSON.stringify(remoteTrips));
      renderSavedTrips();
    },
    (error) => {
      console.error("Firestore sync error:", error);
      toast("Không thể đồng bộ Firebase. Kiểm tra Firestore Rules.");
    }
  );
}

/* =========================================================
   TRIP PLANNER
   - Multiple saved trips
   - Drag & drop itinerary
   - Food / cafe menu with automatic total
   - Excel export
   - PDF export: one day per page
========================================================= */

const STORAGE_KEY = 'pinkGreenTripPlannerV1';
const TRIPS_STORAGE_KEY = 'tripPlannerTrips';
const PLACE_BANK_STORAGE_KEY = 'tripPlannerPlaceBankV1';
const PLACE_BANK_DOC_ID = 'global';

let currentTripId = null;
let pendingDrop = null;
let currentMenu = [];
let placeBank = [];
let placeBankReady = false;
let activePlaceFilter = 'Tất cả';

function uid() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function $(id) {
    return document.getElementById(id);
}

function money(n) {
    return Number(n || 0).toLocaleString('vi-VN') + ' ₫';
}

function esc(s = '') {
    return String(s).replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[m]));
}

function todayISO() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function localDate(iso) {
    if (!iso || !iso.includes('-')) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

function datesBetween(start, end) {
    if (!start || !end || start > end) return [];

    const out = [];
    const d = new Date(start + 'T12:00:00');
    const last = new Date(end + 'T12:00:00');

    while (d <= last) {
        out.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() + 1);
    }

    return out;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function placeTemplate(place = {}) {
    return {
        id: place.id || uid(),
        name: place.name || '',
        category: place.category || 'Tham quan',
        address: place.address || '',
        cost: Math.max(0, Number(place.cost || 0)),
        notes: place.notes || '',
        map: place.map || '',
        menu: Array.isArray(place.menu) ? clone(place.menu) : []
    };
}

function loadLocalPlaceBank() {
    try {
        const raw = JSON.parse(localStorage.getItem(PLACE_BANK_STORAGE_KEY));
        placeBank = Array.isArray(raw) ? raw.map(placeTemplate) : [];
    } catch (error) {
        console.error('Cannot load Place Bank:', error);
        placeBank = [];
    }
}

function saveLocalPlaceBank() {
    localStorage.setItem(PLACE_BANK_STORAGE_KEY, JSON.stringify(placeBank));
}


// Duplicate cleanup:
// Same name is still allowed. A card is only considered duplicated when
// all Place Bank details are the same (name, category, address, cost,
// notes, map and menu). IDs, trip date/time and check-in data are ignored.
function placeDuplicateKey(place = {}) {
    const normal = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');

    const menu = Array.isArray(place.menu)
        ? place.menu.map(item => ({
            name: normal(item?.name),
            price: Math.max(0, Number(item?.price || 0))
        }))
        : [];

    return JSON.stringify({
        name: normal(place.name),
        category: normal(place.category || 'Tham quan'),
        address: normal(place.address),
        cost: Math.max(0, Number(place.cost || 0)),
        notes: normal(place.notes),
        map: normal(place.map),
        menu
    });
}

function removeExactPlaceDuplicates(places = []) {
    const seenIds = new Set();
    const seenContent = new Set();
    const clean = [];

    for (const rawPlace of places) {
        if (!rawPlace) continue;

        const place = placeTemplate(rawPlace);

        // Same ID repeated = definitely duplicated.
        if (seenIds.has(place.id)) continue;

        // Different IDs are only merged when the entire Place Bank card
        // content is identical. Same name alone is NOT treated as duplicate.
        const contentKey = placeDuplicateKey(place);
        if (seenContent.has(contentKey)) continue;

        seenIds.add(place.id);
        seenContent.add(contentKey);
        clean.push(place);
    }

    return clean;
}

function cleanPlaceBankDuplicates() {
    const before = placeBank.length;
    placeBank = removeExactPlaceDuplicates(placeBank);

    if (placeBank.length !== before) {
        saveLocalPlaceBank();
        console.info(`Removed ${before - placeBank.length} duplicated Place Bank card(s).`);
        return true;
    }

    return false;
}

function mergePlacesIntoBank(places = []) {
    let changed = false;

    places.forEach(place => {
        if (!place || !place.id) return;

        const clean = placeTemplate(place);

        const sameIdIndex = placeBank.findIndex(item => item.id === clean.id);
        if (sameIdIndex !== -1) {
            const before = JSON.stringify(placeBank[sameIdIndex]);
            placeBank[sameIdIndex] = { ...placeBank[sameIdIndex], ...clean };
            if (JSON.stringify(placeBank[sameIdIndex]) !== before) changed = true;
            return;
        }

        // IMPORTANT: same name is allowed.
        // Only block a second card when ALL Place Bank details are identical.
        const cleanKey = placeDuplicateKey(clean);
        const exactDuplicate = placeBank.some(item => placeDuplicateKey(item) === cleanKey);

        if (!exactDuplicate) {
            placeBank.push(clean);
            changed = true;
        }
    });

    if (cleanPlaceBankDuplicates()) changed = true;
    if (changed) saveLocalPlaceBank();
    return changed;
}

async function savePlaceBank() {
    cleanPlaceBankDuplicates();
    saveLocalPlaceBank();

    try {
        await ensureFirebaseAuth();
        await setDoc(
            doc(db, 'placeBank', PLACE_BANK_DOC_ID),
            {
                places: clone(placeBank),
                updatedAt: serverTimestamp(),
                lastEditor: auth.currentUser.uid
            },
            { merge: true }
        );
    } catch (error) {
        console.error('Place Bank save failed:', error);
        // Local copy remains available even if Firebase is temporarily unavailable.
    }
}

async function loadPlaceBankFromFirebase() {
    loadLocalPlaceBank();

    try {
        await ensureFirebaseAuth();
        const snap = await getDoc(doc(db, 'placeBank', PLACE_BANK_DOC_ID));

        if (snap.exists()) {
            const data = snap.data() || {};
            const remote = Array.isArray(data.places) ? data.places.map(placeTemplate) : [];

            // Start with Firebase data, then merge local data safely.
            // Same names are allowed; only exact duplicate cards are collapsed.
            const localPlaces = clone(placeBank);
            placeBank = removeExactPlaceDuplicates(remote);
            mergePlacesIntoBank(localPlaces);
        }

        // Migrate places from the currently loaded old-format trip into the shared bank.
        mergePlacesIntoBank(state?.places || []);
        placeBankReady = true;
        await savePlaceBank();
    } catch (error) {
        console.error('Place Bank load failed:', error);
        mergePlacesIntoBank(state?.places || []);
        placeBankReady = true;
    }
}

function scheduleForTrip() {
    return (state.places || [])
        .filter(place => place.date)
        .map(place => ({
            id: place.id,
            date: place.date,
            time: place.time || null,
            checkedIn: Boolean(place.checkedIn),
            checkedInAt: place.checkedInAt || null,
            actualCost: place.actualCost === null || place.actualCost === undefined ? null : Number(place.actualCost),
            checkinNote: place.checkinNote || ''
        }));
}

function buildTripPlaces(saved) {
    const schedule = Array.isArray(saved?.schedule)
        ? saved.schedule
        : (Array.isArray(saved?.places)
            ? saved.places.filter(place => place.date).map(place => ({
                id: place.id,
                date: place.date,
                time: place.time || null
            }))
            : []);

    const legacyPlaces = Array.isArray(saved?.places) ? saved.places : [];

    return schedule.map(entry => {
        const bankPlace = placeBank.find(place => place.id === entry.id);
        const legacyPlace = legacyPlaces.find(place => place.id === entry.id);
        const source = bankPlace || legacyPlace;

        if (!source) return null;

        return {
            ...placeTemplate(source),
            date: entry.date || legacyPlace?.date || null,
            time: entry.time || legacyPlace?.time || null,
            checkedIn: Boolean(entry.checkedIn ?? legacyPlace?.checkedIn ?? false),
            checkedInAt: entry.checkedInAt || legacyPlace?.checkedInAt || null,
            actualCost: entry.actualCost ?? legacyPlace?.actualCost ?? null,
            checkinNote: entry.checkinNote || legacyPlace?.checkinNote || ''
        };
    }).filter(Boolean);
}

function allPlannerPlaces() {
    const scheduledIds = new Set((state.places || []).filter(p => p.date).map(p => p.id));

    const unscheduled = placeBank
        .filter(place => !scheduledIds.has(place.id))
        .map(place => ({
            ...clone(place),
            date: null,
            time: null
        }));

    const scheduled = (state.places || []).filter(place => place.date);
    return [...unscheduled, ...scheduled];
}

function updateBankPlaceFromTrip(place) {
    if (!place) return;
    const clean = placeTemplate(place);
    const index = placeBank.findIndex(item => item.id === clean.id);

    if (index === -1) placeBank.push(clean);
    else placeBank[index] = clean;

    savePlaceBank();
}

function defaultState() {
    return {
        trip: {
            name: 'Đà Lạt Trip',
            start: todayISO(),
            end: todayISO(),
            people: 4,
            budget: 5000000
        },
        places: [
            {
                id: uid(),
                name: 'Linh Lam Cafe',
                category: 'Cà phê',
                address: 'Đà Lạt',
                cost: 100000,
                notes: '',
                map: '',
                menu: [],
                date: null,
                time: null
            },
            {
                id: uid(),
                name: 'Mongo Land',
                category: 'Tham quan',
                address: 'Đà Lạt',
                cost: 250000,
                notes: '',
                map: '',
                menu: [],
                date: null,
                time: null
            },
            {
                id: uid(),
                name: 'Lẩu gà lá é',
                category: 'Ăn uống',
                address: 'Đà Lạt',
                cost: 250000,
                notes: '',
                map: '',
                menu: [],
                date: null,
                time: null
            }
        ]
    };
}

let state = defaultState();

/* =========================================================
   WORKING STATE
========================================================= */

function save() {
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            state,
            currentTripId
        })
    );
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        const data = JSON.parse(raw);

        // New format
        if (data && data.state) {
            state = data.state;
            currentTripId = data.currentTripId || null;
        }
        // Old format compatibility
        else if (data && data.trip && Array.isArray(data.places)) {
            state = data;
            currentTripId = null;
        }

        normalizeState();
    } catch (error) {
        console.error('Cannot load working trip:', error);
        state = defaultState();
        currentTripId = null;
    }
}

function normalizeState() {
    if (!state || typeof state !== 'object') state = defaultState();

    if (!state.trip) {
        state.trip = {
            name: '',
            start: '',
            end: '',
            people: 1,
            budget: 0
        };
    }

    state.trip.budget = Math.max(0, Number(state.trip.budget || 0));

    if (!Array.isArray(state.places)) state.places = [];

    state.places.forEach(place => {
        if (!place.id) place.id = uid();
        if (!Array.isArray(place.menu)) place.menu = [];
        if (place.date === undefined) place.date = null;
        if (place.time === undefined) place.time = null;
        if (place.checkedIn === undefined) place.checkedIn = false;
        if (place.checkedInAt === undefined) place.checkedInAt = null;
        if (place.actualCost === undefined) place.actualCost = null;
        if (place.checkinNote === undefined) place.checkinNote = '';
    });
}

function toast(msg) {
    const t = $('toast');
    if (!t) return;

    t.textContent = msg;
    t.classList.add('show');

    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

/* =========================================================
   SAVED TRIPS
========================================================= */

function getSavedTrips() {
    // Firebase is the main source once the online connection is ready.
    // This makes saved trips visible on other devices instead of depending
    // on each device's separate localStorage.
    if (firebaseReady) {
        return Array.isArray(remoteTrips) ? remoteTrips : [];
    }

    // Local cache is only a fallback while Firebase is still connecting
    // or when the app is temporarily offline.
    try {
        const trips = JSON.parse(localStorage.getItem(TRIPS_STORAGE_KEY));
        return Array.isArray(trips) ? trips : [];
    } catch (error) {
        console.error('Cannot load saved trips:', error);
        return [];
    }
}

function setSavedTrips(trips) {
    localStorage.setItem(TRIPS_STORAGE_KEY, JSON.stringify(trips));
}

function createTripId() {
    return 'trip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function saveCurrentTrip() {
    syncTripFromInputs();

    if (!state.trip.name.trim()) {
        toast('Hãy nhập tên chuyến đi.');
        return;
    }
    if (!state.trip.start || !state.trip.end) {
        toast('Hãy chọn ngày bắt đầu và kết thúc.');
        return;
    }

    try {
        await ensureFirebaseAuth();

        if (!currentTripId) currentTripId = createTripId();

        const payload = {
            trip: clone(state.trip),
            schedule: scheduleForTrip(),
            // Keep scheduled snapshots for compatibility with older saved trips.
            places: clone(state.places.filter(place => place.date)),
            updatedAt: serverTimestamp(),
            lastEditor: auth.currentUser.uid
        };

        await setDoc(doc(db, 'trips', currentTripId), payload, { merge: true });
        save();
        toast('Đã lưu chuyến đi lên Firebase ✓');
    } catch (error) {
        console.error('Firebase save failed:', error);
        toast('Lưu Firebase thất bại. Mở F12 → Console để xem lỗi.');
    }
}

function renderSavedTrips() {
    const container = $('savedTripsList');
    if (!container) return;

    const trips = getSavedTrips();

    if (trips.length === 0) {
        container.innerHTML = `
            <div class="empty-trips">
                <div class="empty-trips-icon">✈</div>
                <strong>Chưa có chuyến đi nào</strong>
                <p>Hãy tạo lịch trình đầu tiên của bạn.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = trips.map(saved => {
        const trip = saved.trip || {};
        const placeCount = Array.isArray(saved.schedule)
            ? saved.schedule.length
            : (Array.isArray(saved.places) ? saved.places.filter(place => place.date).length : 0);
        const days = datesBetween(trip.start, trip.end).length;

        return `
            <div class="saved-trip-card">
                <div class="saved-trip-top">
                    <div>
                        <span class="saved-trip-days">${days} NGÀY</span>
                        <h3>${esc(trip.name || 'My Trip')}</h3>
                    </div>

                    <button
                        type="button"
                        class="delete-saved-trip"
                        data-delete-trip="${esc(saved.id)}"
                        title="Xóa chuyến đi"
                        aria-label="Xóa chuyến đi"
                    >×</button>
                </div>

                <div class="saved-trip-info">
                    <span>📅 ${localDate(trip.start)} → ${localDate(trip.end)}</span>
                    <span>👥 ${Number(trip.people || 1)} người</span>
                    <span>📍 ${placeCount} địa điểm</span>
                </div>

                <button
                    type="button"
                    class="btn open-trip-btn"
                    data-open-trip="${esc(saved.id)}"
                >
                    Mở chuyến đi →
                </button>
            </div>
        `;
    }).join('');
}

function closeTripsModal() {
    $('tripsModal')?.classList.add('hidden');
}

function openSavedTrip(tripId) {
    const saved = getSavedTrips().find(item => item.id === tripId);
    if (!saved) {
        toast('Không tìm thấy chuyến đi.');
        return;
    }

    currentTripId = saved.id;

    // Old saved trips may still contain their own place copies.
    // Merge those into the permanent Place Bank before opening.
    mergePlacesIntoBank(saved.places || []);
    savePlaceBank();

    state = {
        trip: clone(saved.trip),
        places: buildTripPlaces(saved)
    };
    normalizeState();
    save();
    render();
    closeTripsModal();
    toast(`Đã mở "${state.trip.name}"`);
}

async function deleteSavedTrip(tripId) {
    const saved = getSavedTrips().find(item => item.id === tripId);
    if (!saved) return;

    if (!confirm(`Xóa chuyến "${saved.trip?.name || 'Untitled Trip'}"?`)) return;

    try {
        await ensureFirebaseAuth();
        await deleteDoc(doc(db, 'trips', tripId));

        if (currentTripId === tripId) {
            currentTripId = null;
            save();
        }

        toast('Đã xóa chuyến đi.');
    } catch (error) {
        console.error('Firebase delete failed:', error);
        toast('Không thể xóa chuyến đi trên Firebase.');
    }
}

function createNewTrip() {
    const hasCurrentData =
        Boolean(state.trip?.name?.trim()) ||
        (Array.isArray(state.places) && state.places.length > 0);

    if (hasCurrentData) {
        const confirmed = confirm(
            'Tạo chuyến đi mới? Nếu chuyến hiện tại chưa được lưu, các thay đổi chưa lưu sẽ bị mất.'
        );

        if (!confirmed) return;
    }

    currentTripId = null;

    state = {
        trip: {
            name: '',
            start: todayISO(),
            end: todayISO(),
            people: 1,
            budget: 0
        },
        places: []
    };

    pendingDrop = null;
    currentMenu = [];

    save();
    render();

    if ($('tripsModal')) {
        $('tripsModal').classList.add('hidden');
    }

    toast('Đã tạo chuyến đi mới');
}

/* =========================================================
   MAIN PLANNER
========================================================= */

function syncTripFromInputs() {
    const today = todayISO();

    if ($('startDate') && $('startDate').value && $('startDate').value < today) {
        $('startDate').value = today;
    }

    if ($('endDate')) {
        const minimumEnd = $('startDate')?.value && $('startDate').value >= today
            ? $('startDate').value
            : today;
        if ($('endDate').value && $('endDate').value < minimumEnd) {
            $('endDate').value = minimumEnd;
        }
    }

    if ($('tripName')) state.trip.name = $('tripName').value.trim();
    if ($('startDate')) state.trip.start = $('startDate').value;
    if ($('endDate')) state.trip.end = $('endDate').value;
    if ($('people')) state.trip.people = Math.max(1, Number($('people').value || 1));
    if ($('tripBudget')) state.trip.budget = Math.max(0, Number($('tripBudget').value || 0));
}

function budgetSnapshot() {
    const budget = Math.max(0, Number(state.trip?.budget || 0));
    const scheduled = (state.places || []).filter(place => place.date);

    const actualSpent = scheduled.reduce((sum, place) => {
        if (!place.checkedIn) return sum;
        return sum + Math.max(0, Number(place.actualCost ?? place.cost ?? 0));
    }, 0);

    const plannedUpcoming = scheduled.reduce((sum, place) => {
        if (place.checkedIn) return sum;
        return sum + Math.max(0, Number(place.cost || 0));
    }, 0);

    const expectedTotal = actualSpent + plannedUpcoming;
    const cashRemaining = budget - actualSpent;
    const expectedRemaining = budget - expectedTotal;

    return { budget, actualSpent, plannedUpcoming, expectedTotal, cashRemaining, expectedRemaining };
}

function remainingBudgetText() {
    const { budget, expectedRemaining } = budgetSnapshot();
    if (!budget) return 'Chưa nhập ngân sách';
    return expectedRemaining >= 0
        ? `Dự kiến còn ${money(expectedRemaining)}`
        : `Dự kiến thiếu ${money(Math.abs(expectedRemaining))}`;
}

function renderBudget() {
    const { budget, actualSpent, plannedUpcoming, expectedTotal, cashRemaining, expectedRemaining } = budgetSnapshot();

    if ($('budgetTotal')) $('budgetTotal').textContent = money(budget);
    if ($('budgetSpent')) $('budgetSpent').textContent = money(actualSpent);
    if ($('budgetPlanned')) $('budgetPlanned').textContent = money(plannedUpcoming);
    if ($('budgetExpected')) $('budgetExpected').textContent = money(expectedTotal);
    if ($('budgetRemaining')) $('budgetRemaining').textContent = money(expectedRemaining);

    const card = $('budgetCard');
    const status = $('budgetStatus');
    const note = $('budgetNote');
    const fill = $('budgetProgressFill');

    card?.classList.toggle('budget-over', budget > 0 && expectedRemaining < 0);
    card?.classList.toggle('budget-low', budget > 0 && expectedRemaining >= 0 && expectedRemaining / budget <= 0.20);

    if (!budget) {
        if (status) status.textContent = 'Chưa nhập ngân sách';
        if (note) note.textContent = 'Nhập ngân sách để theo dõi chi phí thực tế và dự kiến.';
        if (fill) fill.style.width = '0%';
        return;
    }

    if (expectedRemaining < 0) {
        if (status) status.textContent = `🔴 Dự kiến thiếu ${money(Math.abs(expectedRemaining))}`;
        if (note) note.textContent = `Đã chi ${money(actualSpent)} • Còn lịch dự kiến ${money(plannedUpcoming)}.`;
    } else if (expectedRemaining / budget <= 0.20) {
        if (status) status.textContent = `🟠 Sắp hết tiền • dự kiến còn ${money(expectedRemaining)}`;
        if (note) note.textContent = 'Ngân sách dự kiến còn dưới 20%. Bạn có thể tăng ngân sách hoặc cắt giảm lịch trình.';
    } else {
        const percentLeft = Math.max(0, Math.round((expectedRemaining / budget) * 100));
        if (status) status.textContent = `🟢 ${percentLeft}% dự kiến còn lại`;
        if (note) note.textContent = `Đã chi thực tế ${money(actualSpent)} • Sau toàn bộ lịch dự kiến còn ${money(expectedRemaining)}.`;
    }

    if (fill) {
        const usedPercent = Math.min(100, Math.max(0, (expectedTotal / budget) * 100));
        fill.style.width = `${usedPercent}%`;
    }
}

function applyDateLimits() {
    const startInput = $('startDate');
    const endInput = $('endDate');
    if (!startInput || !endInput) return;

    const today = todayISO();

    // New selections cannot be in the past.
    startInput.min = today;

    // End date must be today or later, and never before the selected start date.
    const startForLimit = startInput.value && startInput.value >= today
        ? startInput.value
        : today;
    endInput.min = startForLimit;
}

function renderPlaceFilters(availablePlaces = []) {
    const container = $('placeFilterChips');
    if (!container) return;

    const preferredOrder = [
        'Tham quan', 'Ăn uống', 'Cà phê', 'Check-in', 'Di chuyển',
        'Khách sạn', 'Thuê đồ', 'Mua sắm', 'Nghỉ ngơi', 'Khác'
    ];

    const existing = new Set(
        availablePlaces
            .map(place => String(place.category || 'Khác').trim() || 'Khác')
    );

    const categories = [
        ...preferredOrder.filter(category => existing.has(category)),
        ...Array.from(existing)
            .filter(category => !preferredOrder.includes(category))
            .sort((a, b) => a.localeCompare(b, 'vi'))
    ];

    // If the selected category no longer exists, return to All.
    if (activePlaceFilter !== 'Tất cả' && !existing.has(activePlaceFilter)) {
        activePlaceFilter = 'Tất cả';
    }

    const buttons = ['Tất cả', ...categories];
    container.innerHTML = buttons.map(category => `
        <button
            type="button"
            class="place-filter-chip ${activePlaceFilter === category ? 'active' : ''}"
            data-place-filter="${esc(category)}"
        >${esc(category)}</button>
    `).join('');
}

const DAY_PERIODS = [
    { id: 'morning', title: '🌅 Buổi sáng', hours: '05:00–10:59', start: '05:00', end: '10:59', suggested: '08:00' },
    { id: 'noon', title: '☀️ Buổi trưa', hours: '11:00–13:59', start: '11:00', end: '13:59', suggested: '12:00' },
    { id: 'afternoon', title: '🌤️ Buổi chiều', hours: '14:00–17:59', start: '14:00', end: '17:59', suggested: '15:00' },
    { id: 'evening', title: '🌙 Buổi tối', hours: '18:00–04:59', start: '18:00', end: '04:59', suggested: '19:00' }
];

function dayPeriodIdForTime(time) {
    if (!time) return 'morning';
    if (time >= '05:00' && time < '11:00') return 'morning';
    if (time >= '11:00' && time < '14:00') return 'noon';
    if (time >= '14:00' && time < '18:00') return 'afternoon';
    return 'evening';
}

function render() {
    normalizeState();

    const days = datesBetween(state.trip.start, state.trip.end);

    if ($('tripName')) $('tripName').value = state.trip.name || '';
    if ($('startDate')) $('startDate').value = state.trip.start || '';
    if ($('endDate')) $('endDate').value = state.trip.end || '';
    if ($('people')) $('people').value = state.trip.people || 1;

    applyDateLimits();
    if ($('tripBudget')) $('tripBudget').value = Number(state.trip.budget || 0);

    if ($('tripBadge')) {
        $('tripBadge').textContent = `${days.length} ngày • ${state.trip.people || 1} người`;
    }

    if ($('plannerTitle')) {
        $('plannerTitle').textContent = state.trip.name || 'Các ngày của chuyến đi';
    }

    const scheduledIds = new Set(state.places.filter(place => place.date).map(place => place.id));
    const unscheduled = placeBank
        .filter(place => !scheduledIds.has(place.id))
        .map(place => ({ ...clone(place), date: null, time: null }));

    renderPlaceFilters(unscheduled);

    const filteredUnscheduled = activePlaceFilter === 'Tất cả'
        ? unscheduled
        : unscheduled.filter(place => (place.category || 'Khác') === activePlaceFilter);

    if ($('unscheduledCount')) $('unscheduledCount').textContent = filteredUnscheduled.length;

    if ($('unscheduledList')) {
        $('unscheduledList').innerHTML =
            filteredUnscheduled.map(placeCard).join('') ||
            `<div class="empty-day">Không có địa điểm thuộc bộ lọc “${esc(activePlaceFilter)}”.</div>`;
    }

    if ($('daysContainer')) {
        $('daysContainer').innerHTML = days.map((date, index) => {
            const items = state.places
                .filter(place => place.date === date)
                .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

            const total = items.reduce(
                (sum, place) => sum + Number(place.checkedIn ? (place.actualCost ?? place.cost ?? 0) : (place.cost || 0)),
                0
            );

            return `
                <article class="day-column">
                    <div class="day-head">
                        <div class="day-no">DAY ${index + 1}</div>
                        <h3>${localDate(date)}</h3>
                    </div>

                    <div class="day-periods">
                        ${DAY_PERIODS.map(period => {
                            const periodItems = items.filter(place => dayPeriodIdForTime(place.time) === period.id);
                            return `<section class="day-period">
                                <div class="day-period-head"><strong>${period.title}</strong><span>${period.hours}</span></div>
                                <div class="day-drop period-drop" data-date="${date}" data-period="${period.id}">
                                    ${periodItems.length ? periodItems.map(placeCard).join('') : '<div class="period-empty">＋ Kéo địa điểm vào đây</div>'}
                                </div>
                            </section>`;
                        }).join('')}
                    </div>

                    <div class="day-total">
                        <span>Chi phí ngày</span>
                        <strong>${money(total)}</strong>
                    </div>
                </article>
            `;
        }).join('');
    }

    const scheduled = state.places.filter(place => place.date);

    if ($('placeTotal')) $('placeTotal').textContent = placeBank.length;
    if ($('scheduledTotal')) $('scheduledTotal').textContent = scheduled.length;

    if ($('costTotal')) {
        $('costTotal').textContent = money(
            scheduled.reduce(
                (sum, place) => sum + Number(place.checkedIn ? (place.actualCost ?? place.cost ?? 0) : (place.cost || 0)),
                0
            )
        );
    }

    renderBudget();
    bindDrag();
    save();
}

function placeCard(place) {
    const checked = Boolean(place.checkedIn);
    const actual = place.actualCost === null || place.actualCost === undefined
        ? Number(place.cost || 0)
        : Number(place.actualCost);

    return `
        <div class="place-card ${checked ? 'checked-in' : ''}" draggable="true" data-id="${place.id}" data-category="${esc(place.category || '')}">
            <div class="place-top">
                <div>
                    <div class="place-name">${checked ? '✓ ' : ''}${esc(place.name)}</div>
                    <div class="category">${esc(place.category)}</div>
                </div>
                ${place.date && place.time ? `
                    <button type="button" class="place-time-btn" data-place-action="time" data-place-id="${place.id}" title="Chỉnh sửa giờ">
                        🕐 ${esc(place.time)}
                    </button>
                ` : ''}
            </div>

            <div class="place-meta">
                ${place.address ? `📍 ${esc(place.address)}<br>` : ''}
                <span class="cost">💰 Dự kiến: ${money(place.cost)}</span>
                ${checked ? `<div class="actual-cost">✓ Thực tế: <strong>${money(actual)}</strong></div>` : ''}
                ${checked && place.checkedInAt ? `<div class="checkin-time">Check-in: ${esc(formatCheckinTime(place.checkedInAt))}</div>` : ''}
                ${checked && place.checkinNote ? `<div class="checkin-note">📝 ${esc(place.checkinNote)}</div>` : ''}

                ${place.menu?.length ? `
                    <div class="card-menu">
                        ${place.menu.map(item => `
                            <div class="card-menu-item"><span>• ${esc(item.name)}</span><strong>${money(item.price)}</strong></div>
                        `).join('')}
                    </div>
                ` : ''}

                ${place.notes ? `<br>📝 ${esc(place.notes)}` : ''}
                ${place.map ? `<br><a class="map-link" href="${esc(place.map)}" target="_blank" rel="noopener noreferrer">↗ Mở bản đồ / link</a>` : ''}
            </div>

            <div class="card-actions">
                ${place.date ? `
                    <button type="button" class="mini-btn checkin-btn ${checked ? 'checked' : ''}" data-place-action="checkin" data-place-id="${esc(place.id)}">
                        ${checked ? '✓ Sửa check-in' : '✓ Check in'}
                    </button>
                ` : ''}
                <button type="button" class="mini-btn" data-place-action="edit" data-place-id="${esc(place.id)}">✎ Sửa</button>
                <button type="button" class="mini-btn" data-place-action="duplicate" data-place-id="${esc(place.id)}">⧉ Copy</button>
                ${place.date ? `<button type="button" class="mini-btn" data-place-action="unschedule" data-place-id="${esc(place.id)}">↩ Bỏ lịch</button>` : ''}
                <button type="button" class="mini-btn" data-place-action="delete" data-place-id="${esc(place.id)}">× Xóa</button>
            </div>
        </div>
    `;
}

function formatCheckinTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openCheckinModal(id) {
    const place = state.places.find(item => item.id === id && item.date);
    if (!place) return;
    $('checkinPlaceId').value = place.id;
    $('checkinPlaceName').textContent = place.name;
    $('checkinPlannedCost').textContent = money(place.cost);
    $('actualCost').value = place.actualCost ?? place.cost ?? 0;
    $('checkinNote').value = place.checkinNote || '';
    $('undoCheckinBtn')?.classList.toggle('hidden', !place.checkedIn);
    $('checkinModal')?.classList.remove('hidden');
}

function closeCheckinModal() {
    $('checkinModal')?.classList.add('hidden');
}

function completeCheckin() {
    const id = $('checkinPlaceId')?.value;
    const place = state.places.find(item => item.id === id);
    if (!place) return;
    place.checkedIn = true;
    place.checkedInAt = place.checkedInAt || new Date().toISOString();
    place.actualCost = Math.max(0, Number($('actualCost')?.value || 0));
    place.checkinNote = $('checkinNote')?.value.trim() || '';
    closeCheckinModal();
    render();
    saveCurrentTrip();
    toast(`Đã check-in ${place.name} • ${remainingBudgetText()}`);
    setTimeout(showBudgetWarningIfNeeded, 100);
}

function undoCheckin() {
    const id = $('checkinPlaceId')?.value;
    const place = state.places.find(item => item.id === id);
    if (!place) return;
    place.checkedIn = false;
    place.checkedInAt = null;
    place.actualCost = null;
    place.checkinNote = '';
    closeCheckinModal();
    render();
    saveCurrentTrip();
    toast('Đã bỏ trạng thái check-in.');
}

function showBudgetWarningIfNeeded() {
    const snap = budgetSnapshot();
    if (!snap.budget) return;
    const low = snap.expectedRemaining < 0 || snap.expectedRemaining / snap.budget <= 0.20;
    if (!low) return;
    $('warningBudgetText').textContent = snap.expectedRemaining < 0
        ? `Bạn đang dự kiến thiếu ${money(Math.abs(snap.expectedRemaining))}.`
        : `Bạn chỉ còn dự kiến ${money(snap.expectedRemaining)} (${Math.max(0, Math.round(snap.expectedRemaining / snap.budget * 100))}% ngân sách).`;
    $('budgetWarningModal')?.classList.remove('hidden');
}

function openCutItinerary() {
    const upcoming = state.places
        .filter(place => place.date && !place.checkedIn)
        .sort((a,b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`));
    const box = $('cutItineraryList');
    if (!box) return;
    box.innerHTML = upcoming.length ? upcoming.map(place => `
        <label class="cut-item">
            <input type="checkbox" data-cut-place="${esc(place.id)}" data-cut-cost="${Number(place.cost || 0)}">
            <span><strong>${esc(place.name)}</strong><small>${localDate(place.date)} ${esc(place.time || '')}</small></span>
            <b>${money(place.cost)}</b>
        </label>
    `).join('') : '<p>Không còn địa điểm chưa check-in để cắt giảm.</p>';
    updateCutSavings();
    $('budgetWarningModal')?.classList.add('hidden');
    $('cutItineraryModal')?.classList.remove('hidden');
}

function updateCutSavings() {
    const selected = [...document.querySelectorAll('[data-cut-place]:checked')];
    const savings = selected.reduce((sum, input) => sum + Number(input.dataset.cutCost || 0), 0);
    if ($('cutSavings')) $('cutSavings').textContent = money(savings);
    if ($('cutAfter')) $('cutAfter').textContent = money(budgetSnapshot().expectedRemaining + savings);
}

function applyCutItinerary() {
    const ids = new Set([...document.querySelectorAll('[data-cut-place]:checked')].map(input => input.dataset.cutPlace));
    if (!ids.size) { toast('Hãy chọn ít nhất một địa điểm.'); return; }
    state.places = state.places.filter(place => !ids.has(place.id));
    $('cutItineraryModal')?.classList.add('hidden');
    render();
    saveCurrentTrip();
    toast(`Đã cắt ${ids.size} mục khỏi lịch • ${remainingBudgetText()}`);
}

function find(id) {
    return state.places.find(place => place.id === id)
        || placeBank.find(place => place.id === id);
}

/* =========================================================
   DRAG & DROP
========================================================= */

function bindDrag() {
    document.querySelectorAll('.place-card').forEach(card => {
        card.addEventListener('dragstart', event => {
            event.dataTransfer.setData('text/plain', card.dataset.id);
            event.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
        });
    });

    document.querySelectorAll('.day-drop, #unscheduledList').forEach(zone => {
        zone.addEventListener('dragover', event => {
            event.preventDefault();
            zone.classList.add('drag-over');
        });

        zone.addEventListener('dragleave', () => {
            zone.classList.remove('drag-over');
        });

        zone.addEventListener('drop', event => {
            event.preventDefault();
            zone.classList.remove('drag-over');

            const id = event.dataTransfer.getData('text/plain');
            const date = zone.dataset.date;
            const place = find(id);

            if (!place) return;

            // Drop back into unscheduled area
            if (!date) {
                place.date = null;
                place.time = null;
                render();
                toast(`Đã đưa về Chưa xếp lịch • ${remainingBudgetText()}`);
                return;
            }

            pendingDrop = { id, date, period: zone.dataset.period || null };

            if ($('timePlaceName')) $('timePlaceName').textContent = place.name || '';
            if ($('scheduleTime')) {
                const period = DAY_PERIODS.find(item => item.id === pendingDrop.period);
                $('scheduleTime').value = period && (!place.time || dayPeriodIdForTime(place.time) !== period.id) ? period.suggested : (place.time || '09:00');
            }
            if ($('timeModal')) $('timeModal').classList.remove('hidden');
        });
    });
}

/* =========================================================
   PLACE MODAL
========================================================= */

function openPlaceModal(place = null) {
    if (!$('placeModal')) return;

    $('modalTitle').textContent = place ? 'Chỉnh sửa địa điểm' : 'Thêm địa điểm';
    $('placeId').value = place?.id || '';
    $('placeName').value = place?.name || '';
    $('placeCategory').value = place?.category || 'Tham quan';
    $('placeCost').value = Number(place?.cost || 0);
    $('placeAddress').value = place?.address || '';
    $('placeNotes').value = place?.notes || '';
    $('placeMap').value = place?.map || '';

    currentMenu = Array.isArray(place?.menu) ? clone(place.menu) : [];

    updateMenuVisibility();
    renderMenuItems();

    $('placeModal').classList.remove('hidden');

    // Scroll modal content back to the top when reopened
    const panel = $('placeModal').querySelector('.modal-panel');
    if (panel) panel.scrollTop = 0;
}

function closePlaceModal() {
    if ($('placeModal')) $('placeModal').classList.add('hidden');
}

function duplicatePlace(id) {
    const place = find(id);
    if (!place) return;

    const copy = placeTemplate(place);
    copy.id = uid();
    copy.name = place.name + ' (copy)';

    placeBank.push(copy);
    savePlaceBank();
    render();
    toast('Đã tạo bản sao trong Place Bank');
}

function unschedulePlace(id) {
    const place = find(id);
    if (!place) return;

    state.places = state.places.filter(item => item.id !== id);
    render();
    toast(`Đã bỏ lịch • Địa điểm vẫn còn trong Place Bank • ${remainingBudgetText()}`);
}

function editPlaceTime(id) {
    const place = state.places.find(item => item.id === id);

    if (!place || !place.date) return;

    pendingDrop = {
        id: place.id,
        date: place.date
    };

    if ($('timePlaceName')) {
        $('timePlaceName').textContent = place.name;
    }

    if ($('scheduleTime')) {
        $('scheduleTime').value = place.time || '09:00';
    }

    $('timeModal')?.classList.remove('hidden');
}
function deletePlaceById(id) {
    const place = find(id);
    if (!place) return;

    if (!confirm(`Xóa vĩnh viễn "${place.name}" khỏi Place Bank? Địa điểm này cũng sẽ bị bỏ khỏi chuyến hiện tại.`)) return;

    placeBank = placeBank.filter(item => item.id !== id);
    state.places = state.places.filter(item => item.id !== id);
    savePlaceBank();
    render();
    toast(`Đã xóa vĩnh viễn khỏi Place Bank • ${remainingBudgetText()}`);
}

/* =========================================================
   MENU
========================================================= */

function isFoodCategory(category) {
    return category === 'Ăn uống' || category === 'Cà phê';
}

function updateMenuVisibility() {
    if (!$('placeCategory') || !$('menuSection')) return;

    const show = isFoodCategory($('placeCategory').value);
    $('menuSection').classList.toggle('hidden', !show);

    if (!show && $('placeCost')) {
        $('placeCost').readOnly = false;
    }

    calculateMenuTotal();
}

function renderMenuItems() {
    const container = $('menuItems');
    if (!container) return;

    if (currentMenu.length === 0) {
        container.innerHTML = `
            <div class="menu-empty">
                Chưa có món nào.
            </div>
        `;
    } else {
        container.innerHTML = currentMenu.map((item, index) => `
            <div class="menu-item" data-menu-index="${index}">
                <input
                    type="text"
                    class="menu-name"
                    placeholder="Tên món"
                    value="${esc(item.name || '')}"
                    data-menu-field="name"
                >

                <div class="menu-price-wrap">
                    <input
                        type="number"
                        class="menu-price"
                        min="0"
                        placeholder="Giá"
                        value="${Number(item.price || 0) || ''}"
                        data-menu-field="price"
                    >
                    <span>₫</span>
                </div>

                <button
                    type="button"
                    class="remove-menu-btn"
                    data-remove-menu="${index}"
                    aria-label="Xóa món"
                >×</button>
            </div>
        `).join('');
    }

    calculateMenuTotal();
}

function addMenuItem() {
    currentMenu.push({
        name: '',
        price: 0
    });

    renderMenuItems();

    const inputs = document.querySelectorAll('#menuItems .menu-name');
    const lastInput = inputs[inputs.length - 1];
    if (lastInput) lastInput.focus();
}

function calculateMenuTotal() {
    const total = currentMenu.reduce(
        (sum, item) => sum + Number(item.price || 0),
        0
    );

    if ($('menuTotal')) $('menuTotal').textContent = money(total);

    if (!$('placeCost') || !$('placeCategory')) return;

    const foodCategory = isFoodCategory($('placeCategory').value);

    if (foodCategory && currentMenu.length > 0) {
        $('placeCost').value = total;
        $('placeCost').readOnly = true;
    } else {
        $('placeCost').readOnly = false;
    }
}

/* =========================================================
   TRIP UPDATE
========================================================= */

function updateTripFromForm() {
    const start = $('startDate')?.value || '';
    const end = $('endDate')?.value || '';

    if (!start || !end || start > end) {
        alert('Ngày bắt đầu/kết thúc chưa hợp lệ.');
        return;
    }

    state.trip = {
        name: $('tripName')?.value.trim() || 'My Trip',
        start,
        end,
        people: Math.max(1, Number($('people')?.value || 1)),
        budget: Math.max(0, Number($('tripBudget')?.value || 0))
    };

    const validDates = new Set(datesBetween(start, end));

    state.places.forEach(place => {
        if (place.date && !validDates.has(place.date)) {
            place.date = null;
            place.time = null;
        }
    });

    render();
    toast(`Đã cập nhật chuyến đi • ${remainingBudgetText()}`);
}

/* =========================================================
   EVENT LISTENERS
========================================================= */

function bindDateLimitEvents() {
    const startInput = $('startDate');
    const endInput = $('endDate');
    if (!startInput || !endInput) return;

    startInput.addEventListener('change', () => {
        const today = todayISO();

        if (startInput.value && startInput.value < today) {
            startInput.value = today;
            toast('Không thể chọn ngày trong quá khứ.');
        }

        endInput.min = startInput.value || today;

        if (!endInput.value || endInput.value < endInput.min) {
            endInput.value = endInput.min;
        }
    });

    endInput.addEventListener('change', () => {
        const minimum = startInput.value && startInput.value >= todayISO()
            ? startInput.value
            : todayISO();

        if (endInput.value && endInput.value < minimum) {
            endInput.value = minimum;
            toast('Ngày kết thúc không thể trước ngày bắt đầu.');
        }
    });
}

function bindStaticEvents() {
    bindDateLimitEvents();
    $('saveTripBtn')?.addEventListener('click', saveCurrentTrip);

    $('myTripsBtn')?.addEventListener('click', () => {
        renderSavedTrips();
        $('tripsModal')?.classList.remove('hidden');
    });

    $('closeTripsModal')?.addEventListener('click', closeTripsModal);

    $('newTripBtn')?.addEventListener('click', createNewTrip);
    $('createTripFromListBtn')?.addEventListener('click', createNewTrip);

    $('placeFilterChips')?.addEventListener('click', event => {
        const button = event.target.closest('[data-place-filter]');
        if (!button) return;

        activePlaceFilter = button.dataset.placeFilter || 'Tất cả';
        render();
    });

    // Dynamic saved-trip buttons: event delegation
    $('savedTripsList')?.addEventListener('click', event => {
        const openButton = event.target.closest('[data-open-trip]');

        if (openButton) {
            openSavedTrip(openButton.dataset.openTrip);
            return;
        }

        const deleteButton = event.target.closest('[data-delete-trip]');

        if (deleteButton) {
            deleteSavedTrip(deleteButton.dataset.deleteTrip);
        }
    });

    // Dynamic place-card buttons: event delegation
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-place-action]');
        if (!button) return;

        const id = button.dataset.placeId;
        const action = button.dataset.placeAction;

        if (action === 'edit') openPlaceModal(find(id));
        if (action === 'duplicate') duplicatePlace(id);
        if (action === 'unschedule') unschedulePlace(id);
        if (action === 'delete') deletePlaceById(id);
        if (action === 'time') editPlaceTime(id);
        if (action === 'checkin') openCheckinModal(id);
    });

    $('addPlaceBtn')?.addEventListener('click', () => openPlaceModal());

    $('closeModalBtn')?.addEventListener('click', closePlaceModal);
    $('cancelModalBtn')?.addEventListener('click', closePlaceModal);

    $('placeCategory')?.addEventListener('change', updateMenuVisibility);
    $('addMenuItemBtn')?.addEventListener('click', addMenuItem);

    $('menuItems')?.addEventListener('input', event => {
        const row = event.target.closest('[data-menu-index]');
        if (!row) return;

        const index = Number(row.dataset.menuIndex);
        const field = event.target.dataset.menuField;

        if (!currentMenu[index] || !field) return;

        if (field === 'name') {
            currentMenu[index].name = event.target.value;
        }

        if (field === 'price') {
            currentMenu[index].price = Number(event.target.value || 0);
            calculateMenuTotal();
        }
    });

    $('menuItems')?.addEventListener('click', event => {
        const button = event.target.closest('[data-remove-menu]');
        if (!button) return;

        const index = Number(button.dataset.removeMenu);
        currentMenu.splice(index, 1);
        renderMenuItems();
    });

    $('placeForm')?.addEventListener('submit', event => {
        event.preventDefault();

        const id = $('placeId').value;
        const category = $('placeCategory').value;

        const finalMenu = isFoodCategory(category)
            ? currentMenu
                .filter(item => item.name.trim() !== '')
                .map(item => ({
                    name: item.name.trim(),
                    price: Number(item.price || 0)
                }))
            : [];

        let finalCost = Number($('placeCost').value || 0);

        if (finalMenu.length > 0) {
            finalCost = finalMenu.reduce(
                (sum, item) => sum + Number(item.price || 0),
                0
            );
        }

        const data = {
            name: $('placeName').value.trim(),
            category,
            address: $('placeAddress').value.trim(),
            cost: finalCost,
            notes: $('placeNotes').value.trim(),
            map: $('placeMap').value.trim(),
            menu: finalMenu
        };

        if (!data.name) {
            alert('Vui lòng nhập tên địa điểm.');
            return;
        }

        const oldCost = id ? Number(find(id)?.cost || 0) : 0;

        if (id) {
            const bankPlace = placeBank.find(place => place.id === id);
            if (bankPlace) Object.assign(bankPlace, data);

            // If this place is scheduled in the current trip, keep its details in sync.
            const scheduledPlace = state.places.find(place => place.id === id);
            if (scheduledPlace) Object.assign(scheduledPlace, data);

            savePlaceBank();
        } else {
            placeBank.push(placeTemplate({
                id: uid(),
                ...data
            }));
            savePlaceBank();
        }

        closePlaceModal();
        render();

        if (id) {
            const difference = finalCost - oldCost;
            const changeText = difference > 0
                ? `Tăng ${money(difference)}`
                : difference < 0
                    ? `Giảm ${money(Math.abs(difference))}`
                    : 'Chi phí không đổi';
            toast(`Đã cập nhật • ${changeText} • ${remainingBudgetText()}`);
        } else {
            toast(`Đã lưu vào Place Bank • Chưa tính vào ngân sách cho đến khi xếp lịch`);
        }
    });

    const cancelTime = () => {
        pendingDrop = null;
        $('timeModal')?.classList.add('hidden');
    };

    $('closeTimeBtn')?.addEventListener('click', cancelTime);
    $('cancelTimeBtn')?.addEventListener('click', cancelTime);

   $('confirmTimeBtn')?.addEventListener('click', () => {
    if (!pendingDrop) return;

    const selectedTime = $('scheduleTime')?.value || '09:00';

    // Check if another place already uses this time on the same day
    const conflict = state.places.find(place =>
        place.date === pendingDrop.date &&
        place.time === selectedTime &&
        place.id !== pendingDrop.id
    );

    if (conflict) {
        alert(
            `Khung giờ ${selectedTime} đã được sử dụng!\n\n` +
            `📍 ${conflict.name}\n` +
            `Vui lòng chọn giờ khác.`
        );

        return;
    }

    const source = find(pendingDrop.id);
    const existing = state.places.find(
        place => place.id === pendingDrop.id
    );

    if (source) {
        if (existing) {
            // Editing an existing scheduled place
            existing.date = pendingDrop.date;
            existing.time = selectedTime;
        } else {
            // Adding a place from Place Bank
            state.places.push({
                ...placeTemplate(source),
                date: pendingDrop.date,
                time: selectedTime
            });
        }
    }

    pendingDrop = null;

    $('timeModal')?.classList.add('hidden');

    render();

    toast(
        `Đã xếp lịch lúc ${selectedTime} • ${remainingBudgetText()}`
    );
});

    $('closeCheckinBtn')?.addEventListener('click', closeCheckinModal);
    $('cancelCheckinBtn')?.addEventListener('click', closeCheckinModal);
    $('confirmCheckinBtn')?.addEventListener('click', completeCheckin);
    $('undoCheckinBtn')?.addEventListener('click', undoCheckin);

    $('keepBudgetBtn')?.addEventListener('click', () => $('budgetWarningModal')?.classList.add('hidden'));
    $('addBudgetBtn')?.addEventListener('click', () => {
        $('budgetWarningModal')?.classList.add('hidden');
        $('tripBudget')?.focus();
        $('tripBudget')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    $('cutBudgetBtn')?.addEventListener('click', openCutItinerary);
    $('closeCutBtn')?.addEventListener('click', () => $('cutItineraryModal')?.classList.add('hidden'));
    $('cancelCutBtn')?.addEventListener('click', () => $('cutItineraryModal')?.classList.add('hidden'));
    $('applyCutBtn')?.addEventListener('click', applyCutItinerary);
    $('cutItineraryList')?.addEventListener('change', updateCutSavings);

    $('createTripBtn')?.addEventListener('click', updateTripFromForm);

    // Keep the old reset button usable, but make it a true blank trip.
    $('resetBtn')?.addEventListener('click', () => {
        createNewTrip();
    });

    // Optional: close modals when clicking their backdrop.
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', event => {
            if (event.target === modal) {
                modal.classList.add('hidden');

                if (modal.id === 'timeModal') {
                    pendingDrop = null;
                }
            }
        });
    });
}

/* =========================================================
   EXCEL
========================================================= */

function rowsForDate(date) {
    return state.places
        .filter(place => place.date === date)
        .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

function exportExcel() {
    if (typeof XLSX === 'undefined') {
        alert('Không tải được thư viện Excel. Hãy kiểm tra Internet.');
        return;
    }

    if (!state.trip.start || !state.trip.end) {
        alert('Vui lòng chọn ngày cho chuyến đi trước khi xuất Excel.');
        return;
    }

    const wb = XLSX.utils.book_new();
    const days = datesBetween(state.trip.start, state.trip.end);

    const aoa = [];
    const merges = [];
    const dayTitleRows = [];
    const headerRows = [];
    const totalRows = [];
    const separatorRows = [];

    aoa.push([state.trip.name || 'My Trip', '', '', '', '', '', '']);
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } });

    aoa.push([
        `${localDate(state.trip.start)} → ${localDate(state.trip.end)}  •  ${state.trip.people} người`,
        '', '', '', '', '', ''
    ]);
    merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: 6 } });

    aoa.push(['', '', '', '', '', '', '']);

    days.forEach((date, index) => {
        const titleRow = aoa.length;
        dayTitleRows.push(titleRow);

        aoa.push([
            `DAY ${index + 1}  •  ${localDate(date)}`,
            '', '', '', '', '', ''
        ]);

        merges.push({
            s: { r: titleRow, c: 0 },
            e: { r: titleRow, c: 6 }
        });

        const headerRow = aoa.length;
        headerRows.push(headerRow);

        aoa.push([
            'Thời gian',
            'Nội dung',
            'Địa điểm',
            'Chi phí',
            'Ghi chú',
            'Địa chỉ',
            'Map'
        ]);

        const rows = rowsForDate(date);

        rows.forEach(place => {
            const menuText = place.menu?.length
                ? place.menu
                    .map(item => `${item.name}: ${money(item.price)}`)
                    .join('\n')
                : '';

            const notes = [place.notes, menuText]
                .filter(Boolean)
                .join('\n');

            aoa.push([
                place.time || '',
                place.category || '',
                place.name || '',
                Number(place.cost || 0),
                notes,
                place.address || '',
                place.map || ''
            ]);
        });

        const totalRow = aoa.length;
        totalRows.push(totalRow);

        const total = rows.reduce(
            (sum, place) => sum + Number(place.cost || 0),
            0
        );

        aoa.push([
            '',
            '',
            'TỔNG CHI PHÍ NGÀY',
            total,
            '',
            '',
            ''
        ]);

        if (index < days.length - 1) {
            const separatorRow = aoa.length;
            separatorRows.push(separatorRow);

            aoa.push(['', '', '', '', '', '', '']);
            aoa.push(['', '', '', '', '', '', '']);
        }
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = merges;

    const green = '2C5951';
    const green2 = '597355';
    const greenLight = 'DCEBE2';
    const pink = 'F2DCE2';
    const pink2 = 'F2BDD0';
    const pinkDark = 'BF5079';
    const pale = 'FFF7F9';
    const white = 'FFFFFF';
    const ink = '263833';
    const borderColor = 'D9E1DC';

    const border = {
        top: { style: 'thin', color: { rgb: borderColor } },
        bottom: { style: 'thin', color: { rgb: borderColor } },
        left: { style: 'thin', color: { rgb: borderColor } },
        right: { style: 'thin', color: { rgb: borderColor } }
    };

    const range = XLSX.utils.decode_range(ws['!ref']);

    for (let row = 0; row <= range.e.r; row++) {
        for (let col = 0; col <= 6; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });

            if (!ws[address]) {
                ws[address] = { t: 's', v: '' };
            }

            ws[address].s = {
                font: {
                    name: 'Arial',
                    sz: 10,
                    color: { rgb: ink }
                },
                alignment: {
                    vertical: 'center',
                    wrapText: true
                },
                border,
                fill: {
                    fgColor: { rgb: white }
                }
            };
        }
    }

    ws['A1'].s = {
        fill: { fgColor: { rgb: pink } },
        font: {
            name: 'Arial',
            sz: 20,
            bold: true,
            color: { rgb: green }
        },
        alignment: {
            horizontal: 'center',
            vertical: 'center'
        }
    };

    ws['A2'].s = {
        fill: { fgColor: { rgb: pink } },
        font: {
            name: 'Arial',
            sz: 11,
            bold: true,
            color: { rgb: green2 }
        },
        alignment: {
            horizontal: 'center',
            vertical: 'center'
        }
    };

    dayTitleRows.forEach((row, index) => {
        for (let col = 0; col <= 6; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });

            ws[address].s = {
                fill: {
                    fgColor: {
                        rgb: index % 2 === 0 ? green : green2
                    }
                },
                font: {
                    name: 'Arial',
                    sz: 14,
                    bold: true,
                    color: { rgb: white }
                },
                alignment: {
                    horizontal: 'center',
                    vertical: 'center'
                },
                border
            };
        }
    });

    headerRows.forEach(row => {
        for (let col = 0; col <= 6; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });

            ws[address].s = {
                fill: { fgColor: { rgb: pinkDark } },
                font: {
                    name: 'Arial',
                    sz: 10,
                    bold: true,
                    color: { rgb: white }
                },
                alignment: {
                    horizontal: 'center',
                    vertical: 'center',
                    wrapText: true
                },
                border
            };
        }
    });

    headerRows.forEach((headerRow, index) => {
        const totalRow = totalRows[index];

        for (let row = headerRow + 1; row < totalRow; row++) {
            for (let col = 0; col <= 6; col++) {
                const address = XLSX.utils.encode_cell({ r: row, c: col });

                ws[address].s = {
                    fill: {
                        fgColor: {
                            rgb: (row - headerRow) % 2 ? pale : 'F5FAF7'
                        }
                    },
                    font: {
                        name: 'Arial',
                        sz: 10,
                        color: { rgb: ink }
                    },
                    alignment: {
                        vertical: 'center',
                        wrapText: true
                    },
                    border
                };
            }

            const timeCell = XLSX.utils.encode_cell({ r: row, c: 0 });
            ws[timeCell].s.font = {
                name: 'Arial',
                sz: 10,
                bold: true,
                color: { rgb: green }
            };

            const costCell = XLSX.utils.encode_cell({ r: row, c: 3 });
            ws[costCell].z = '#,##0" ₫"';
            ws[costCell].s.alignment = {
                horizontal: 'right',
                vertical: 'center'
            };
        }
    });

    totalRows.forEach(row => {
        for (let col = 0; col <= 6; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });

            ws[address].s = {
                fill: { fgColor: { rgb: greenLight } },
                font: {
                    name: 'Arial',
                    sz: 10,
                    bold: true,
                    color: { rgb: green }
                },
                alignment: {
                    vertical: 'center',
                    wrapText: true
                },
                border
            };
        }

        ws[XLSX.utils.encode_cell({ r: row, c: 3 })].z = '#,##0" ₫"';
    });

    separatorRows.forEach(row => {
        for (let rr = row; rr <= row + 1; rr++) {
            for (let col = 0; col <= 6; col++) {
                const address = XLSX.utils.encode_cell({ r: rr, c: col });

                ws[address].s = {
                    fill: {
                        fgColor: {
                            rgb: rr === row ? pink2 : pink
                        }
                    },
                    font: {
                        color: { rgb: pink2 }
                    },
                    alignment: {
                        vertical: 'center'
                    }
                };
            }
        }
    });

    ws['!cols'] = [
        { wch: 12 },
        { wch: 18 },
        { wch: 28 },
        { wch: 16 },
        { wch: 35 },
        { wch: 32 },
        { wch: 38 }
    ];

    ws['!rows'] = aoa.map((_, row) => {
        if (row === 0) return { hpt: 32 };
        if (row === 1) return { hpt: 22 };
        if (dayTitleRows.includes(row)) return { hpt: 27 };
        if (headerRows.includes(row)) return { hpt: 24 };
        if (separatorRows.includes(row) || separatorRows.includes(row - 1)) return { hpt: 8 };
        return { hpt: 34 };
    });

    ws['!freeze'] = {
        xSplit: 0,
        ySplit: 3
    };

    XLSX.utils.book_append_sheet(wb, ws, 'Trip Planner');

    const detail = [[
        'Ngày',
        'Thời gian',
        'Nội dung',
        'Địa điểm',
        'Địa chỉ',
        'Chi phí',
        'Ghi chú',
        'Menu',
        'Map'
    ]];

    days.forEach(date => {
        rowsForDate(date).forEach(place => {
            detail.push([
                localDate(date),
                place.time || '',
                place.category || '',
                place.name || '',
                place.address || '',
                Number(place.cost || 0),
                place.notes || '',
                place.menu?.map(item => `${item.name}: ${money(item.price)}`).join('\n') || '',
                place.map || ''
            ]);
        });
    });

    const ws2 = XLSX.utils.aoa_to_sheet(detail);

    ws2['!cols'] = [
        { wch: 13 },
        { wch: 10 },
        { wch: 16 },
        { wch: 25 },
        { wch: 30 },
        { wch: 15 },
        { wch: 35 },
        { wch: 35 },
        { wch: 35 }
    ];

    const range2 = XLSX.utils.decode_range(ws2['!ref']);

    for (let col = 0; col <= range2.e.c; col++) {
        const address = XLSX.utils.encode_cell({ r: 0, c: col });

        ws2[address].s = {
            fill: { fgColor: { rgb: green } },
            font: {
                bold: true,
                color: { rgb: white }
            },
            alignment: {
                horizontal: 'center'
            },
            border
        };
    }

    for (let row = 1; row <= range2.e.r; row++) {
        for (let col = 0; col <= range2.e.c; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });
            if (!ws2[address]) continue;

            ws2[address].s = {
                fill: {
                    fgColor: {
                        rgb: row % 2 ? pale : 'F5FAF7'
                    }
                },
                font: {
                    color: { rgb: ink }
                },
                alignment: {
                    vertical: 'center',
                    wrapText: true
                },
                border
            };

            if (col === 5) {
                ws2[address].z = '#,##0" ₫"';
            }
        }
    }

    ws2['!autofilter'] = {
        ref: ws2['!ref']
    };

    XLSX.utils.book_append_sheet(wb, ws2, 'Trip Details');

    const filename =
        (state.trip.name || 'Trip').replace(/[^\wÀ-ỹ -]/g, '') ||
        'Trip';

    XLSX.writeFile(wb, `${filename}-planner.xlsx`);
}

/* =========================================================
   PDF
========================================================= */

function periodForTime(time) {
    const hour = Number((time || '0:00').split(':')[0]);

    if (hour < 11) return ['SÁNG', '☀'];
    if (hour < 14) return ['TRƯA', ''];
    if (hour < 18) return ['CHIỀU', ''];
    return ['TỐI', '☾'];
}

function pdfPageHTML(date, dayNo) {
    const rows = rowsForDate(date);
    const groups = [];

    rows.forEach(place => {
        const [label, icon] = periodForTime(place.time);

        let group = groups.find(item => item.label === label);

        if (!group) {
            group = {
                label,
                icon,
                items: []
            };

            groups.push(group);
        }

        group.items.push(place);
    });

    const total = rows.reduce(
        (sum, place) => sum + Number(place.cost || 0),
        0
    );

    return `
        <section class="pdf-sheet">

            <div class="pdf-top">
                <div class="pdf-kicker">LỊCH TRÌNH DU LỊCH</div>
                <div class="pdf-trip">${esc(state.trip.name)}</div>
                <div class="pdf-day">DAY ${dayNo}</div>
                <div class="pdf-date">${localDate(date)}</div>
            </div>

            <div class="pdf-body">

                ${groups.map(group => `
                    <div class="pdf-period">

                        <div class="pdf-period-title">
                            ${group.label}
                            <span>${group.icon}</span>
                        </div>

                        ${group.items.map(place => `
                            <div class="pdf-row">

                                <div class="pdf-time">
                                    ${esc(place.time || '')}
                                </div>

                                <div class="pdf-info">

                                    <div class="pdf-place">
                                        ${esc(place.name)}
                                    </div>

                                    <div class="pdf-category">
                                        ${esc(place.category)}
                                        ${place.address ? ` • ${esc(place.address)}` : ''}
                                    </div>

                                    ${
                                        place.menu?.length
                                            ? `
                                                <div class="pdf-note">
                                                    ${place.menu.map(item =>
                                                        `${esc(item.name)} — ${money(item.price)}`
                                                    ).join(' • ')}
                                                </div>
                                            `
                                            : ''
                                    }

                                    ${
                                        place.notes
                                            ? `<div class="pdf-note">${esc(place.notes)}</div>`
                                            : ''
                                    }

                                </div>

                                <div class="pdf-cost">
                                    ${place.cost ? money(place.cost) : ''}
                                </div>

                            </div>
                        `).join('')}

                    </div>
                `).join('')}

                ${
                    rows.length
                        ? ''
                        : `<div class="pdf-empty">Chưa có hoạt động cho ngày này.</div>`
                }

            </div>

            <div class="pdf-footer">
                <span>Chi phí ngày</span>
                <strong>${money(total)}</strong>
            </div>

        </section>
    `;
}

async function exportPDF() {
    if (!window.jspdf || !window.html2canvas) {
        alert('Không tải được thư viện PDF. Hãy kiểm tra Internet.');
        return;
    }

    const days = datesBetween(state.trip.start, state.trip.end);

    if (!days.length) {
        alert('Vui lòng chọn ngày cho chuyến đi trước khi xuất PDF.');
        return;
    }

    const { jsPDF } = window.jspdf;

    const host = document.createElement('div');
    host.className = 'pdf-render-host';
    host.innerHTML = days
        .map((date, index) => pdfPageHTML(date, index + 1))
        .join('');

    document.body.appendChild(host);

    try {
        if (document.fonts?.ready) {
            await document.fonts.ready;
        }

        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4',
            compress: true
        });

        const pages = [...host.querySelectorAll('.pdf-sheet')];

        for (let index = 0; index < pages.length; index++) {
            if (index > 0) doc.addPage();

            const canvas = await html2canvas(pages[index], {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false
            });

            const img = canvas.toDataURL('image/jpeg', 0.94);

            doc.addImage(
                img,
                'JPEG',
                0,
                0,
                210,
                297,
                undefined,
                'FAST'
            );
        }

        const filename =
            (state.trip.name || 'Trip').replace(/[^\wÀ-ỹ -]/g, '') ||
            'Trip';

        doc.save(`${filename}-itinerary.pdf`);
    } finally {
        host.remove();
    }
}

/* =========================================================
   START APP
========================================================= */

async function init() {
    load();
    loadLocalPlaceBank();
    cleanPlaceBankDuplicates();

    // Upgrade old data: places already created in the current trip become permanent.
    mergePlacesIntoBank(state.places || []);
    state.places = (state.places || []).filter(place => place.date);

    bindStaticEvents();
    $('excelBtn')?.addEventListener('click', exportExcel);
    $('pdfBtn')?.addEventListener('click', exportPDF);
    render();

    try {
        await ensureFirebaseAuth();
        await loadPlaceBankFromFirebase();
        render();
        startTripsSync();
    } catch (error) {
        console.error('Firebase authentication failed:', error);
        placeBankReady = true;
        render();
        toast('Không kết nối được Firebase. Place Bank vẫn được giữ trên máy này.');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}