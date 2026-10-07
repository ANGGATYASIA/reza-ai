/**
 * Stage pipeline lead Reza AI.
 * Urutan: New → Qualified → Hot → Survei Dijadwalkan → Negosiasi
 *        → Booking → Closing.  Lost bisa dari stage mana pun.
 */
export const LEAD_STAGES = [
  "New",
  "Qualified",
  "Hot",
  "Survei Dijadwalkan",
  "Negosiasi",
  "Booking",
  "Closing",
  "Lost",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export function isValidStage(stage: string): stage is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(stage);
}

/** Stage terminal: tidak ada follow-up otomatis lagi. */
export const TERMINAL_STAGES: readonly LeadStage[] = ["Closing", "Lost"];
