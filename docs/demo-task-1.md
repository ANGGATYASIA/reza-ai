# Bukti demo Task 1

Tanggal: 6 Okt 2026, ~23:55 WIB. Lingkungan: Ubuntu 24.04 native (PostgreSQL 16 + pgvector 0.8.7 hasil kompilasi dari source, Redis 7). Docker tidak tersedia di sandbox, jadi web dan worker dijalankan sebagai dua proses via `pnpm start`.

## 1. Migrasi dan ekstensi

```
$ psql -c "\dx" | grep vector
 vector | 0.8.7 | public | vector data type and ivfflat and hnsw access methods

$ psql -c "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;"
     migration_name
 20261006164509_init
 20261006170000_search
```

18 relasi terbuat (17 model + `_prisma_migrations`). Kolom `embedding vector(1536)` ada di `KnowledgeChunk` dan `ExamplePair`; kolom `tsv` (tsvector, generated) + index GIN + 2 index HNSW terverifikasi lewat `pg_indexes`.

Smoke test SQL:

```sql
-- full-text (GIN): 1 baris, rank 0.327
SELECT title FROM "KnowledgeChunk" WHERE tsv @@ plainto_tsquery('simple','harga verona');
-- vektor (HNSW): jarak 0 untuk vektor identik
SELECT title FROM "KnowledgeChunk" ORDER BY embedding <=> '<1536 dim>'::vector LIMIT 1;
```

## 2. Health check: semua komponen ok

```
$ curl -s http://localhost:3000/api/health
{"db":"ok","redis":"ok","worker":"ok","ts":"2026-10-06T16:57:10.476Z"}
HTTP 200
```

`db` = `SELECT 1` via Prisma sungguhan, `redis` = `PING` via ioredis sungguhan, `worker` = heartbeat `reza:worker:heartbeat` di Redis berumur < 60 detik.

## 3. Health check: worker dimatikan

Worker di-SIGTERM (log mencatat shutdown rapi: "Menerima SIGTERM — shutdown rapi... Antrian & koneksi Redis ditutup."). Setelah 60+ detik tanpa heartbeat:

```
$ curl -s http://localhost:3000/api/health
{"db":"ok","redis":"ok","worker":"error","ts":"2026-10-06T16:58:25.701Z"}
HTTP 503
```

Status berubah tanpa restart web — bukti nilainya dihitung, bukan di-hardcode.

## 4. Health check: worker dinyalakan lagi

```
$ curl -s http://localhost:3000/api/health
{"db":"ok","redis":"ok","worker":"ok","ts":"2026-10-06T16:58:56.039Z"}
HTTP 200
```

## 5. BullMQ end-to-end

Key Redis `reza:*` memuat 7 antrian (`inbound`, `ai-reply`, `send`, `ingest`, `followup`, `digest`, `reindex`). Job test ke antrian `inbound` langsung diproses worker placeholder:

```
[worker:inbound] job 1 (test-message) diterima — belum diproses (placeholder Task 1)
```

## 6. Test dan build

- `pnpm install` — bersih (EXIT 0)
- `pnpm build` — lolos (core tsc, web next build, worker tsc)
- `pnpm test` — 16/16 hijau (9 health integrasi via PGlite + ioredis-mock, 7 util WIB)
- `pnpm lint` — bersih di 3 package
- Tidak ada console error di log web maupun worker selama demo
