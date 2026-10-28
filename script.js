const REPORTS_STORAGE_KEY = 'smartwarga.reports';
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimRequestAt = 0;
let nominatimRequestQueue = Promise.resolve();

function requestNominatim(url) {
    const request = nominatimRequestQueue.then(async function() {
        const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimRequestAt);
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait));
        }
        lastNominatimRequestAt = Date.now();
        return fetch(url);
    });
    nominatimRequestQueue = request.then(() => undefined, () => undefined);
    return request;
}

function getStoredReports() {
    const stored = localStorage.getItem(REPORTS_STORAGE_KEY);
    if (stored === null) return [];
    const reports = JSON.parse(stored);
    if (!Array.isArray(reports)) throw new Error('Data laporan lokal tidak valid.');
    return reports;
}

function saveLocalReport(report) {
    const reports = getStoredReports();
    const id = reports.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const today = new Date();
    const tanggal = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0')
    ].join('-');
    reports.unshift({
        ...report,
        id,
        status: 'Diterima',
        tanggal,
        has_foto: Boolean(report.foto)
    });
    localStorage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
    return { id };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(reader.result));
        reader.addEventListener('error', () => reject(reader.error || new Error('Foto tidak dapat dibaca.')));
        reader.readAsDataURL(file);
    });
}

function showRequestError(error) {
    console.error('Penyimpanan lokal SmartWarga gagal:', error);
    const notice = document.getElementById('apiErrorNotice');
    const message = document.getElementById('apiErrorMessage');
    if (!notice || !message) return;

    message.textContent = error.message || 'Data laporan lokal tidak dapat diakses. Silakan coba lagi.';
    notice.hidden = false;
}

const BANDAR_LAMPUNG_CENTER = { lat: -5.4290, lng: 105.2620 };
const BANDAR_LAMPUNG_BOUNDS = {
    north: -5.35,
    south: -5.60,
    east: 105.38,
    west: 105.15
};

function isWithinBandarLampung(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= BANDAR_LAMPUNG_BOUNDS.south && lat <= BANDAR_LAMPUNG_BOUNDS.north &&
        lng >= BANDAR_LAMPUNG_BOUNDS.west && lng <= BANDAR_LAMPUNG_BOUNDS.east;
}

const WEATHER_CODES = {
    0: { description: 'Cerah', icon: '☀️' },
    1: { description: 'Cerah berawan', icon: '🌤️' },
    2: { description: 'Berawan sebagian', icon: '⛅' },
    3: { description: 'Mendung', icon: '☁️' },
    45: { description: 'Berkabut', icon: '🌫️' },
    48: { description: 'Berkabut tebal', icon: '🌫️' },
    51: { description: 'Gerimis ringan', icon: '🌦️' },
    53: { description: 'Gerimis', icon: '🌦️' },
    55: { description: 'Gerimis lebat', icon: '🌧️' },
    56: { description: 'Gerimis beku ringan', icon: '🌧️' },
    57: { description: 'Gerimis beku lebat', icon: '🌧️' },
    61: { description: 'Hujan ringan', icon: '🌦️' },
    63: { description: 'Hujan sedang', icon: '🌧️' },
    65: { description: 'Hujan lebat', icon: '🌧️' },
    66: { description: 'Hujan beku ringan', icon: '🌧️' },
    67: { description: 'Hujan beku lebat', icon: '🌧️' },
    71: { description: 'Salju ringan', icon: '🌨️' },
    73: { description: 'Salju sedang', icon: '🌨️' },
    75: { description: 'Salju lebat', icon: '❄️' },
    77: { description: 'Butiran salju', icon: '❄️' },
    80: { description: 'Hujan lokal ringan', icon: '🌦️' },
    81: { description: 'Hujan lokal sedang', icon: '🌧️' },
    82: { description: 'Hujan lokal lebat', icon: '🌧️' },
    85: { description: 'Hujan salju ringan', icon: '🌨️' },
    86: { description: 'Hujan salju lebat', icon: '🌨️' },
    95: { description: 'Badai petir', icon: '⛈️' },
    96: { description: 'Badai petir dengan hujan es ringan', icon: '⛈️' },
    99: { description: 'Badai petir dengan hujan es lebat', icon: '⛈️' }
};

function initWeatherWidget() {
    const trigger = document.getElementById('btnCuaca');
    const modal = document.getElementById('weatherModal');
    const content = document.getElementById('weatherContent');
    const refreshButton = document.getElementById('btnMuatCuaca');
    const locationButton = document.getElementById('btnCuacaLokasi');
    const districtSelect = document.getElementById('weatherDistrict');
    const title = document.getElementById('weatherTitle');
    const closeButton = document.getElementById('btnTutupCuaca');
    if (!trigger || !modal || !content || !refreshButton || !locationButton || !title || !closeButton) return;

    function closeModal() {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        trigger.focus();
    }

    function showMessage(message) {
        const paragraph = document.createElement('p');
        paragraph.textContent = message;
        content.replaceChildren(paragraph);
    }

    function addWeatherDetail(container, label, value) {
        const detail = document.createElement('div');
        detail.className = 'weather-detail';
        detail.append(document.createTextNode(label));
        const strong = document.createElement('strong');
        strong.textContent = value;
        detail.append(strong);
        container.append(detail);
    }

    async function loadWeather(location = BANDAR_LAMPUNG_CENTER, locationLabel = 'Bandar Lampung') {
        refreshButton.disabled = true;
        refreshButton.textContent = 'Memuat...';
        locationButton.disabled = true;
        title.textContent = locationLabel;
        showMessage(`Mengambil data cuaca ${locationLabel}...`);

        const params = new URLSearchParams({
            latitude: String(location.lat),
            longitude: String(location.lng),
            current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
            timezone: 'Asia/Jakarta'
        });

        try {
            const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
            if (!response.ok) throw new Error(`Layanan cuaca merespons HTTP ${response.status}.`);

            const data = await response.json();
            const current = data.current;
            if (!current || !Number.isFinite(current.temperature_2m) ||
                !Number.isFinite(current.weather_code)) {
                throw new Error('Data cuaca yang diterima tidak lengkap.');
            }

            const weather = WEATHER_CODES[current.weather_code] || {
                description: 'Kondisi cuaca tidak diketahui',
                icon: '🌡️'
            };
            const icon = document.createElement('div');
            icon.className = 'weather-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = weather.icon;

            const temperature = document.createElement('div');
            temperature.className = 'weather-temperature';
            temperature.textContent = `${Math.round(current.temperature_2m)}°C`;

            const description = document.createElement('div');
            description.className = 'weather-description';
            description.textContent = weather.description;

            const details = document.createElement('div');
            details.className = 'weather-details';
            addWeatherDetail(details, 'Terasa seperti', `${Math.round(current.apparent_temperature)}°C`);
            addWeatherDetail(details, 'Kelembapan', `${current.relative_humidity_2m}%`);
            addWeatherDetail(details, 'Angin', `${current.wind_speed_10m} km/jam`);

            const observedAt = document.createElement('small');
            observedAt.textContent = `Data: ${new Date(current.time).toLocaleString('id-ID', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: 'Asia/Jakarta'
            })}`;

            content.replaceChildren(icon, temperature, description, details, observedAt);
        } catch (error) {
            console.error(`Gagal memuat cuaca ${locationLabel}:`, error);
            showMessage('Cuaca tidak dapat dimuat. Periksa koneksi internet lalu coba lagi.');
        } finally {
            refreshButton.disabled = false;
            refreshButton.textContent = 'Muat Ulang Cuaca';
            locationButton.disabled = false;
        }
    }

    async function loadWeatherAtCurrentLocation() {
        if (!navigator.geolocation) {
            showMessage('Browser tidak mendukung geolokasi. Cuaca Bandar Lampung tetap tersedia.');
            return;
        }

        locationButton.disabled = true;
        showMessage('Meminta izin lokasi perangkat...');
        navigator.geolocation.getCurrentPosition(async function(position) {
            const location = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            let locationLabel = `Lokasi Anda (${location.lat.toFixed(3)}, ${location.lng.toFixed(3)})`;

            try {
                const params = new URLSearchParams({
                    format: 'jsonv2',
                    lat: String(location.lat),
                    lon: String(location.lng),
                    zoom: '14',
                    addressdetails: '1'
                });
                const response = await requestNominatim(`https://nominatim.openstreetmap.org/reverse?${params}`);
                if (!response.ok) {
                    throw new Error(`Layanan lokasi merespons HTTP ${response.status}.`);
                }
                const result = await response.json();
                const address = result.address || {};
                const district = districtSelect.value || address.city_district;
                const nearbyArea = district || address.suburb || address.neighbourhood ||
                    address.village || address.town || address.city;
                if (nearbyArea) locationLabel = district ? `Kecamatan ${nearbyArea}` : nearbyArea;
            } catch (error) {
                console.warn('Nama kecamatan tidak dapat ditemukan:', error);
            }

            await loadWeather(location, locationLabel);
        }, function(error) {
            locationButton.disabled = false;
            const message = error.code === error.PERMISSION_DENIED
                ? 'Izin lokasi ditolak. Izinkan akses lokasi atau muat cuaca Bandar Lampung.'
                : 'Lokasi perangkat tidak dapat ditemukan. Muat cuaca Bandar Lampung sebagai gantinya.';
            showMessage(message);
        }, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 300000
        });
    }

    trigger.addEventListener('click', function() {
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        refreshButton.focus();
        loadWeather();
    });
    refreshButton.addEventListener('click', loadWeather);
    locationButton.addEventListener('click', loadWeatherAtCurrentLocation);
    closeButton.addEventListener('click', closeModal);
    modal.addEventListener('click', event => {
        if (event.target === modal) closeModal();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !modal.hidden) closeModal();
    });
}

function initChatbot() {
    const launcher = document.getElementById('chatLauncher');
    const panel = document.getElementById('chatPanel');
    const closeButton = document.getElementById('chatClose');
    const form = document.getElementById('chatForm');
    const input = document.getElementById('chatInput');
    const sendButton = document.getElementById('chatSend');
    const messagesContainer = document.getElementById('chatMessages');
    const suggestions = document.getElementById('chatSuggestions');
    if (!launcher || !panel || !closeButton || !form || !input || !sendButton || !messagesContainer) return;

    const conversation = [];

    function addMessage(role, text, className = '') {
        const message = document.createElement('p');
        message.className = `chat-message ${role}${className ? ` ${className}` : ''}`;
        message.textContent = text;
        messagesContainer.append(message);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return message;
    }

    function openChat() {
        panel.hidden = false;
        launcher.setAttribute('aria-expanded', 'true');
        input.focus();
    }

    function closeChat() {
        panel.hidden = true;
        launcher.setAttribute('aria-expanded', 'false');
        launcher.focus();
    }

    launcher.addEventListener('click', function() {
        if (panel.hidden) openChat();
        else closeChat();
    });
    closeButton.addEventListener('click', closeChat);

    if (suggestions) {
        suggestions.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', function() {
                input.value = button.textContent.trim();
                form.requestSubmit();
            });
        });
    }

    input.addEventListener('keydown', function(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            form.requestSubmit();
        }
    });

    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        const text = input.value.trim();
        if (!text || sendButton.disabled) return;
        if (location.protocol === 'file:') {
            addMessage('assistant', 'Chatbot memerlukan server Python. Jalankan server sesuai panduan README, lalu buka situs melalui alamat server.');
            return;
        }

        input.value = '';
        if (suggestions) suggestions.hidden = true;
        addMessage('user', text);
        conversation.push({ role: 'user', text });
        while (conversation.length > 8) conversation.splice(0, 2);
        const pending = addMessage('assistant', 'Sedang menyiapkan jawaban…', 'is-pending');
        sendButton.disabled = true;
        input.disabled = true;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: conversation })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || `Permintaan chatbot gagal (HTTP ${response.status}).`);
            }
            if (typeof result.answer !== 'string' || !result.answer.trim()) {
                throw new Error('Chatbot mengirim jawaban kosong. Silakan coba lagi.');
            }
            pending.classList.remove('is-pending');
            pending.textContent = result.answer;
            conversation.push({ role: 'assistant', text: result.answer });
            while (conversation.length > 8) conversation.splice(0, 2);
        } catch (error) {
            conversation.pop();
            pending.classList.remove('is-pending');
            pending.classList.add('is-error');
            pending.textContent = error.message ||
                'Chatbot tidak dapat dihubungi. Pastikan server berjalan dan API key Gemini sudah diatur.';
            console.error('Permintaan chatbot gagal:', error);
        } finally {
            sendButton.disabled = false;
            input.disabled = false;
            input.focus();
        }
    });

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && !panel.hidden) closeChat();
    });
}

let refreshMapMarkers = function() {};

// ============ HALAMAN INDEX ============
async function updateStats() {
    const totalEl = document.getElementById('totalLaporan');
    if (!totalEl) return;
    const reports = getStoredReports();
    totalEl.textContent = reports.length;
    document.getElementById('totalSelesai').textContent =
        reports.filter(report => report.status === 'Selesai').length;
    document.getElementById('totalProses').textContent =
        reports.filter(report => report.status === 'Diproses').length;
    document.getElementById('totalWarga').textContent =
        new Set(reports.map(report => report.email.toLowerCase())).size;
}

// ============ HALAMAN LAPOR ============
function initFormLaporan() {
    const form = document.getElementById('formLaporan');
    if (!form) return;

    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        const submitButton = form.querySelector('[type="submit"]');
        const latitude = document.getElementById('lat').value;
        const longitude = document.getElementById('lng').value;
        const lat = Number(latitude);
        const lng = Number(longitude);
        const photoFile = document.getElementById('foto').files[0];
        if (!latitude || !longitude || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            document.getElementById('addressMapStatus').textContent =
                'Pilih hasil alamat atau titik langsung di peta, lalu pastikan pin muncul sebelum mengirim laporan.';
            document.getElementById('mapForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        if (!isWithinBandarLampung(lat, lng)) {
            alert('Lokasi laporan harus berada di wilayah Bandar Lampung.');
            return;
        }
        if (photoFile && (!['image/jpeg', 'image/png'].includes(photoFile.type) ||
            photoFile.size > 2 * 1024 * 1024)) {
            alert('Foto bukti harus JPG atau PNG dengan ukuran maksimal 2 MB.');
            return;
        }
        submitButton.disabled = true;
        try {
            const foto = photoFile ? await readFileAsDataUrl(photoFile) : null;
            const result = saveLocalReport({
                nama: document.getElementById('nama').value.trim(),
                email: document.getElementById('email').value.trim(),
                kategori: document.getElementById('kategori').value,
                alamat: document.getElementById('alamat').value.trim(),
                deskripsi: document.getElementById('deskripsi').value.trim(),
                lat,
                lng,
                foto
            });
            const refreshResults = await Promise.allSettled([
                updateStats(),
                refreshMapMarkers()
            ]);
            const refreshFailed = refreshResults.some(result => result.status === 'rejected');
            refreshResults.forEach(result => {
                if (result.status === 'rejected') {
                    console.error('Laporan tersimpan, tetapi tampilan gagal diperbarui:', result.reason);
                }
            });
            await Swal.fire({
                icon: refreshFailed ? 'warning' : 'success',
                title: refreshFailed ? 'Laporan tersimpan' : 'Laporan Berhasil Disimpan!',
                text: `ID Laporan Anda: ${result.id}. Simpan ID ini untuk melacak status.` +
                    ' Laporan ini hanya tersimpan di browser dan perangkat ini.' +
                    (refreshFailed ? ' Beberapa tampilan belum diperbarui; muat ulang halaman.' : ''),
                confirmButtonColor: '#10b981',
                background: '#fff',
                color: '#1e293b'
            });
            form.reset();
            document.getElementById('searchLaporan').value = result.id;
            document.getElementById('btnCari').click();
            window.location.hash = 'lacak';
        } catch (error) {
            showRequestError(error);
        } finally {
            submitButton.disabled = false;
        }
    });
}

function initFormMap() {
    const mapEl = document.getElementById('mapForm');
    if (!mapEl) return;

    const map = new google.maps.Map(mapEl, {
        center: BANDAR_LAMPUNG_CENTER,
        zoom: 13,
        restriction: {
            latLngBounds: BANDAR_LAMPUNG_BOUNDS,
            strictBounds: true
        }
    });
    let marker;
    let addressLookupId = 0;
    let lastAddressQuery = '';
    const addressInput = document.getElementById('alamat');
    const addressStatus = document.getElementById('addressMapStatus');
    const addressCandidates = document.getElementById('addressCandidates');

    function setMarker(position) {
        if (!isWithinBandarLampung(position.lat(), position.lng())) {
            alert('Pilih lokasi di dalam wilayah Bandar Lampung.');
            return;
        }
        if (marker) marker.setMap(null);
        marker = new google.maps.Marker({ map, position });
        document.getElementById('lat').value = position.lat();
        document.getElementById('lng').value = position.lng();
    }

    addressInput.addEventListener('input', function() {
        addressLookupId += 1;
        lastAddressQuery = '';
        addressCandidates.replaceChildren();
        document.getElementById('lat').value = '';
        document.getElementById('lng').value = '';
        if (marker) {
            marker.setMap(null);
            marker = null;
        }
        const address = this.value.trim();

        if (address.length < 5) {
            addressStatus.textContent = '';
            return;
        }

        addressStatus.textContent = 'Selesai mengetik? Klik di luar kolom untuk mencari lokasi di peta.';
    });

    addressInput.addEventListener('blur', async function() {
        const address = this.value.trim();
        if (address.length < 5 || address === lastAddressQuery) return;

        const queryTerms = address.toLocaleLowerCase('id-ID')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .split(/[^a-z0-9]+/)
            .filter(term => term.length > 1 && ![
                'jalan', 'jl', 'nomor', 'no', 'bandar', 'lampung', 'indonesia',
                'kecamatan', 'kec', 'kelurahan', 'kel'
            ].includes(term));
        if (queryTerms.length === 0) {
            addressStatus.textContent =
                'Tambahkan nama jalan, nomor, gedung, atau patokan lokasi selain nama kota.';
            return;
        }

        const lookupId = addressLookupId;
        lastAddressQuery = address;
        addressStatus.textContent = 'Mencari alamat di peta...';
        const params = new URLSearchParams({
            q: `${address}, Bandar Lampung, Indonesia`,
            format: 'jsonv2',
            limit: '5',
            countrycodes: 'id',
            viewbox: [
                BANDAR_LAMPUNG_BOUNDS.west,
                BANDAR_LAMPUNG_BOUNDS.north,
                BANDAR_LAMPUNG_BOUNDS.east,
                BANDAR_LAMPUNG_BOUNDS.south
            ].join(','),
            bounded: '1',
            'accept-language': 'id'
        });

        try {
            const response = await requestNominatim(
                `https://nominatim.openstreetmap.org/search?${params}`
            );
            if (!response.ok) {
                throw new Error(`Layanan pencarian alamat merespons HTTP ${response.status}.`);
            }
            const results = await response.json();
            if (lookupId !== addressLookupId) return;
            if (!Array.isArray(results) || results.length === 0) {
                addressStatus.textContent = 'Alamat tidak ditemukan. Coba tambahkan nama jalan atau kelurahan.';
                return;
            }

            const minimumMatchedTerms = Math.ceil(queryTerms.length / 2);
            const candidates = results.filter(result => {
                if (!isWithinBandarLampung(Number(result.lat), Number(result.lon))) return false;
                const resultTerms = new Set(result.display_name.toLocaleLowerCase('id-ID')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .split(/[^a-z0-9]+/));
                const matchedTerms = queryTerms.filter(term => resultTerms.has(term)).length;
                return matchedTerms >= minimumMatchedTerms;
            });
            if (candidates.length === 0) {
                addressStatus.textContent =
                    'Tidak ada hasil yang cukup cocok dengan kata kunci alamat di Bandar Lampung. Periksa ejaan atau coba nama jalan/patokan lain.';
                return;
            }

            addressStatus.textContent =
                'Pilih alamat yang paling cocok. Hasil pencarian belum dipasang sebagai pin.';
            const fragment = document.createDocumentFragment();
            candidates.forEach(candidate => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'address-candidate';
                button.textContent = candidate.display_name;
                button.setAttribute('aria-pressed', 'false');
                button.addEventListener('click', function() {
                    const latitude = Number(candidate.lat);
                    const longitude = Number(candidate.lon);
                    if (!isWithinBandarLampung(latitude, longitude)) {
                        addressStatus.textContent = 'Alamat yang dipilih berada di luar Bandar Lampung.';
                        return;
                    }

                    const position = new google.maps.LatLng(latitude, longitude);
                    map.setCenter(position);
                    map.setZoom(17);
                    setMarker(position);
                    addressCandidates.querySelectorAll('.address-candidate').forEach(item => {
                        item.setAttribute('aria-pressed', String(item === button));
                    });
                    addressStatus.textContent =
                        `Pin dipasang pada: ${candidate.display_name}. Periksa kembali posisi pin di peta.`;
                });
                fragment.append(button);
            });
            addressCandidates.replaceChildren(fragment);
        } catch (error) {
            if (lookupId !== addressLookupId) return;
            lastAddressQuery = '';
            addressStatus.textContent = 'Pencarian alamat gagal. Periksa koneksi internet atau pilih titik di peta.';
            console.error('Pencarian alamat dengan Nominatim gagal:', error);
        }
    });

    map.addListener('click', event => {
        if (event.latLng) {
            setMarker(event.latLng);
            addressStatus.textContent = 'Titik lokasi dipilih secara manual di peta.';
        }
    });

    document.getElementById('btnLokasi').addEventListener('click', function() {
        if (!navigator.geolocation) {
            alert('Browser Anda tidak mendukung fitur lokasi.');
            return;
        }

        navigator.geolocation.getCurrentPosition(
            function(pos) {
                const position = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
                if (!isWithinBandarLampung(position.lat(), position.lng())) {
                    alert('Lokasi Anda berada di luar wilayah Bandar Lampung.');
                    return;
                }
                map.setCenter(position);
                map.setZoom(15);
                setMarker(position);
                addressStatus.textContent = 'Lokasi Anda dipilih di peta.';
            },
            function(error) {
                alert(`Lokasi tidak dapat diakses: ${error.message}`);
            }
        );
    });
}

// ============ HALAMAN LACAK ============
function initLacak() {
    const btnCari = document.getElementById('btnCari');
    if (!btnCari) return;

    btnCari.addEventListener('click', async function() {
        const query = document.getElementById('searchLaporan').value.trim();
        const hasil = document.getElementById('hasilLacak');
        if (!query) { alert('Masukkan ID atau Email!'); return; }

        btnCari.disabled = true;
        try {
            const reports = getStoredReports();
            const found = query.match(/^\d+$/)
                ? reports.filter(report => report.id === Number(query))
                : reports.filter(report => report.email.toLowerCase() === query.toLowerCase());
            if (found.length === 0) {
                hasil.style.display = 'block';
                hasil.innerHTML = '<p style="text-align:center;color:#ef4444;">❌ Laporan tidak ditemukan.</p>';
                return;
            }

            hasil.style.display = 'block';
            hasil.innerHTML = found.map(l => `
                <div style="border-left:4px solid var(--primary);padding:1rem;background:var(--light);border-radius:8px;margin-bottom:1rem;">
                    <h3>Laporan #${l.id} <span class="status-badge status-${escapeHtml(l.status)}">${escapeHtml(l.status)}</span></h3>
                    <p><strong>Kategori:</strong> ${escapeHtml(l.kategori)}</p>
                    <p><strong>Alamat:</strong> ${escapeHtml(l.alamat)}</p>
                    <p><strong>Tanggal:</strong> ${escapeHtml(l.tanggal)}</p>
                    <p><strong>Deskripsi:</strong> ${escapeHtml(l.deskripsi)}</p>
                    <div class="timeline">
                        <div class="timeline-item ${['Diterima','Diproses','Selesai'].includes(l.status) ? 'active' : ''}">✓ Diterima</div>
                        <div class="timeline-item ${['Diproses','Selesai'].includes(l.status) ? 'active' : ''}">✓ Diverifikasi</div>
                        <div class="timeline-item ${l.status === 'Diproses' ? 'active' : ''}">🔧 Sedang Diperbaiki</div>
                        <div class="timeline-item ${l.status === 'Selesai' ? 'active' : ''}">✅ Selesai</div>
                    </div>
                </div>
            `).join('');
        } catch (error) {
            showRequestError(error);
        } finally {
            btnCari.disabled = false;
        }
    });
}

// ============ HALAMAN PETA ============
function initPeta() {
    const mapEl = document.getElementById('mapFull');
    if (!mapEl) return;

    const map = new google.maps.Map(mapEl, {
        center: BANDAR_LAMPUNG_CENTER,
        zoom: 13,
        restriction: {
            latLngBounds: BANDAR_LAMPUNG_BOUNDS,
            strictBounds: true
        }
    });

    let markers = [];
    const infoWindow = new google.maps.InfoWindow();
    let currentFilter = 'all';

    async function renderMarkers(filter = 'all') {
        currentFilter = filter;
        markers.forEach(marker => marker.setMap(null));
        markers = [];
        const filtered = getStoredReports().filter(l =>
            isWithinBandarLampung(Number(l.lat), Number(l.lng)) &&
            (filter === 'all' || l.status === filter)
        );

        filtered.forEach(l => {
            const color = l.status === 'Selesai' ? '#10b981' : l.status === 'Diproses' ? '#f97316' : '#fbbf24';
            const marker = new google.maps.Marker({
                map,
                position: { lat: Number(l.lat), lng: Number(l.lng) },
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    fillColor: color,
                    fillOpacity: 1,
                    strokeColor: '#ffffff',
                    strokeWeight: 3,
                    scale: 9
                }
            });
            marker.addListener('click', function() {
                infoWindow.setContent(`
                <strong>#${l.id} - ${escapeHtml(l.kategori)}</strong><br>
                ${escapeHtml(l.alamat)}<br>
                <em>Status: ${escapeHtml(l.status)}</em>
                `);
                infoWindow.open({ map, anchor: marker });
            });
            markers.push(marker);
        });
    }

    refreshMapMarkers = function() {
        return renderMarkers(currentFilter);
    };

    renderMarkers().catch(showRequestError);

    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            renderMarkers(this.dataset.filter).catch(showRequestError);
        });
    });
}

let googleMapsReady = false;
let documentReady = false;
let mapsInitialized = false;

function initializeMaps() {
    if (!googleMapsReady || !documentReady || mapsInitialized) return;
    mapsInitialized = true;
    initFormMap();
    initPeta();
}

window.initGoogleMaps = function() {
    googleMapsReady = true;
    initializeMaps();
};

// ============ INIT ============
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('btnCloseApiError').addEventListener('click', function() {
        document.getElementById('apiErrorNotice').hidden = true;
    });
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');
    function closeNavMenu() {
        navMenu.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.setAttribute('aria-label', 'Buka menu navigasi');
    }
    navToggle.addEventListener('click', function() {
        const isOpen = navToggle.getAttribute('aria-expanded') === 'true';
        navToggle.setAttribute('aria-expanded', String(!isOpen));
        navToggle.setAttribute('aria-label', isOpen ? 'Buka menu navigasi' : 'Tutup menu navigasi');
        navMenu.classList.toggle('is-open', !isOpen);
    });
    navMenu.querySelectorAll('a').forEach(link => link.addEventListener('click', closeNavMenu));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeNavMenu();
    });
    window.addEventListener('resize', function() {
        if (window.innerWidth > 768) closeNavMenu();
    });
    updateStats().catch(showRequestError);
    initFormLaporan();
    initLacak();
    initWeatherWidget();
    initChatbot();
    documentReady = true;
    initializeMaps();
    const navLinks = document.querySelectorAll('.nav-menu a[href^="#"]');
    function updateActiveNav() {
        const currentHash = window.location.hash || '#beranda';
        navLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === currentHash));
    }
    window.addEventListener('hashchange', updateActiveNav);
    updateActiveNav();
});
// Loading Screen Logic
window.addEventListener('load', function() {
    const loader = document.createElement('div');
    loader.id = 'loader';
    loader.innerHTML = '<div class="loader-spinner"></div><h2>Memuat SmartWarga...</h2>';
    document.body.prepend(loader);
    
    setTimeout(() => {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 500);
    }, 800); // Loading selama 0.8 detik
});