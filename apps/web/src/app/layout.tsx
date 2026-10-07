import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reza AI — Dashboard",
  description: "Dashboard admin Reza AI, WhatsApp Sales Agent Grand Duta City South of Jakarta.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
