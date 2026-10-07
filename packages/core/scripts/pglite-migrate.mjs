#!/usr/bin/env node
/**
 * pglite-migrate.mjs — menerapkan migrasi Prisma ke database PGlite.
 *
 * `prisma migrate deploy` tidak mengerti DATABASE_URL=pglite://...,
 * jadi skrip ini meniru perilakunya: menjalankan migration.sql yang belum
 * diterapkan (urut direktori) dan mencatatnya di _prisma_migrations.
 *
 *   DATABASE_URL=pglite://./data/e2e node scripts/pglite-migrate.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "../prisma/migrations");

function dataDirFromUrl(url) {
  if (!url || !url.startsWith("pglite://")) {
    console.error("DATABASE_URL harus diawali pglite:// (contoh: pglite://./data/e2e)");
    process.exit(1);
  }
  return url.slice("pglite://".length).trim() || "./data/pglite";
}

async function main() {
  const dataDir = dataDirFromUrl(process.env.DATABASE_URL);
  console.log(`[pglite-migrate] dataDir: ${dataDir}`);
  const pg = new PGlite({ dataDir, extensions: { vector } });

  try {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "finished_at" TIMESTAMPTZ,
        "migration_name" TEXT NOT NULL,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      );
    `);

    const applied = new Set(
      (await pg.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`))
        .rows.map((r) => r.migration_name),
    );

    const dirs = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const dir of dirs) {
      if (applied.has(dir)) {
        console.log(`[pglite-migrate] lewati (sudah diterapkan): ${dir}`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
      console.log(`[pglite-migrate] menerapkan: ${dir}`);
      await pg.exec("BEGIN;");
      try {
        await pg.exec(sql);
        await pg.query(
          `INSERT INTO "_prisma_migrations"
             ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
           VALUES (gen_random_uuid()::text, '', now(), $1, 1)`,
          [dir],
        );
        await pg.exec("COMMIT;");
        console.log(`[pglite-migrate] ok: ${dir}`);
      } catch (err) {
        await pg.exec("ROLLBACK;");
        throw err;
      }
    }
    console.log("[pglite-migrate] selesai.");
  } finally {
    await pg.close();
  }
}

main().catch((err) => {
  console.error("[pglite-migrate] GAGAL:", err.message);
  process.exit(1);
});
