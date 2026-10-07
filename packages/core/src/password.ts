import argon2 from "argon2";

/**
 * Hash kata sandi admin dengan Argon2id (default library argon2).
 * Dipakai saat pembuatan admin (wizard /setup) dan reset kata sandi.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

/**
 * Verifikasi kata sandi terhadap hash Argon2.
 * Mengembalikan false (bukan throw) bila hash tidak cocok — pemanggil
 * yang memutuskan respons anti-enumerasi.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Aturan kekuatan kata sandi untuk akun admin.
 * Mengembalikan pesan galat Bahasa Indonesia, atau null bila lolos.
 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) {
    return "Kata sandi minimal 12 karakter.";
  }
  return null;
}

/** Validasi format email sederhana (cukup untuk form admin). */
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
