-- Pencarian hybrid knowledge base (dipakai Task 6).
-- Prisma tidak mendukung tsvector / index HNSW secara native,
-- jadi migrasi ini ditulis sebagai SQL manual.

-- Kolom tsv: tsvector yang digenerate otomatis dari title + content.
-- Memakai konfigurasi 'simple' (tanpa stemming) karena konten berbahasa Indonesia.
ALTER TABLE "KnowledgeChunk"
  ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("content", ''))
  ) STORED;

-- Index GIN untuk pencarian full-text.
CREATE INDEX "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");

-- Index HNSW untuk pencarian kemiripan vektor (cosine distance).
-- Parameter default (m=16, ef_construction=64) cukup untuk skala awal;
-- Task 6 boleh menala ulang bila korpus membesar.
CREATE INDEX "KnowledgeChunk_embedding_hnsw_idx" ON "KnowledgeChunk"
  USING hnsw ("embedding" vector_cosine_ops);

-- Index HNSW yang sama untuk embedding contoh jawaban (dipakai Task 7).
CREATE INDEX "ExamplePair_embedding_hnsw_idx" ON "ExamplePair"
  USING hnsw ("embedding" vector_cosine_ops);
