import { PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PrismaPGlite } from "pglite-prisma-adapter";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const PLACEHOLDER_URL = "postgresql://127.0.0.1:5432/reza_ai_belum_dikonfigurasi";

/**
 * Mode PGlite: DATABASE_URL diawali "pglite://".
 * Dipakai untuk testing & E2E di sandbox tanpa postgres native:
 *   DATABASE_URL=pglite://./data/e2e
 * Path sesudah prefix = dataDir PGlite (persisten antar run).
 * Path relatif di-resolve dari working directory proses.
 * Default bila kosong: ./data/pglite
 */
export function isPGliteUrl(url: string | undefined): boolean {
  return !!url && url.startsWith("pglite://");
}

export function pgliteDataDir(url: string): string {
  const rest = url.slice("pglite://".length).trim();
  return rest || "./data/pglite";
}

function resolveUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Jangan throw saat import: build Next.js mengevaluasi modul ini.
    // Query akan gagal saat runtime dan /api/health melaporkannya
    // secara jujur sebagai db:"error".
    console.warn(
      "[reza-ai/core] DATABASE_URL belum diset — memakai placeholder. " +
        "Salin .env.example ke .env lalu isi nilainya.",
    );
    return PLACEHOLDER_URL;
  }
  return url;
}

function buildClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  const log = (process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]) as Array<
    "warn" | "error"
  >;

  if (isPGliteUrl(url)) {
    // PGlite = Postgres asli (WASM) dengan driver adapter Prisma.
    // Ekstensi `vector` diregistrasi eksplisit agar CREATE EXTENSION vector
    // di migrasi init jalan. Migrasi SQL asli (HNSW, tsvector) tetap jalan —
    // lihat packages/core/scripts/pglite-migrate.mjs.
    const pg = new PGlite({ dataDir: pgliteDataDir(url!), extensions: { vector } });
    const adapter = new PrismaPGlite(pg);
    return new PrismaClient({ adapter, log });
  }

  return new PrismaClient({
    datasources: { db: { url: resolveUrl() } },
    log,
  });
}

/**
 * Singleton PrismaClient untuk seluruh monorepo.
 * Cara pakai:  import { prisma } from "@reza-ai/core";
 */
export const prisma: PrismaClient = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
