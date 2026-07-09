import { Ending, PlayerStats } from "@/types/game";

// Renders a 800x420 retro result card to an offscreen canvas and triggers a
// PNG download — the shareable artifact for social posts.
export function downloadEndingCard(ending: Ending, stats: PlayerStats): void {
  const W = 800;
  const H = 420;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // sunset backdrop, same mood as the fight stage
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#2b1a4d");
  sky.addColorStop(0.5, "#75345f");
  sky.addColorStop(0.85, "#c85a50");
  sky.addColorStop(1, "#f0a05a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // skyline silhouettes
  ctx.fillStyle = "#241226";
  const buildings = [0, 90, 170, 280, 360, 470, 560, 660, 740];
  buildings.forEach((x, i) => {
    const h = 70 + ((i * 53) % 90);
    ctx.fillRect(x, H - h - 40, 80, h + 40);
  });
  ctx.fillStyle = "#ffca6e";
  buildings.forEach((x, i) => {
    const h = 70 + ((i * 53) % 90);
    for (let wx = x + 10; wx < x + 70; wx += 18) {
      for (let wy = H - h - 28; wy < H - 52; wy += 22) {
        if ((wx + wy * 3) % 13 < 6) ctx.fillRect(wx, wy, 6, 8);
      }
    }
  });

  // scanlines
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);

  // frame
  ctx.strokeStyle = "#ff5c73";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, W - 16, H - 16);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffe14d";
  ctx.font = "bold 24px monospace";
  ctx.fillText("오락실 1997", W / 2, 66);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 40px sans-serif";
  ctx.shadowColor = "#ff5c73";
  ctx.shadowBlur = 16;
  ctx.fillText(ending.nameKo, W / 2, 140);
  ctx.shadowBlur = 0;

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#ffe9c9";
  const lines = [
    `${stats.day}일간의 오락실 생활 · 총 ${stats.total_wins}승 ${stats.total_losses}패`,
    `명성 ${stats.fame} · 최대 연승 기록의 주인공`,
    `첫사랑 호감도 ${stats.love} · 가족 관계 ${stats.family}`,
    `졸업 시점 소지금 ${stats.money.toLocaleString()}원`,
  ];
  lines.forEach((line, i) => ctx.fillText(line, W / 2, 200 + i * 32));

  ctx.font = "13px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fillText("1997년, 그 시절 오락실로 — 당신의 엔딩은?", W / 2, H - 44);

  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `oraksil1997-${ending.id}.png`;
  a.click();
}
