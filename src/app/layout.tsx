import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/toast";
import { publicAppUrl } from "@/server/env";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(publicAppUrl()),
  title: {
    default: "Kalendr — Appointments for any business",
    template: "%s · Kalendr",
  },
  description:
    "Online booking, team schedules, and reminders for salons, clinics, tutors, agencies, and any business that runs on appointments.",
  applicationName: "Kalendr",
  authors: [{ name: "Khanect" }],
  creator: "Khanect",
  publisher: "Khanect",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Kalendr" },
  formatDetection: { telephone: false },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // Every page carries a per-request CSP nonce (src/proxy.ts), so none can be prerendered.
  await connection();

  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} light h-full antialiased`}
    >
      <body className="relative">
        <ToastProvider>
          <AnchoredToastProvider>
            <div className="relative isolate flex min-h-svh flex-col">{children}</div>
          </AnchoredToastProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
