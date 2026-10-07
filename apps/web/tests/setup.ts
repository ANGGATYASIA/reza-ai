// MASTER_KEY uji untuk pack/unpack secret TOTP (AES-256-GCM).
// Bukan kunci produksi — hanya dipakai selama vitest berjalan.
process.env.MASTER_KEY = "b".repeat(64);
process.env.TOTP_ISSUER = "Reza AI (test)";
