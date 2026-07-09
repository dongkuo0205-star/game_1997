import type { Metadata } from "next";
import { Press_Start_2P } from "next/font/google";
import "./globals.css";

// The arcade pixel font referenced by tailwind's font-arcade. Latin/digits
// only — Korean text falls through to the system font, which is intended.
const pressStart = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-arcade",
  display: "swap",
});

export const metadata: Metadata = {
  title: "오락실 1997",
  description: "1997년 서울, 학교 앞 오락실에서 펼쳐지는 반실시간 텍스트 격투 성장 게임",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={pressStart.variable}>
      <body>{children}</body>
    </html>
  );
}
