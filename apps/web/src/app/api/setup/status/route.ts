import { NextResponse } from "next/server";
import { prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/setup/status — true bila tabel Admin masih kosong. */
export async function GET() {
  const count = await prisma.admin.count();
  return NextResponse.json({ needsSetup: count === 0 });
}
