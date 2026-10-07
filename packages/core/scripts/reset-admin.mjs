#!/usr/bin/env node
/**
 * reset-admin.mjs — skrip darurat untuk akun admin Reza AI.
 *
 * Aman karena hanya bisa dijalankan dari shell server (butuh akses langsung
 * ke DATABASE_URL). TIDAK ada endpoint HTTP untuk operasi ini.
 *
 *   node scripts/reset-admin.mjs --list
 *   node scripts/reset-admin.mjs --reset-totp admin@contoh.id [--yes]
 *   node scripts/reset-admin.mjs --reset-password admin@contoh.id [--yes]
 *
 * --reset-totp:     mengosongkan secret 2FA. Saat login berikutnya (kata
 *                   sandi benar), admin diarahkan ke /setup-2fa untuk
 *                   memindai QR baru.
 * --reset-password: mengganti kata sandi dengan kata sandi acak 16 karakter
 *                   yang dicetak SEKALI ke terminal ini.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { prisma } from "../dist/index.js";
import argon2 from "argon2";

function usage() {
  console.log("Pakai: node scripts/reset-admin.mjs --list | --reset-totp <email> | --reset-password <email> [--yes]");
  process.exit(1);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");

  if (args.includes("--list")) {
    const admins = await prisma.admin.findMany({
      select: { email: true, createdAt: true, totpSecret: true },
      orderBy: { createdAt: "asc" },
    });
    if (admins.length === 0) {
      console.log("Belum ada akun admin. Buka /setup di browser untuk membuatnya.");
      return;
    }
    for (const a of admins) {
      console.log(`- ${a.email} | dibuat ${a.createdAt.toISOString()} | 2FA: ${a.totpSecret ? "aktif" : "belum"}`);
    }
    return;
  }

  const totpIdx = args.indexOf("--reset-totp");
  const passIdx = args.indexOf("--reset-password");
  if (totpIdx === -1 && passIdx === -1) usage();

  const email = (args[(totpIdx !== -1 ? totpIdx : passIdx) + 1] ?? "").trim().toLowerCase();
  if (!email || email.startsWith("--")) usage();

  const admin = await prisma.admin.findUnique({ where: { email } });
  if (!admin) {
    console.error(`Akun ${email} tidak ditemukan.`);
    process.exit(2);
  }

  if (totpIdx !== -1) {
    if (!yes && !(await confirm(`Kosongkan 2FA untuk ${email}? (y/N) `))) {
      console.log("Dibatalkan.");
      return;
    }
    await prisma.admin.update({ where: { id: admin.id }, data: { totpSecret: null } });
    console.log(`2FA untuk ${email} dikosongkan. Login berikutnya akan meminta aktivasi ulang di /setup-2fa.`);
    return;
  }

  if (!yes && !(await confirm(`Ganti kata sandi ${email} dengan kata sandi acak? (y/N) `))) {
    console.log("Dibatalkan.");
    return;
  }
  const tempPassword = randomBytes(12).toString("base64url");
  await prisma.admin.update({
    where: { id: admin.id },
    data: { passwordHash: await argon2.hash(tempPassword) },
  });
  console.log(`Kata sandi baru untuk ${email}: ${tempPassword}`);
  console.log("Catat sekarang — kata sandi ini tidak disimpan di mana pun selain di sini.");
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
