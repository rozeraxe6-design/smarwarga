import getpass
import base64
import binascii
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen


APP_DIR = Path(__file__).resolve().parent
DATABASE_PATH = APP_DIR / "smartwarga.sqlite3"
HOST = "127.0.0.1"
PORT = 8000
MAX_REQUEST_BYTES = 3 * 1024 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_CHAT_MESSAGES = 8
MAX_CHAT_MESSAGE_CHARS = 1200
MAX_CHAT_TOTAL_CHARS = 6000
CHAT_RATE_LIMIT = 10
CHAT_RATE_WINDOW_SECONDS = 60
PASSWORD_ITERATIONS = 310_000
PASSWORD_MIN_LENGTH = 12
STATUSES = {"Diterima", "Diproses", "Selesai"}
CATEGORIES = {
    "Jalan Rusak",
    "Lampu Mati",
    "Drainase",
    "Taman",
    "Sampah",
    "Lainnya",
}
BOUNDS = {"north": -5.35, "south": -5.60, "east": 105.38, "west": 105.15}
SESSIONS = set()
LOGIN_ATTEMPTS = {}
CHAT_ATTEMPTS = {}
GEMINI_MODEL = "gemini-3.5-flash"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


@contextmanager
def connect_database():
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database():
    with connect_database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nama TEXT NOT NULL,
                email TEXT NOT NULL,
                kategori TEXT NOT NULL,
                alamat TEXT NOT NULL,
                deskripsi TEXT NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('Diterima', 'Diproses', 'Selesai')),
                tanggal TEXT NOT NULL,
                foto BLOB,
                foto_mime TEXT
            )
            """
        )
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(reports)").fetchall()
        }
        if "foto" not in columns:
            connection.execute("ALTER TABLE reports ADD COLUMN foto BLOB")
        if "foto_mime" not in columns:
            connection.execute("ALTER TABLE reports ADD COLUMN foto_mime TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_credentials (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                salt BLOB NOT NULL,
                password_hash BLOB NOT NULL
            )
            """
        )


def ensure_admin_password():
    with connect_database() as connection:
        configured = connection.execute(
            "SELECT 1 FROM admin_credentials WHERE id = 1"
        ).fetchone()
    if configured:
        return

    print("Pengaturan awal SmartWarga: buat kata sandi admin (minimal 12 karakter).")
    while True:
        password = getpass.getpass("Kata sandi admin baru: ")
        if len(password) < PASSWORD_MIN_LENGTH:
            print(f"Kata sandi minimal {PASSWORD_MIN_LENGTH} karakter.")
            continue
        confirmation = getpass.getpass("Ulangi kata sandi admin: ")
        if not hmac.compare_digest(password, confirmation):
            print("Kata sandi tidak sama. Silakan coba lagi.")
            continue
        salt = secrets.token_bytes(16)
        password_hash = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
        )
        with connect_database() as connection:
            connection.execute(
                "INSERT INTO admin_credentials (id, salt, password_hash) VALUES (1, ?, ?)",
                (salt, password_hash),
            )
        print("Kredensial admin tersimpan secara aman di database lokal.")
        return


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class SmartWargaHandler(BaseHTTPRequestHandler):
    server_version = "SmartWarga/1.0"

    def log_message(self, format_string, *args):
        logging.info("%s - %s", self.address_string(), format_string % args)

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if content_type != "application/json":
            raise ApiError(415, "Permintaan harus menggunakan JSON.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(400, "Ukuran permintaan tidak valid.") from error
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ApiError(413, "Ukuran data permintaan tidak valid.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError(400, "Format JSON tidak valid.") from error
        if not isinstance(payload, dict):
            raise ApiError(400, "Format data permintaan tidak valid.")
        return payload

    def require_same_origin(self):
        origin = self.headers.get("Origin")
        if not origin or urlparse(origin).netloc != self.headers.get("Host"):
            raise ApiError(403, "Permintaan lintas situs ditolak.")

    def session_id(self):
        for item in self.headers.get("Cookie", "").split(";"):
            name, separator, value = item.strip().partition("=")
            if separator and name == "smartwarga_session":
                return value
        return None

    def require_admin(self):
        session = self.session_id()
        if not session or session not in SESSIONS:
            raise ApiError(401, "Silakan masuk sebagai admin terlebih dahulu.")

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/auth/session":
                self.send_json(200, {"authenticated": self.session_id() in SESSIONS})
            elif parsed.path == "/api/stats":
                self.get_stats()
            elif parsed.path == "/api/reports/map":
                self.get_map_reports()
            elif parsed.path == "/api/reports/lookup":
                self.lookup_reports(parse_qs(parsed.query).get("q", [""])[0])
            elif re.fullmatch(r"/api/reports/\d+/photo", parsed.path):
                self.require_admin()
                self.get_report_photo(parsed.path)
            elif parsed.path == "/api/reports":
                self.require_admin()
                self.get_reports()
            elif parsed.path.startswith("/api/"):
                raise ApiError(404, "Endpoint tidak ditemukan.")
            else:
                self.serve_static(parsed.path)
        except ApiError as error:
            self.send_json(error.status, {"error": error.message})
        except sqlite3.Error:
            logging.exception("Kesalahan database saat memproses GET %s", self.path)
            self.send_json(500, {"error": "Database tidak dapat memproses permintaan."})

    def do_POST(self):
        try:
            self.require_same_origin()
            parsed = urlparse(self.path)
            if parsed.path == "/api/auth/login":
                self.login()
            elif parsed.path == "/api/auth/logout":
                session = self.session_id()
                if session:
                    SESSIONS.discard(session)
                self.send_json(
                    200,
                    {"ok": True},
                    {"Set-Cookie": "smartwarga_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"},
                )
            elif parsed.path == "/api/reports":
                self.create_report()
            elif parsed.path == "/api/chat":
                self.chat()
            else:
                raise ApiError(404, "Endpoint tidak ditemukan.")
        except ApiError as error:
            self.send_json(error.status, {"error": error.message})
        except sqlite3.Error:
            logging.exception("Kesalahan database saat memproses POST %s", self.path)
            self.send_json(500, {"error": "Database tidak dapat menyimpan permintaan."})

    def chat(self):
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise ApiError(
                503,
                "Chatbot belum dikonfigurasi. Atur GEMINI_API_KEY lalu jalankan ulang server.",
            )

        payload = self.read_json()
        messages = payload.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_CHAT_MESSAGES:
            raise ApiError(400, "Percakapan tidak valid. Mulai percakapan baru.")

        contents = []
        total_chars = 0
        for message in messages:
            if not isinstance(message, dict):
                raise ApiError(400, "Format pesan tidak valid.")
            role = message.get("role")
            text = message.get("text")
            expected_role = "user" if len(contents) % 2 == 0 else "assistant"
            if role != expected_role or not isinstance(text, str):
                raise ApiError(400, "Format pesan tidak valid.")
            text = text.strip()
            if not text or len(text) > MAX_CHAT_MESSAGE_CHARS:
                raise ApiError(400, "Pesan harus berisi maksimal 1.200 karakter.")
            total_chars += len(text)
            if total_chars > MAX_CHAT_TOTAL_CHARS:
                raise ApiError(413, "Percakapan terlalu panjang. Mulai percakapan baru.")
            contents.append({
                "role": "user" if role == "user" else "model",
                "parts": [{"text": text}],
            })
        if messages[-1].get("role") != "user":
            raise ApiError(400, "Pesan terakhir harus berupa pertanyaan pengguna.")

        client = self.client_address[0]
        now = time.monotonic()
        attempts = [
            attempt for attempt in CHAT_ATTEMPTS.get(client, [])
            if now - attempt < CHAT_RATE_WINDOW_SECONDS
        ]
        if len(attempts) >= CHAT_RATE_LIMIT:
            CHAT_ATTEMPTS[client] = attempts
            raise ApiError(429, "Batas pertanyaan tercapai. Coba lagi sebentar.")
        attempts.append(now)
        CHAT_ATTEMPTS[client] = attempts

        request_body = {
            "systemInstruction": {
                "parts": [{
                    "text": (
                        "Kamu adalah asisten informasi SmartWarga, aplikasi prototype "
                        "pelaporan fasilitas publik di Bandar Lampung. Jawab dalam bahasa "
                        "Indonesia dengan ramah dan ringkas. Bantu menjelaskan cara membuat "
                        "laporan, lokasi, pelacakan, penyimpanan lokal browser, cuaca, peta, "
                        "dan SDG 11. SmartWarga saat ini menyimpan laporan di browser/perangkat "
                        "yang sama dan tidak mengirimkannya ke admin. Jangan mengaku laporan "
                        "diterima atau ditindaklanjuti pemerintah. Jangan mengarang status "
                        "laporan, alamat, kebijakan, atau informasi darurat. Jika tidak yakin, "
                        "katakan demikian dan arahkan pengguna ke kanal resmi terkait. Jangan "
                        "meminta atau mengulang data pribadi sensitif."
                    )
                }]
            },
            "contents": contents,
            "generationConfig": {"temperature": 0.4, "maxOutputTokens": 500},
        }
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{GEMINI_MODEL}:generateContent",
            data=json.dumps(request_body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=25) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            logging.warning("Gemini API merespons HTTP %s.", error.code)
            if error.code == 429:
                raise ApiError(429, "Layanan chatbot sedang sibuk. Coba lagi nanti.") from error
            if error.code in {400, 403}:
                raise ApiError(
                    502,
                    "Layanan chatbot menolak permintaan. Periksa konfigurasi API key Gemini.",
                ) from error
            raise ApiError(502, "Layanan chatbot sedang tidak tersedia.") from error
        except (URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as error:
            logging.warning("Tidak dapat menghubungi Gemini API: %s", error)
            raise ApiError(502, "Tidak dapat menghubungi layanan chatbot. Coba lagi.") from error

        if not isinstance(result, dict):
            raise ApiError(502, "Layanan chatbot mengirim respons yang tidak valid.")
        candidates = result.get("candidates", [])
        first_candidate = candidates[0] if isinstance(candidates, list) and candidates else {}
        content = first_candidate.get("content", {}) if isinstance(first_candidate, dict) else {}
        parts = content.get("parts", []) if isinstance(content, dict) else []
        answer = "\n".join(
            part["text"] for part in parts
            if isinstance(parts, list) and isinstance(part, dict) and isinstance(part.get("text"), str)
        ).strip()
        if not answer:
            raise ApiError(502, "Chatbot belum dapat menyusun jawaban. Coba pertanyaan lain.")
        self.send_json(200, {"answer": answer})

    def do_PATCH(self):
        try:
            self.require_same_origin()
            self.require_admin()
            match = re.fullmatch(r"/api/reports/(\d+)", urlparse(self.path).path)
            if not match:
                raise ApiError(404, "Laporan tidak ditemukan.")
            payload = self.read_json()
            status = payload.get("status")
            if not isinstance(status, str) or status not in STATUSES:
                raise ApiError(400, "Status laporan tidak valid.")
            with connect_database() as connection:
                cursor = connection.execute(
                    "UPDATE reports SET status = ? WHERE id = ?", (status, int(match.group(1)))
                )
            if cursor.rowcount == 0:
                raise ApiError(404, "Laporan tidak ditemukan.")
            self.send_json(200, {"ok": True})
        except ApiError as error:
            self.send_json(error.status, {"error": error.message})
        except sqlite3.Error:
            logging.exception("Kesalahan database saat memperbarui laporan %s", self.path)
            self.send_json(500, {"error": "Database tidak dapat memperbarui laporan."})

    def do_DELETE(self):
        try:
            self.require_same_origin()
            self.require_admin()
            match = re.fullmatch(r"/api/reports/(\d+)", urlparse(self.path).path)
            if not match:
                raise ApiError(404, "Laporan tidak ditemukan.")
            with connect_database() as connection:
                cursor = connection.execute(
                    "DELETE FROM reports WHERE id = ?", (int(match.group(1)),)
                )
            if cursor.rowcount == 0:
                raise ApiError(404, "Laporan tidak ditemukan.")
            self.send_json(200, {"ok": True})
        except ApiError as error:
            self.send_json(error.status, {"error": error.message})
        except sqlite3.Error:
            logging.exception("Kesalahan database saat menghapus laporan %s", self.path)
            self.send_json(500, {"error": "Database tidak dapat menghapus laporan."})

    def login(self):
        client = self.client_address[0]
        now = time.monotonic()
        attempts = [attempt for attempt in LOGIN_ATTEMPTS.get(client, []) if now - attempt < 900]
        if len(attempts) >= 5:
            LOGIN_ATTEMPTS[client] = attempts
            raise ApiError(429, "Terlalu banyak percobaan. Coba lagi dalam 15 menit.")

        payload = self.read_json()
        password = payload.get("password")
        if not isinstance(password, str) or len(password) > 1024:
            raise ApiError(400, "Kata sandi tidak valid.")
        with connect_database() as connection:
            credentials = connection.execute(
                "SELECT salt, password_hash FROM admin_credentials WHERE id = 1"
            ).fetchone()
        candidate = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            credentials["salt"],
            PASSWORD_ITERATIONS,
        )
        if not hmac.compare_digest(candidate, credentials["password_hash"]):
            attempts.append(now)
            LOGIN_ATTEMPTS[client] = attempts
            raise ApiError(401, "Kata sandi admin salah.")

        LOGIN_ATTEMPTS.pop(client, None)
        session = secrets.token_urlsafe(32)
        SESSIONS.add(session)
        self.send_json(
            200,
            {"ok": True},
            {
                "Set-Cookie": (
                    f"smartwarga_session={session}; HttpOnly; SameSite=Strict; "
                    "Path=/; Max-Age=28800"
                )
            },
        )

    def create_report(self):
        payload = self.read_json()
        fields = {}
        limits = {"nama": 120, "email": 254, "kategori": 40, "alamat": 300, "deskripsi": 5000}
        for key, maximum in limits.items():
            value = payload.get(key)
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
                raise ApiError(400, f"Isian {key} wajib diisi dan maksimal {maximum} karakter.")
            fields[key] = value.strip()
        if fields["kategori"] not in CATEGORIES:
            raise ApiError(400, "Kategori laporan tidak valid.")
        email = fields["email"]
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ApiError(400, "Format email tidak valid.")

        try:
            lat = float(payload.get("lat"))
            lng = float(payload.get("lng"))
        except (TypeError, ValueError):
            raise ApiError(400, "Titik lokasi laporan tidak valid.")
        if not math.isfinite(lat) or not math.isfinite(lng):
            raise ApiError(400, "Titik lokasi laporan tidak valid.")
        if not (BOUNDS["south"] <= lat <= BOUNDS["north"] and BOUNDS["west"] <= lng <= BOUNDS["east"]):
            raise ApiError(400, "Lokasi laporan harus berada di wilayah Bandar Lampung.")

        photo_data = payload.get("foto")
        photo = None
        photo_mime = None
        if photo_data is not None:
            if not isinstance(photo_data, str):
                raise ApiError(400, "Format foto bukti tidak valid.")
            match = re.fullmatch(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})", photo_data)
            if not match:
                raise ApiError(400, "Foto bukti harus berupa JPG atau PNG yang valid.")
            photo_mime = f"image/{match.group(1)}"
            try:
                photo = base64.b64decode(match.group(2), validate=True)
            except (binascii.Error, ValueError) as error:
                raise ApiError(400, "Isi foto bukti tidak valid.") from error
            if not photo or len(photo) > MAX_IMAGE_BYTES:
                raise ApiError(400, "Ukuran foto maksimal 2 MB.")
            if photo_mime == "image/png" and not photo.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ApiError(400, "Isi foto PNG tidak valid.")
            if photo_mime == "image/jpeg" and not photo.startswith(b"\xff\xd8\xff"):
                raise ApiError(400, "Isi foto JPG tidak valid.")

        with connect_database() as connection:
            cursor = connection.execute(
                """
                INSERT INTO reports (nama, email, kategori, alamat, deskripsi, lat, lng, status, tanggal, foto, foto_mime)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Diterima', ?, ?, ?)
                """,
                (
                    fields["nama"],
                    email,
                    fields["kategori"],
                    fields["alamat"],
                    fields["deskripsi"],
                    lat,
                    lng,
                    date.today().isoformat(),
                    photo,
                    photo_mime,
                ),
            )
        self.send_json(201, {"id": cursor.lastrowid})

    def get_reports(self):
        with connect_database() as connection:
            rows = connection.execute(
                "SELECT id, nama, email, kategori, alamat, deskripsi, lat, lng, status, tanggal, "
                "(foto IS NOT NULL) AS has_foto "
                "FROM reports ORDER BY id DESC"
            ).fetchall()
        self.send_json(200, {"reports": [dict(row) for row in rows]})

    def get_report_photo(self, path):
        report_id = int(re.fullmatch(r"/api/reports/(\d+)/photo", path).group(1))
        with connect_database() as connection:
            row = connection.execute(
                "SELECT foto, foto_mime FROM reports WHERE id = ?", (report_id,)
            ).fetchone()
        if not row or row["foto"] is None:
            raise ApiError(404, "Foto bukti tidak ditemukan.")
        data_url = f"{row['foto_mime']};base64,{base64.b64encode(row['foto']).decode('ascii')}"
        self.send_json(200, {"dataUrl": f"data:{data_url}"})

    def get_map_reports(self):
        with connect_database() as connection:
            rows = connection.execute(
                "SELECT id, kategori, alamat, lat, lng, status FROM reports ORDER BY id DESC"
            ).fetchall()
        self.send_json(200, {"reports": [dict(row) for row in rows]})

    def get_stats(self):
        with connect_database() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS total,
                       COUNT(DISTINCT lower(email)) AS warga,
                       COALESCE(SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END), 0) AS selesai,
                       COALESCE(SUM(CASE WHEN status = 'Diproses' THEN 1 ELSE 0 END), 0) AS diproses
                FROM reports
                """
            ).fetchone()
        self.send_json(
            200,
            {
                "total": row["total"],
                "warga": row["warga"],
                "selesai": row["selesai"],
                "diproses": row["diproses"],
            },
        )

    def lookup_reports(self, query):
        query = query.strip()
        if not query or len(query) > 254:
            raise ApiError(400, "Masukkan ID laporan atau email yang valid.")
        with connect_database() as connection:
            if query.isdigit():
                report_id = int(query)
                if report_id > 9_223_372_036_854_775_807:
                    rows = []
                else:
                    rows = connection.execute(
                        "SELECT id, kategori, alamat, deskripsi, status, tanggal FROM reports WHERE id = ?",
                        (report_id,),
                    ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT id, kategori, alamat, deskripsi, status, tanggal FROM reports
                    WHERE lower(email) = lower(?) ORDER BY id DESC
                    """,
                    (query,),
                ).fetchall()
        self.send_json(200, {"reports": [dict(row) for row in rows]})

    def serve_static(self, request_path):
        relative = unquote(request_path).lstrip("/") or "index.html"
        candidate = (APP_DIR / relative).resolve()
        if APP_DIR not in candidate.parents and candidate != APP_DIR:
            raise ApiError(404, "Halaman tidak ditemukan.")
        if not candidate.is_file() or candidate.suffix.lower() not in {
            ".html",
            ".css",
            ".js",
            ".jpe",
            ".jpg",
            ".jpeg",
            ".png",
        }:
            raise ApiError(404, "Halaman tidak ditemukan.")
        content = candidate.read_bytes()
        content_type = "text/html; charset=utf-8"
        if candidate.suffix.lower() == ".css":
            content_type = "text/css; charset=utf-8"
        elif candidate.suffix.lower() == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif candidate.suffix.lower() in {".jpe", ".jpg", ".jpeg"}:
            content_type = "image/jpeg"
        elif candidate.suffix.lower() == ".png":
            content_type = "image/png"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    initialize_database()
    ensure_admin_password()
    httpd = ThreadingHTTPServer((HOST, PORT), SmartWargaHandler)
    print(f"SmartWarga berjalan di http://{HOST}:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer SmartWarga dihentikan.")