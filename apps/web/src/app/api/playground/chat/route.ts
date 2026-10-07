import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  generateReply,
  getEffectiveProviderConfig,
  getGeneralSettings,
  type HistoryMessage,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

interface ChatMessageBody {
  role?: string;
  text?: string;
}

/**
 * POST /api/playground/chat — uji AI reply engine tanpa WhatsApp.
 * Body: {messages: [{role: "lead"|"reza", text}]} — pesan terakhir HARUS
 * dari lead (itulah yang dijawab). Menjalankan generateReply ASLI:
 * hybridSearch asli + LLM asli via slot chat yang dikonfigurasi.
 * Bila slot chat belum dikonfigurasi -> 400 dengan pesan jelas (UI
 * menampilkan error state, bukan diam).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { messages?: ChatMessageBody[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ error: "messages tidak boleh kosong." }, { status: 400 });
  }
  const last = messages[messages.length - 1];
  const question = (last.text ?? "").trim();
  if (last.role !== "lead" || !question) {
    return NextResponse.json(
      { error: "Pesan terakhir harus dari lead dan tidak boleh kosong." },
      { status: 400 },
    );
  }
  if (question.length > 2000) {
    return NextResponse.json(
      { error: "Pesan maksimal 2000 karakter." },
      { status: 400 },
    );
  }
  const history: HistoryMessage[] = messages
    .slice(0, -1)
    .filter((m) => (m.role === "lead" || m.role === "reza") && (m.text ?? "").trim())
    .map((m) => ({ role: m.role as "lead" | "reza", text: (m.text as string).trim() }));

  // Cek eksplisit sebelum generateReply: UI butuh error yang jelas
  // bila provider chat belum disiapkan.
  const chatCfg = await getEffectiveProviderConfig("chat");
  if (!chatCfg || !chatCfg.enabled || !chatCfg.baseUrl || !chatCfg.model) {
    return NextResponse.json(
      {
        error:
          "Slot chat belum dikonfigurasi. Atur provider chat di Pengaturan → Provider AI dulu, lalu coba lagi.",
      },
      { status: 400 },
    );
  }

  const general = await getGeneralSettings();
  const redis = getRedis();

  const result = await generateReply(
    {
      message: question,
      history,
      persona: {
        name: general.personaName || "Reza",
        tone: general.personaTone,
      },
    },
    {
      prisma,
      redis,
      getChatConfig: () => getEffectiveProviderConfig("chat"),
      getEmbeddingConfig: () => getEffectiveProviderConfig("embedding"),
    },
  );

  return NextResponse.json({
    reply: result.reply,
    confidence: result.confidence,
    handoff: result.handoff,
    reason: result.reason,
    sourcesUsed: result.sourcesUsed,
    sources: result.sources,
  });
}
