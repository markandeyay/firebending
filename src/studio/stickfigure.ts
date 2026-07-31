/**
 * Looping stick-figure instruction animations for the studio cards. One
 * front-facing figure (drawn as the player's MIRROR, matching the game's
 * player-space convention: the player's left hand is on the left side of
 * the canvas), keyframed per move with explicit elbow/wrist positions in a
 * unit box, smoothstep-interpolated, looped.
 *
 * TOWARD-VIEWER motion (jabs, palm strikes, twin cannon, stream, fan) is a
 * 2D-canvas problem: it is conveyed by the per-arm `z` channel, which grows
 * the hand marker (projective size), draws short radiating speed lines
 * around it, and pulls the wrist slightly toward the chest center line, so
 * an extension at the camera cannot be misread as a sideways or upward
 * move. Ink strokes on the card's parchment; the striking hand warms to
 * ember at full extension. No neon.
 */

export type StickAnimName =
  | 'jab-left'
  | 'jab-right'
  | 'alt-jab'
  | 'palm-left'
  | 'palm-right'
  | 'palm-static'
  | 'stream'
  | 'fan'
  | 'twin-cannon'
  | 'rising'
  | 'whip-left'
  | 'whip-right'
  | 'breath'
  | 'neg-talking'
  | 'neg-idle'
  | 'neg-reaching';

type XY = readonly [number, number];

type HandKind = 'fist' | 'palm' | 'grip' | 'relax';

interface ArmPose {
  /** Elbow position, unit space (y down). */
  e: XY;
  /** Wrist position, unit space. */
  w: XY;
  /** Toward-viewer extension 0..1 (grows the hand, adds speed lines). */
  z?: number;
  hand: HandKind;
}

interface FigurePose {
  /** Figure-left arm (the canvas-left side = the player's left hand). */
  l: ArmPose;
  r: ArmPose;
  /** Small whole-torso x lean, unit space. */
  lean?: number;
}

interface Keyframe {
  /** Time within the loop, ms. */
  t: number;
  p: FigurePose;
}

export interface StickAnim {
  durationMs: number;
  frames: Keyframe[];
}

// ---------------------------------------------------------------------------
// Skeleton constants (unit space)
// ---------------------------------------------------------------------------

const HEAD: XY = [0.5, 0.15];
const HEAD_R = 0.065;
const NECK: XY = [0.5, 0.235];
const SH_L: XY = [0.375, 0.3];
const SH_R: XY = [0.625, 0.3];
const HIP_L: XY = [0.44, 0.58];
const HIP_R: XY = [0.56, 0.58];
const KNEE_L: XY = [0.435, 0.77];
const KNEE_R: XY = [0.565, 0.77];
const FOOT_L: XY = [0.43, 0.94];
const FOOT_R: XY = [0.57, 0.94];

// ---------------------------------------------------------------------------
// Pose vocabulary (authored for the RIGHT side of the canvas, mirrored via
// mir() for left-hand variants). y grows down.
// ---------------------------------------------------------------------------

const mir = (p: XY): XY => [1 - p[0], p[1]];

const armMir = (a: ArmPose): ArmPose => ({
  e: mir(a.e),
  w: mir(a.w),
  ...(a.z !== undefined ? { z: a.z } : {}),
  hand: a.hand,
});

/** Mirror a whole pose left<->right. */
const poseMir = (p: FigurePose): FigurePose => ({
  l: armMir(p.r),
  r: armMir(p.l),
  ...(p.lean !== undefined ? { lean: -p.lean } : {}),
});

// Right-arm poses.
const GUARD_R: ArmPose = { e: [0.685, 0.43], w: [0.615, 0.335], hand: 'fist' };
const EXTEND_R: ArmPose = { e: [0.6, 0.36], w: [0.565, 0.325], z: 1, hand: 'fist' };
const RELAX_R: ArmPose = { e: [0.66, 0.44], w: [0.665, 0.565], hand: 'relax' };
const HIP_FIST_R: ArmPose = { e: [0.685, 0.45], w: [0.63, 0.555], hand: 'fist' };
const PALM_CHEST_R: ArmPose = { e: [0.685, 0.43], w: [0.615, 0.34], hand: 'palm' };
const PALM_EXTEND_R: ArmPose = { e: [0.6, 0.365], w: [0.565, 0.33], z: 1, hand: 'palm' };
const PALM_LOW_R: ArmPose = { e: [0.665, 0.47], w: [0.625, 0.59], hand: 'palm' };
const PALM_HIGH_R: ArmPose = { e: [0.655, 0.27], w: [0.625, 0.13], hand: 'palm' };
const WHIP_UP_R: ArmPose = { e: [0.69, 0.365], w: [0.665, 0.225], hand: 'grip' };
const WHIP_SWUNG_R: ArmPose = { e: [0.575, 0.375], w: [0.395, 0.3], hand: 'grip' };
const TWIN_CHEST_R: ArmPose = { e: [0.68, 0.44], w: [0.53, 0.415], hand: 'fist' };
const TWIN_OUT_R: ArmPose = { e: [0.6, 0.38], w: [0.535, 0.35], z: 1, hand: 'fist' };

// Left-arm poses (mirrors).
const GUARD_L = armMir(GUARD_R);
const RELAX_L = armMir(RELAX_R);
const HIP_FIST_L = armMir(HIP_FIST_R);
const PALM_LOW_L = armMir(PALM_LOW_R);
const PALM_HIGH_L = armMir(PALM_HIGH_R);
const TWIN_CHEST_L = armMir(TWIN_CHEST_R);
const TWIN_OUT_L = armMir(TWIN_OUT_R);

const pose = (l: ArmPose, r: ArmPose, lean?: number): FigurePose => ({
  l,
  r,
  ...(lean !== undefined ? { lean } : {}),
});

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

/** Right-hand jab: guard, snap out toward viewer, retract, stillness. */
const JAB_RIGHT: StickAnim = {
  durationMs: 2600,
  frames: [
    { t: 0, p: pose(GUARD_L, GUARD_R) },
    { t: 900, p: pose(GUARD_L, GUARD_R) },
    { t: 1040, p: pose(GUARD_L, EXTEND_R) },
    { t: 1140, p: pose(GUARD_L, EXTEND_R) },
    { t: 1330, p: pose(GUARD_L, GUARD_R) },
    { t: 2600, p: pose(GUARD_L, GUARD_R) },
  ],
};

/** Alternating combo: L, R, L in quick succession, then a still guard. */
const ALT_JAB: StickAnim = {
  durationMs: 3600,
  frames: [
    { t: 0, p: pose(GUARD_L, GUARD_R) },
    { t: 500, p: pose(GUARD_L, GUARD_R) },
    { t: 620, p: pose(armMir(EXTEND_R), GUARD_R) },
    { t: 800, p: pose(GUARD_L, GUARD_R) },
    { t: 950, p: pose(GUARD_L, EXTEND_R) },
    { t: 1130, p: pose(GUARD_L, GUARD_R) },
    { t: 1280, p: pose(armMir(EXTEND_R), GUARD_R) },
    { t: 1460, p: pose(GUARD_L, GUARD_R) },
    { t: 3600, p: pose(GUARD_L, GUARD_R) },
  ],
};

/** Right palm strike: chest, shove toward viewer, return, stillness. */
const PALM_RIGHT_ANIM: StickAnim = {
  durationMs: 2700,
  frames: [
    { t: 0, p: pose(RELAX_L, PALM_CHEST_R) },
    { t: 900, p: pose(RELAX_L, PALM_CHEST_R) },
    { t: 1070, p: pose(RELAX_L, PALM_EXTEND_R) },
    { t: 1200, p: pose(RELAX_L, PALM_EXTEND_R) },
    { t: 1420, p: pose(RELAX_L, PALM_CHEST_R) },
    { t: 2700, p: pose(RELAX_L, PALM_CHEST_R) },
  ],
};

/** Static palm: raise, long still hold, lower. */
const PALM_STATIC: StickAnim = {
  durationMs: 5200,
  frames: [
    { t: 0, p: pose(RELAX_L, RELAX_R) },
    { t: 400, p: pose(RELAX_L, RELAX_R) },
    { t: 900, p: pose(RELAX_L, { ...PALM_CHEST_R, z: 0.35 }) },
    { t: 4300, p: pose(RELAX_L, { ...PALM_CHEST_R, z: 0.35 }) },
    { t: 4800, p: pose(RELAX_L, RELAX_R) },
    { t: 5200, p: pose(RELAX_L, RELAX_R) },
  ],
};

/** Fire stream: jab out, HOLD extended ~2s, quick retract. */
const STREAM: StickAnim = {
  durationMs: 4400,
  frames: [
    { t: 0, p: pose(GUARD_L, GUARD_R) },
    { t: 700, p: pose(GUARD_L, GUARD_R) },
    { t: 850, p: pose(GUARD_L, EXTEND_R) },
    { t: 3200, p: pose(GUARD_L, { ...EXTEND_R, w: [0.57, 0.322] }) },
    { t: 3400, p: pose(GUARD_L, GUARD_R) },
    { t: 4400, p: pose(GUARD_L, GUARD_R) },
  ],
};

/** Flame fan: palm push out, HOLD, draw back. */
const FAN: StickAnim = {
  durationMs: 4400,
  frames: [
    { t: 0, p: pose(RELAX_L, PALM_CHEST_R) },
    { t: 700, p: pose(RELAX_L, PALM_CHEST_R) },
    { t: 870, p: pose(RELAX_L, PALM_EXTEND_R) },
    { t: 3200, p: pose(RELAX_L, { ...PALM_EXTEND_R, w: [0.57, 0.327] }) },
    { t: 3420, p: pose(RELAX_L, PALM_CHEST_R) },
    { t: 4400, p: pose(RELAX_L, PALM_CHEST_R) },
  ],
};

/** Twin cannon: fists together at chest, hold, both thrust, snap back. */
const TWIN: StickAnim = {
  durationMs: 3200,
  frames: [
    { t: 0, p: pose(TWIN_CHEST_L, TWIN_CHEST_R) },
    { t: 1100, p: pose(TWIN_CHEST_L, TWIN_CHEST_R) },
    { t: 1260, p: pose(TWIN_OUT_L, TWIN_OUT_R) },
    { t: 1400, p: pose(TWIN_OUT_L, TWIN_OUT_R) },
    { t: 1620, p: pose(TWIN_CHEST_L, TWIN_CHEST_R) },
    { t: 3200, p: pose(TWIN_CHEST_L, TWIN_CHEST_R) },
  ],
};

/** Rising flame: palms low, fast sweep straight up, float, lower slowly. */
const RISING: StickAnim = {
  durationMs: 4200,
  frames: [
    { t: 0, p: pose(PALM_LOW_L, PALM_LOW_R) },
    { t: 1100, p: pose(PALM_LOW_L, PALM_LOW_R) },
    { t: 1380, p: pose(PALM_HIGH_L, PALM_HIGH_R) },
    { t: 1900, p: pose(PALM_HIGH_L, PALM_HIGH_R) },
    { t: 3000, p: pose(PALM_LOW_L, PALM_LOW_R) },
    { t: 4200, p: pose(PALM_LOW_L, PALM_LOW_R) },
  ],
};

/** Right whip: raise grip, LONG still hold, lateral lash, return. */
const WHIP_RIGHT: StickAnim = {
  durationMs: 3600,
  frames: [
    { t: 0, p: pose(RELAX_L, RELAX_R) },
    { t: 450, p: pose(RELAX_L, WHIP_UP_R) },
    { t: 1750, p: pose(RELAX_L, WHIP_UP_R) },
    { t: 1950, p: pose(RELAX_L, WHIP_SWUNG_R) },
    { t: 2100, p: pose(RELAX_L, WHIP_SWUNG_R) },
    { t: 2500, p: pose(RELAX_L, WHIP_UP_R) },
    { t: 3200, p: pose(RELAX_L, WHIP_UP_R) },
    { t: 3600, p: pose(RELAX_L, RELAX_R) },
  ],
};

/** Breath charge: fists chamber at the hips, still deep-breath hold, relax. */
const BREATH: StickAnim = {
  durationMs: 4600,
  frames: [
    { t: 0, p: pose(RELAX_L, RELAX_R) },
    { t: 500, p: pose(HIP_FIST_L, HIP_FIST_R) },
    { t: 800, p: pose(HIP_FIST_L, HIP_FIST_R) },
    // The breath itself: a barely visible torso lift via lean 0 (kept
    // still on purpose; stillness IS the move).
    { t: 3100, p: pose(HIP_FIST_L, HIP_FIST_R) },
    { t: 3700, p: pose(RELAX_L, RELAX_R) },
    { t: 4600, p: pose(RELAX_L, RELAX_R) },
  ],
};

/** Talking hands: loose conversational gesturing, both arms mid height. */
const NEG_TALKING: StickAnim = {
  durationMs: 4800,
  frames: [
    { t: 0, p: pose({ e: [0.34, 0.44], w: [0.37, 0.47], hand: 'relax' }, { e: [0.66, 0.42], w: [0.6, 0.4], hand: 'relax' }) },
    { t: 800, p: pose({ e: [0.33, 0.42], w: [0.34, 0.37], hand: 'palm' }, { e: [0.67, 0.44], w: [0.63, 0.47], hand: 'relax' }, 0.008) },
    { t: 1600, p: pose({ e: [0.35, 0.45], w: [0.4, 0.42], hand: 'relax' }, { e: [0.66, 0.41], w: [0.6, 0.35], hand: 'palm' }, -0.006) },
    { t: 2400, p: pose({ e: [0.33, 0.43], w: [0.36, 0.4], hand: 'palm' }, { e: [0.67, 0.43], w: [0.62, 0.39], hand: 'palm' }) },
    { t: 3200, p: pose({ e: [0.34, 0.46], w: [0.38, 0.5], hand: 'relax' }, { e: [0.66, 0.4], w: [0.58, 0.37], hand: 'relax' }, 0.008) },
    { t: 4000, p: pose({ e: [0.34, 0.44], w: [0.36, 0.44], hand: 'relax' }, { e: [0.67, 0.45], w: [0.64, 0.49], hand: 'relax' }, -0.005) },
    { t: 4800, p: pose({ e: [0.34, 0.44], w: [0.37, 0.47], hand: 'relax' }, { e: [0.66, 0.42], w: [0.6, 0.4], hand: 'relax' }) },
  ],
};

/** Standing idle: arms hanging, small weight shifts. */
const NEG_IDLE: StickAnim = {
  durationMs: 5000,
  frames: [
    { t: 0, p: pose(RELAX_L, RELAX_R) },
    { t: 1200, p: pose(RELAX_L, RELAX_R, 0.012) },
    { t: 2500, p: pose({ ...RELAX_L, w: [0.335, 0.55] }, RELAX_R, -0.012) },
    { t: 3700, p: pose(RELAX_L, { ...RELAX_R, w: [0.67, 0.55] }, 0.008) },
    { t: 5000, p: pose(RELAX_L, RELAX_R) },
  ],
};

/** Reaching around: slow ordinary reaches, one of them toward the viewer. */
const NEG_REACHING: StickAnim = {
  durationMs: 5600,
  frames: [
    { t: 0, p: pose(RELAX_L, RELAX_R) },
    { t: 700, p: pose(RELAX_L, { e: [0.68, 0.46], w: [0.78, 0.58], hand: 'relax' }, 0.01) },
    { t: 1400, p: pose(RELAX_L, { e: [0.67, 0.44], w: [0.72, 0.5], hand: 'relax' }) },
    { t: 2100, p: pose(RELAX_L, RELAX_R) },
    { t: 3000, p: pose(RELAX_L, { e: [0.63, 0.42], w: [0.585, 0.4], z: 0.45, hand: 'relax' }) },
    { t: 3900, p: pose(RELAX_L, RELAX_R) },
    { t: 4700, p: pose({ e: [0.33, 0.46], w: [0.24, 0.56], hand: 'relax' }, RELAX_R, -0.01) },
    { t: 5600, p: pose(RELAX_L, RELAX_R) },
  ],
};

export const STICK_ANIMS: Readonly<Record<StickAnimName, StickAnim>> = {
  'jab-left': mirrorAnim(JAB_RIGHT),
  'jab-right': JAB_RIGHT,
  'alt-jab': ALT_JAB,
  'palm-left': mirrorAnim(PALM_RIGHT_ANIM),
  'palm-right': PALM_RIGHT_ANIM,
  'palm-static': PALM_STATIC,
  stream: STREAM,
  fan: FAN,
  'twin-cannon': TWIN,
  rising: RISING,
  'whip-left': mirrorAnim(WHIP_RIGHT),
  'whip-right': WHIP_RIGHT,
  breath: BREATH,
  'neg-talking': NEG_TALKING,
  'neg-idle': NEG_IDLE,
  'neg-reaching': NEG_REACHING,
};

function mirrorAnim(anim: StickAnim): StickAnim {
  return {
    durationMs: anim.durationMs,
    frames: anim.frames.map((f) => ({ t: f.t, p: poseMir(f.p) })),
  };
}

// ---------------------------------------------------------------------------
// Sampling (pure)
// ---------------------------------------------------------------------------

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (u: number): number => {
  const t = clamp01(u);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const lerpXY = (a: XY, b: XY, u: number): XY => [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];

function lerpArm(a: ArmPose, b: ArmPose, u: number): ArmPose {
  return {
    e: lerpXY(a.e, b.e, u),
    w: lerpXY(a.w, b.w, u),
    z: lerp(a.z ?? 0, b.z ?? 0, u),
    // The hand shape snaps at the midpoint of the transition.
    hand: u < 0.5 ? a.hand : b.hand,
  };
}

/** Sample an animation at loop time tMs. Pure; exported for tests. */
export function samplePose(anim: StickAnim, tMs: number): FigurePose {
  const frames = anim.frames;
  const first = frames[0];
  if (!first) return pose(RELAX_L, RELAX_R);
  const t = ((tMs % anim.durationMs) + anim.durationMs) % anim.durationMs;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (!a || !b) continue;
    if (t >= a.t && t <= b.t) {
      const u = b.t > a.t ? smooth((t - a.t) / (b.t - a.t)) : 1;
      return {
        l: lerpArm(a.p.l, b.p.l, u),
        r: lerpArm(a.p.r, b.p.r, u),
        lean: lerp(a.p.lean ?? 0, b.p.lean ?? 0, u),
      };
    }
  }
  return first.p;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const INK = '#241c15';
const EMBER = '#8a2f1d';

/**
 * Canvas renderer for one looping animation. The caller owns the rAF loop
 * cadence (the studio app drives it from its single loop); render(nowMs)
 * draws the loop frame for that wall time.
 */
export class StickFigureRenderer {
  private anim: StickAnim = STICK_ANIMS['jab-right'];
  private startMs = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setAnim(name: StickAnimName, nowMs: number): void {
    this.anim = STICK_ANIMS[name];
    this.startMs = nowMs;
  }

  render(nowMs: number): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const p = samplePose(this.anim, nowMs - this.startMs);
    const lean = (p.lean ?? 0) * w;

    ctx.clearRect(0, 0, w, h);
    const X = (v: number): number => v * w;
    const Y = (v: number): number => v * h;
    const XL = (v: number): number => v * w + lean; // upper body follows the lean

    ctx.lineWidth = Math.max(2.5, w * 0.02);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;

    // Legs and hips (no lean).
    ctx.beginPath();
    ctx.moveTo(X(HIP_L[0]), Y(HIP_L[1]));
    ctx.lineTo(X(HIP_R[0]), Y(HIP_R[1]));
    ctx.moveTo(X(HIP_L[0]), Y(HIP_L[1]));
    ctx.lineTo(X(KNEE_L[0]), Y(KNEE_L[1]));
    ctx.lineTo(X(FOOT_L[0]), Y(FOOT_L[1]));
    ctx.moveTo(X(HIP_R[0]), Y(HIP_R[1]));
    ctx.lineTo(X(KNEE_R[0]), Y(KNEE_R[1]));
    ctx.lineTo(X(FOOT_R[0]), Y(FOOT_R[1]));
    ctx.stroke();

    // Torso, shoulder line, neck.
    ctx.beginPath();
    ctx.moveTo(X(0.5), Y(HIP_L[1]));
    ctx.lineTo(XL(NECK[0]), Y(NECK[1]));
    ctx.moveTo(XL(SH_L[0]), Y(SH_L[1]));
    ctx.lineTo(XL(SH_R[0]), Y(SH_R[1]));
    ctx.stroke();

    // Head.
    ctx.beginPath();
    ctx.arc(XL(HEAD[0]), Y(HEAD[1]), HEAD_R * h, 0, Math.PI * 2);
    ctx.stroke();

    // Ground line.
    ctx.save();
    ctx.strokeStyle = 'rgba(36, 28, 21, 0.3)';
    ctx.lineWidth = Math.max(1.5, w * 0.008);
    ctx.beginPath();
    ctx.moveTo(X(0.18), Y(0.955));
    ctx.lineTo(X(0.82), Y(0.955));
    ctx.stroke();
    ctx.restore();

    this.drawArm(ctx, w, h, [XL(SH_L[0]), Y(SH_L[1])], p.l);
    this.drawArm(ctx, w, h, [XL(SH_R[0]), Y(SH_R[1])], p.r);
  }

  private drawArm(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    shoulderPx: XY,
    arm: ArmPose,
  ): void {
    const z = arm.z ?? 0;
    const ex = arm.e[0] * w;
    const ey = arm.e[1] * h;
    const wx = arm.w[0] * w;
    const wy = arm.w[1] * h;
    const hot = z > 0.55;

    ctx.strokeStyle = hot ? EMBER : INK;
    ctx.lineWidth = Math.max(2.5, w * 0.02);
    ctx.beginPath();
    ctx.moveTo(shoulderPx[0], shoulderPx[1]);
    ctx.lineTo(ex, ey);
    ctx.lineTo(wx, wy);
    ctx.stroke();

    // Hand marker: grows with z (toward the viewer).
    const base = w * 0.028;
    const r = base * (1 + z * 1.35);
    ctx.fillStyle = hot ? EMBER : INK;
    switch (arm.hand) {
      case 'fist':
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'palm': {
        // Open hand: a small arc of finger strokes fanning up from the wrist.
        ctx.lineWidth = Math.max(2, w * 0.013);
        ctx.beginPath();
        for (let i = -2; i <= 2; i++) {
          const a = -Math.PI / 2 + i * 0.28;
          ctx.moveTo(wx, wy);
          ctx.lineTo(wx + Math.cos(a) * r * 1.7, wy + Math.sin(a) * r * 1.7);
        }
        ctx.stroke();
        break;
      }
      case 'grip': {
        ctx.beginPath();
        ctx.arc(wx, wy, r * 0.9, 0, Math.PI * 2);
        ctx.fill();
        // Thumb tick pointing up out of the curled fingers.
        ctx.lineWidth = Math.max(2, w * 0.013);
        ctx.beginPath();
        ctx.moveTo(wx, wy - r * 0.6);
        ctx.lineTo(wx, wy - r * 1.9);
        ctx.stroke();
        break;
      }
      case 'relax':
        ctx.beginPath();
        ctx.arc(wx, wy, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        break;
    }

    // Toward-viewer speed lines.
    if (z > 0.45) {
      ctx.save();
      ctx.strokeStyle = `rgba(138, 47, 29, ${(0.75 * (z - 0.45)) / 0.55})`;
      ctx.lineWidth = Math.max(1.5, w * 0.009);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.35;
        const r0 = r * 1.5;
        const r1 = r * 2.15;
        ctx.moveTo(wx + Math.cos(a) * r0, wy + Math.sin(a) * r0);
        ctx.lineTo(wx + Math.cos(a) * r1, wy + Math.sin(a) * r1);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}
