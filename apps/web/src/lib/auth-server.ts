import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE, getSessionAdminId, type AdminIdentity } from "./auth";
import { getRedis, prisma } from "./server";

/**
 * Baca identitas admin dari cookie sesi (Server Component / Layout).
 * Di-cache per request via React cache().
 */
export const getCurrentAdmin = cache(async (): Promise<AdminIdentity | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const adminId = await getSessionAdminId(getRedis(), token);
  if (!adminId) return null;
  const admin = await prisma.admin.findUnique({
    where: { id: adminId },
    select: { id: true, email: true },
  });
  return admin;
});

/**
 * Penjaga halaman: redirect ke /login bila tidak ada sesi valid.
 * Dipakai di layout/page yang dilindungi. Task berikutnya memakai
 * helper ini (atau getCurrentAdmin) untuk halaman settings, inbox, dst.
 */
export async function requireAdminPage(): Promise<AdminIdentity> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/login");
  return admin;
}
