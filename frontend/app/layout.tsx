import type { Metadata } from "next";
import { Inter, Syne } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font — no request-time Google Fonts fetch, no FOUT.
// Decision #27: Inter for everything; Syne ExtraBold (800) for the three
// brand-display headlines (hero-xl / hero / hero-sub) ONLY.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "900"],
  variable: "--font-inter",
  display: "swap",
});

const syne = Syne({
  subsets: ["latin"],
  weight: "800",
  variable: "--font-syne",
  display: "swap",
});

export const metadata: Metadata = {
  title: "EnrgEngine",
  description: "Accurate Solar + BESS sizing reports Australian installers can trust.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // className="dark" is HARDCODED so the app keeps rendering dark exactly as
    // before this token layer landed (:root is now light, .dark is dark).
    // Checklist 2.2 replaces this class with a theme provider — do not build a
    // toggle here. suppressHydrationWarning exists for that same provider.
    <html
      lang="en"
      className={`${inter.variable} ${syne.variable} dark`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
