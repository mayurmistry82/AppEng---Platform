import type { Metadata } from "next";
import { Inter, Syne } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
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
    // Theme is managed by ThemeProvider (next-themes, attribute="class") — 2.2
    // replaced 2.1's hardcoded dark class. suppressHydrationWarning stays: the
    // provider mutates <html> class before hydration.
    <html
      lang="en"
      className={`${inter.variable} ${syne.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
