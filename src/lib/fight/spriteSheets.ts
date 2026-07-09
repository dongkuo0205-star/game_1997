// ============================================================================
// Sprite-sheet metadata + loader for the Martial Hero character pack
// (CC0 / public domain, by LuizMelo — https://luizmelo.itch.io/martial-hero).
// Every sheet is a horizontal strip of 200x200 frames, authored facing RIGHT.
// ============================================================================

export const FRAME_SIZE = 200;

export type AnimName =
  | "idle"
  | "run"
  | "jump"
  | "fall"
  | "attack1"
  | "attack2"
  | "takeHit"
  | "death";

export interface AnimDef {
  file: string;
  frames: number;
  /** engine frames (60fps ticks) per animation frame when free-running */
  ticksPerFrame: number;
  loop: boolean;
}

export const ANIMS: Record<AnimName, AnimDef> = {
  idle: { file: "/sprites/hero/Idle.png", frames: 8, ticksPerFrame: 8, loop: true },
  run: { file: "/sprites/hero/Run.png", frames: 8, ticksPerFrame: 6, loop: true },
  jump: { file: "/sprites/hero/Jump.png", frames: 2, ticksPerFrame: 10, loop: true },
  fall: { file: "/sprites/hero/Fall.png", frames: 2, ticksPerFrame: 10, loop: true },
  attack1: { file: "/sprites/hero/Attack1.png", frames: 6, ticksPerFrame: 4, loop: false },
  attack2: { file: "/sprites/hero/Attack2.png", frames: 6, ticksPerFrame: 5, loop: false },
  takeHit: { file: "/sprites/hero/TakeHit.png", frames: 4, ticksPerFrame: 5, loop: false },
  death: { file: "/sprites/hero/Death.png", frames: 6, ticksPerFrame: 8, loop: false },
};

export interface LoadedSheets {
  images: Record<AnimName, HTMLImageElement>;
  /** content bounding box of Idle frame 0, in source pixels — used to anchor feet/center */
  anchor: { centerX: number; bottomY: number; height: number };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

/** Scans Idle frame 0 alpha to find where the figure actually sits inside the 200x200 frame. */
function computeAnchor(idle: HTMLImageElement): LoadedSheets["anchor"] {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE;
  canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { centerX: FRAME_SIZE / 2, bottomY: FRAME_SIZE, height: FRAME_SIZE / 2 };
  ctx.drawImage(idle, 0, 0, FRAME_SIZE, FRAME_SIZE, 0, 0, FRAME_SIZE, FRAME_SIZE);
  const data = ctx.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE).data;

  let minX = FRAME_SIZE, maxX = 0, minY = FRAME_SIZE, maxY = 0;
  for (let y = 0; y < FRAME_SIZE; y++) {
    for (let x = 0; x < FRAME_SIZE; x++) {
      if (data[(y * FRAME_SIZE + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    return { centerX: FRAME_SIZE / 2, bottomY: FRAME_SIZE, height: FRAME_SIZE / 2 };
  }
  return {
    centerX: (minX + maxX) / 2,
    bottomY: maxY + 1,
    height: maxY + 1 - minY,
  };
}

export async function loadSheets(): Promise<LoadedSheets> {
  const names = Object.keys(ANIMS) as AnimName[];
  const loaded = await Promise.all(names.map((n) => loadImage(ANIMS[n].file)));
  const images = Object.fromEntries(names.map((n, i) => [n, loaded[i]])) as LoadedSheets["images"];
  return { images, anchor: computeAnchor(images.idle) };
}
