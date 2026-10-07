import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/drafts/[id]/reject — tolak draf AI (Task 8).
 * Draf ditandai "rejected" dan tidak dikirim.
 * Terproteksi: butuh sesi admin.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const draft = await prisma.draft.findUnique({ where: { id } });
  if (!draft) {
    return NextResponse.json({ error: "Draf tidak ditemukan." }, { status: 404 });
  }
  if (draft.status !== "pending") {
    return NextResponse.json(
      { error: `Draf sudah ${draft.status} — tidak bisa ditolak ulang.` },
      { status: 409 },
    );
  }

  await prisma.draft.update({
    where: { id },
    data: { status: "rejected" },
  });

  return NextResponse.json({ ok: true, draft: { id, status: "rejected" } });
}
