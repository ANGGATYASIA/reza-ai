-- Task 6: kolom sumber mentah + pesan error untuk KnowledgeItem.
-- content  = teks mentah (type=text)
-- data     = berkas mentah (type=pdf, BYTEA)
-- errorMessage = pesan kegagalan terakhir saat status=failed
ALTER TABLE "KnowledgeItem" ADD COLUMN "content" TEXT;
ALTER TABLE "KnowledgeItem" ADD COLUMN "data" BYTEA;
ALTER TABLE "KnowledgeItem" ADD COLUMN "errorMessage" TEXT;
