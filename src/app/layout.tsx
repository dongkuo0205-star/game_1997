import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "오락실 1997",
  description: "1997년 서울, 학교 앞 오락실에서 펼쳐지는 반실시간 텍스트 격투 성장 게임",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
