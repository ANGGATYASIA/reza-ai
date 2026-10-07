import type { NextConfig } from "next";

// Paket yang TIDAK BOLEH dibundel ke chunk server — harus di-require()
// dari node_modules asli saat runtime:
// - @reza-ai/core: menarik argon2 (native binding) + @electric-sql/pglite.
// - @electric-sql/pglite: memuat file .wasm/.data via import.meta.url —
//   rusak bila dibundel (Turbopack menulis ulang path jadi /ROOT/...).
// - pglite-prisma-adapter, @prisma/client: query engine.
// - argon2: node-gyp-build mencari file .node relatif ke lokasi paket.
//
// Catatan pnpm: serverExternalPackages dicocokkan via regex
// `node_modules/<pkg>/` pada path ter-resolve; symlink workspace
// (@reza-ai/core -> packages/core) TIDAK cocok, jadi ada fungsi
// externals kustom sebagai backstop di bawah.
const KEEP_EXTERNAL = [
  "@reza-ai/core",
  "@electric-sql/pglite",
  "pglite-prisma-adapter",
  "@prisma/client",
  "argon2",
];

const nextConfig: NextConfig = {
  serverExternalPackages: KEEP_EXTERNAL,
  webpack: (config, { isServer }) => {
    if (isServer) {
      const prev = config.externals;
      config.externals = [
        ...(Array.isArray(prev) ? prev : prev ? [prev] : []),
        ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
          if (request && KEEP_EXTERNAL.includes(request)) {
            return callback(null, `commonjs ${request}`);
          }
          return callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
