// Headless invariant checks for the real-time fight engine. Run with:
//   npx tsx scripts/fight-engine-test.mjs
// No DOM/canvas involved — this only proves the simulation math is sane.
import { createWorld, stepFight } from "../src/lib/fight/engine.ts";
import { NEUTRAL_INPUT } from "../src/lib/fight/types.ts";
import { STAGE_MARGIN, STAGE_WIDTH } from "../src/lib/fight/constants.ts";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok   - ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL - ${name}`);
  }
}

function input(overrides) {
  return { ...NEUTRAL_INPUT, ...overrides };
}

function run(world, frames, playerInputFn, opponentInputFn) {
  let w = world;
  let allEvents = [];
  for (let i = 0; i < frames; i++) {
    const pIn = playerInputFn ? playerInputFn(w, i) : NEUTRAL_INPUT;
    const oIn = opponentInputFn ? opponentInputFn(w, i) : NEUTRAL_INPUT;
    const { world: nw, events } = stepFight(w, pIn, oIn);
    w = nw;
    allEvents.push(...events);
  }
  return { world: w, events: allEvents };
}

// 1. Walking right moves the player and flips facing toward the opponent.
{
  const w0 = createWorld();
  const { world: w1 } = run(w0, 30, () => input({ right: true }));
  check("walking right increases player.x", w1.player.x > w0.player.x);
  check("player faces opponent while walking", w1.player.facing === 1);
}

// 2. Jump: y goes up then returns to exactly 0, vy resets.
{
  const w0 = createWorld();
  const { world: wJump } = run(w0, 1, () => input({ up: true }));
  check("jump sets airborne", wJump.player.y > 0);
  const { world: wLand } = run(wJump, 60, () => NEUTRAL_INPUT);
  check("jump returns to ground (y=0)", wLand.player.y === 0);
  check("landing resets vy", wLand.player.vy === 0);
}

// 3. Walking into the stage edge clamps x, never exceeds bounds.
{
  const w0 = createWorld();
  const { world: w1 } = run(w0, 500, () => input({ left: true }), () => input({ right: true }));
  check("player x clamps at left margin", w1.player.x >= STAGE_MARGIN - 0.001);
  check("opponent x clamps at right margin", w1.opponent.x <= STAGE_WIDTH - STAGE_MARGIN + 0.001);
}

// 4. Point-blank punch strictly damages the opponent.
{
  let w0 = createWorld();
  // Walk the fighters together first.
  w0 = run(w0, 200, () => input({ right: true }), () => input({ left: true })).world;
  const hpBefore = w0.opponent.hp;
  const { world: w1, events } = run(w0, 30, (w, i) => (i === 0 ? input({ lp: true }) : NEUTRAL_INPUT));
  check("punch at point-blank range lowers opponent HP", w1.opponent.hp < hpBefore);
  check("a hit event was emitted", events.some((e) => e.type === "hit" && e.attacker === "player"));
}

// 5. Blocking (holding away) reduces damage vs a clean hit of the same attack.
{
  let base = createWorld();
  base = run(base, 200, () => input({ right: true }), () => input({ left: true })).world;

  const hpBefore = base.opponent.hp;
  const cleanHit = run(base, 30, (w, i) => (i === 0 ? input({ hp: true }) : NEUTRAL_INPUT), () => NEUTRAL_INPUT);
  const cleanDamage = hpBefore - cleanHit.world.opponent.hp;

  const blockedHit = run(
    base,
    30,
    (w, i) => (i === 0 ? input({ hp: true }) : NEUTRAL_INPUT),
    // Hold away only right around the impact window (frames ~5-14) so the
    // opponent doesn't just walk itself out of range before the hit lands.
    (w, i) => (i >= 5 && i <= 14 ? input({ right: true }) : NEUTRAL_INPUT)
  );
  const blockedDamage = hpBefore - blockedHit.world.opponent.hp;

  check("clean hit deals damage", cleanDamage > 0);
  check("blocked hit deals less damage than a clean hit", blockedDamage < cleanDamage);
  check("a block event was emitted", blockedHit.events.some((e) => e.type === "block"));
}

// 6. An attack whiffs at long range (no event, no damage).
{
  const w0 = createWorld(); // fighters start far apart
  const hpBefore = w0.opponent.hp;
  const { world: w1, events } = run(w0, 30, (w, i) => (i === 0 ? input({ hk: true }) : NEUTRAL_INPUT));
  check("attack at long range does not damage opponent", w1.opponent.hp === hpBefore);
  check("no hit/block event at long range", !events.some((e) => e.type === "hit" || e.type === "block"));
}

// 7. A hit landed shortly after a prior hit (within the combo window) increments comboCount.
{
  let w0 = createWorld();
  w0 = run(w0, 200, () => input({ right: true }), () => input({ left: true })).world;
  // Simulate "already mid-combo": the player landed a hit 5 frames ago.
  w0 = { ...w0, player: { ...w0.player, comboCount: 1, framesSinceLastLand: 5 } };
  const { events } = run(w0, 20, (w, i) => (i === 0 ? input({ lp: true }) : NEUTRAL_INPUT));
  const hit = events.find((e) => e.type === "hit" && e.attacker === "player");
  check("landed a hit for combo test", Boolean(hit));
  check("comboCount increments when within the combo window", Boolean(hit) && hit.comboCount === 2);
}

// 8. HP cannot go negative; KO event fires exactly once when HP hits 0.
{
  let w0 = createWorld();
  w0 = run(w0, 200, () => input({ right: true }), () => input({ left: true })).world;
  w0 = { ...w0, opponent: { ...w0.opponent, hp: 3 } };
  const { world: w1, events } = run(w0, 30, (w, i) => (i === 0 ? input({ hp: true }) : NEUTRAL_INPUT));
  check("HP does not go negative", w1.opponent.hp === 0);
  check("KO event fired", events.filter((e) => e.type === "ko").length === 1);
  check("fighter action is ko after KO", w1.opponent.action === "ko");
}

// 9. Super: requires full meter, consumes it, and out-damages a heavy punch.
{
  let w0 = createWorld();
  w0 = run(w0, 200, () => input({ right: true }), () => input({ left: true })).world;

  // Without meter, pressing super does nothing.
  const broke = run(
    { ...w0, player: { ...w0.player, meter: 30 } },
    30,
    (w, i) => (i === 0 ? input({ super: true }) : NEUTRAL_INPUT)
  );
  check("super without meter deals no damage", broke.world.opponent.hp === w0.opponent.hp);

  // With full meter it fires, consumes the meter, and hits hard.
  const charged = run(
    { ...w0, player: { ...w0.player, meter: 100 } },
    40,
    (w, i) => (i === 0 ? input({ super: true }) : NEUTRAL_INPUT)
  );
  const superDamage = w0.opponent.hp - charged.world.opponent.hp;
  const heavy = run(w0, 40, (w, i) => (i === 0 ? input({ hp: true }) : NEUTRAL_INPUT));
  const heavyDamage = w0.opponent.hp - heavy.world.opponent.hp;
  check("super with full meter deals damage", superDamage > 0);
  check("super consumes the meter", charged.world.player.meter < 100);
  check("super out-damages a heavy punch", superDamage > heavyDamage);
}

// 10. Jumping over a grounded attack avoids it (vertical hitbox check).
{
  let w0 = createWorld();
  w0 = run(w0, 200, () => input({ right: true }), () => input({ left: true })).world;
  // Opponent jumps; player punches while the opponent is high in the air.
  const { world: w1, events } = run(
    w0,
    14,
    (w, i) => (i === 8 ? input({ lp: true }) : NEUTRAL_INPUT),
    (w, i) => (i === 0 ? input({ up: true }) : NEUTRAL_INPUT)
  );
  const oppHighWhenPunched = events.every((e) => e.type !== "hit");
  check("grounded punch whiffs against an airborne opponent", oppHighWhenPunched && w1.opponent.hp === w0.opponent.hp);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
