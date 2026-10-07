-- Task 6 fix: kolom "data" KnowledgeItem dari BYTEA -> TEXT (base64).
-- Driver adapter PGlite merusak nilai Bytes biner
-- ("expected a string or an array in column 'data'"), jadi berkas PDF
-- disimpan sebagai base64 TEXT yang aman di semua operasi Prisma.
ALTER TABLE "KnowledgeItem" ALTER COLUMN "data" TYPE TEXT USING encode("data", 'base64');
