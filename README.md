# SmartWarga (situs statis lokal)

## Menjalankan

Buka `index.html` langsung di browser untuk fitur situs dasar. Chatbot Gemini memerlukan server Python yang dijalankan sesuai langkah di bagian Chatbot Gemini.

## Chatbot Gemini

Chatbot memerlukan server Python agar API key Gemini tetap berada di server dan tidak terekspos ke browser. Buat API key di Google AI Studio, atur sebagai environment variable, lalu jalankan server dari folder proyek. Contoh PowerShell:

```powershell
$env:GEMINI_API_KEY = "API_KEY_ANDA"
python server.py
```

Saat pertama kali berjalan, server akan meminta pembuatan kata sandi admin untuk database lokal. Buka `http://127.0.0.1:8000` setelah server aktif. Jangan menaruh API key di `index.html`, `script.js`, atau file yang diunggah ke repositori. Pemakaian Gemini dapat tunduk pada kuota dan biaya dari Google. Pesan chat diteruskan ke Gemini untuk dibuat jawabannya; hindari mengirim data pribadi atau rahasia. Percakapan hanya tersimpan sementara selama panel chat pada halaman tersebut terbuka.

## Penyimpanan laporan saat ini

Laporan disimpan menggunakan penyimpanan lokal browser (`localStorage`). Data hanya tersedia di browser dan perangkat tempat laporan dibuat; laporan tidak dikirim ke admin, tidak dibagikan ke perangkat lain, dan dapat hilang jika data browser dihapus. Simpan ID laporan untuk melacaknya di browser/perangkat yang sama.

Mode ini hanya untuk penggunaan satu perangkat. Untuk penggunaan multiuser dengan laporan tersimpan dalam database dan dapat diakses admin, diperlukan backend seperti PHP dan MySQL.

Pencarian alamat menggunakan Nominatim OpenStreetMap saat pengguna selesai mengetik lalu meninggalkan kolom alamat; pencarian tidak berjalan sebagai autocomplete. Hingga lima kandidat yang berada dalam batas Bandar Lampung ditampilkan untuk dipilih pengguna, bukan langsung memasang hasil pertama. Periksa kandidat dan posisi pin sebelum mengirim; alamat yang tidak tersedia atau kurang rinci pada data peta tidak dapat dijamin akurasinya dan perlu dipilih manual di peta. Laporan tidak dapat dikirim sebelum koordinat lokasi dipilih. Permintaan dibatasi minimal 1,1 detik antar-request dan hasil pencarian diberi atribusi OpenStreetMap. Penggunaan layanan publik harus mengikuti [kebijakan Nominatim](https://operations.osmfoundation.org/policies/nominatim/); layanan ini ditujukan untuk penggunaan moderat dan dapat berubah sewaktu-waktu. Peta tetap memerlukan Google Maps JavaScript API.

Widget cuaca dapat memakai GPS untuk meminta cuaca pada koordinat perangkat. Pengguna dapat memilih nama kecamatan Bandar Lampung; koordinat dikirim ke layanan cuaca dan OpenStreetMap untuk mencari nama wilayah. Akses lokasi harus diizinkan browser.
