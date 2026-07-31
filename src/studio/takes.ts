/**
 * The 16 studio drill takes: identity, instruction-card copy (written for a
 * first-timer: stance, hand action, speed, end position, what to avoid),
 * rep counts, primary review signal, and the stick-figure animation each
 * card loops. Pure data + one pure primary-signal evaluator.
 *
 * COPY RULES: plain language, second person, short sentences, no em dashes.
 * Every rep-counted take reminds the player to hold 1-2 seconds of
 * stillness between reps so the peak detector sees clean valleys.
 */

import type { MotionThresholds } from '../gestures/profile';
import type { StudioFrameSignals } from './exportSchema';
import type { TakeId } from './exportSchema';
import { TAKE_IDS } from './exportSchema';
import type { StickAnimName } from './stickfigure';

export type { TakeId };
export { TAKE_IDS };

/** Which per-frame signal the review timeline plots for a take. */
export type PrimarySignalKind =
  | 'elbow-vel' // max elbow EXTENSION velocity of the relevant side(s)
  | 'palm-score'
  | 'abs-vx'
  | 'neg-vy'
  | 'wrist-speed';

export type SignalSide = 'left' | 'right' | 'both';

export interface PrimarySignalSpec {
  kind: PrimarySignalKind;
  side: SignalSide;
  /** Which MotionThresholds field draws the threshold line (null = none). */
  thresholdKey: keyof MotionThresholds | null;
  /** Axis label for the signal track. */
  label: string;
}

export interface TakeDef {
  id: TakeId;
  /** Display name of the move or drill. */
  name: string;
  /** Rep target (0 for continuous/negative takes). */
  reps: number;
  /** Short duration/format line under the name, e.g. "5 reps" or "30 seconds". */
  format: string;
  /** Plain-language how-to for a first-timer. */
  howTo: string;
  /** Rep pacing line (stillness between reps) or hold guidance. */
  pacing: string;
  /** One line of common mistakes. */
  mistakes: string;
  /** Stick-figure animation the card loops. */
  anim: StickAnimName;
  primary: PrimarySignalSpec;
  /** True for the negative (non-move) recordings. */
  negative: boolean;
}

const def = (d: TakeDef): TakeDef => d;

export const TAKES: readonly TakeDef[] = [
  def({
    id: 'jab-left-x5',
    name: 'Jab, left hand',
    reps: 5,
    format: '5 reps',
    howTo:
      'Stand square to the camera, feet under your shoulders. Make fists and hold them at chest height, elbows bent, like a boxing guard. Snap your LEFT fist straight toward the camera and pull it back in one motion. Fast out, fast back. Finish with the fist back at your guard. Stop just short of locking your elbow.',
    pacing: 'Do 5 jabs. Freeze at your guard for 1 to 2 seconds between each one.',
    mistakes:
      'Do not punch across your body, and do not drop the fist to your waist between reps. Keep the punch aimed at the camera, not the ceiling.',
    anim: 'jab-left',
    primary: {
      kind: 'elbow-vel',
      side: 'left',
      thresholdKey: 'elbowExtendVel',
      label: 'elbow extension rad/s',
    },
    negative: false,
  }),
  def({
    id: 'jab-right-x5',
    name: 'Jab, right hand',
    reps: 5,
    format: '5 reps',
    howTo:
      'Same stance as the left jab: square to the camera, both fists at chest height in a guard. Snap your RIGHT fist straight toward the camera and pull it straight back in one motion. Full speed on the way out, no pause at full extension. End back at your guard, elbow never fully locked.',
    pacing: 'Do 5 jabs. Freeze at your guard for 1 to 2 seconds between each one.',
    mistakes:
      'Do not swing the arm in an arc or lean your whole body forward. The fist travels a straight line toward the lens.',
    anim: 'jab-right',
    primary: {
      kind: 'elbow-vel',
      side: 'right',
      thresholdKey: 'elbowExtendVel',
      label: 'elbow extension rad/s',
    },
    negative: false,
  }),
  def({
    id: 'alt-jab-combo-x3',
    name: 'Alternating jab combo',
    reps: 3,
    format: '3 combos of 3',
    howTo:
      'Guard up, both fists at chest height. Throw three quick straight punches alternating hands: left, right, left. Each punch snaps toward the camera and returns fully to the guard before the next one starts. The three punches together should take about 1.5 seconds.',
    pacing:
      'Do 3 combos. Stand completely still at your guard for a full 2 seconds between combos.',
    mistakes:
      'Do not blur the punches into one motion. Each fist must come all the way back before the other fires, or the game reads it as noise.',
    anim: 'alt-jab',
    primary: {
      kind: 'elbow-vel',
      side: 'both',
      thresholdKey: 'elbowExtendVel',
      label: 'elbow extension rad/s',
    },
    negative: false,
  }),
  def({
    id: 'palm-strike-left-x5',
    name: 'Palm strike, left hand',
    reps: 5,
    format: '5 reps',
    howTo:
      'Stand square. Open your LEFT hand flat, fingers together, palm facing the camera, held beside your chest. Push the palm straight at the camera like you are shoving a door, then draw it straight back. Keep the fingers extended and together the whole time, palm always facing the lens. Finish beside your chest.',
    pacing: 'Do 5 strikes. Hold the hand still at your chest for 1 to 2 seconds between reps.',
    mistakes:
      'Do not let the fingers spread or curl, and do not turn the palm sideways. A tilted palm stops reading as a palm.',
    anim: 'palm-left',
    primary: {
      kind: 'palm-score',
      side: 'left',
      thresholdKey: null,
      label: 'palm score',
    },
    negative: false,
  }),
  def({
    id: 'palm-strike-right-x5',
    name: 'Palm strike, right hand',
    reps: 5,
    format: '5 reps',
    howTo:
      'Same as the left side. Open your RIGHT hand flat, fingers together, palm to the camera, beside your chest. Shove it straight toward the lens and pull it straight back. Palm faces the camera from start to finish. End beside your chest.',
    pacing: 'Do 5 strikes. Hold the hand still at your chest for 1 to 2 seconds between reps.',
    mistakes:
      'Do not push downward or across your body. The push travels straight at the camera at chest height.',
    anim: 'palm-right',
    primary: {
      kind: 'palm-score',
      side: 'right',
      thresholdKey: null,
      label: 'palm score',
    },
    negative: false,
  }),
  def({
    id: 'palm-static-5s',
    name: 'Static palm hold',
    reps: 1,
    format: 'one 5s hold',
    howTo:
      'Raise your RIGHT hand to chest height, arm half extended. Open the hand flat, fingers together and pointing up, palm facing the camera. Hold it there, completely still, for a slow count of five. Breathe normally. Then lower the hand.',
    pacing: 'One rep: five full seconds of stillness. Longer is better than shorter.',
    mistakes:
      'Do not let the hand drift or the fingers relax apart. Tiny trembling is fine; drifting is not.',
    anim: 'palm-static',
    primary: {
      kind: 'palm-score',
      side: 'both',
      thresholdKey: null,
      label: 'palm score',
    },
    negative: false,
  }),
  def({
    id: 'fire-stream-4s-x2',
    name: 'Fire stream (held jab)',
    reps: 2,
    format: '2 holds of 4s',
    howTo:
      'Guard up with fists. Snap your RIGHT fist toward the camera like a jab, but instead of pulling it back, HOLD it out there, arm nearly straight, fist clenched, for a slow count of four. Keep the fist steady and pointed at the lens. Then pull it back to your guard in one quick motion.',
    pacing:
      'Do 2 holds. Rest at your guard, still, for 2 seconds between them.',
    mistakes:
      'Do not let the held arm sag or wander sideways. The pull-back at the end should be quick and clean, not a slow drift.',
    anim: 'stream',
    primary: {
      kind: 'elbow-vel',
      side: 'both',
      thresholdKey: 'elbowExtendVel',
      label: 'elbow extension rad/s',
    },
    negative: false,
  }),
  def({
    id: 'flame-fan-4s-x2',
    name: 'Flame fan (held palm)',
    reps: 2,
    format: '2 holds of 4s',
    howTo:
      'Open your RIGHT hand flat, palm to the camera, beside your chest. Push it straight at the lens like a palm strike, then HOLD it out there, fingers together, palm square to the camera, for a slow count of four. Then draw it back to your chest in one motion.',
    pacing: 'Do 2 holds. Rest with the hand at your chest, still, for 2 seconds between them.',
    mistakes:
      'Do not let the palm rotate away from the camera during the hold. Keep the fingers extended; a slowly curling hand ends the move early.',
    anim: 'fan',
    primary: {
      kind: 'palm-score',
      side: 'both',
      thresholdKey: null,
      label: 'palm score',
    },
    negative: false,
  }),
  def({
    id: 'twin-cannon-x3',
    name: 'Twin cannon',
    reps: 3,
    format: '3 reps',
    howTo:
      'Make two fists and press them together, knuckles touching, at the center of your chest. Hold them there, still, for a slow one-count. Then drive BOTH fists straight at the camera at the same time and snap them back together at your chest. The two fists travel side by side the whole way.',
    pacing:
      'Do 3 reps. Between reps keep the fists together at your chest, still, for 1 to 2 seconds.',
    mistakes:
      'Do not fire the hands one after the other and do not let them drift apart before the thrust. Together at the chest, together at full extension.',
    anim: 'twin-cannon',
    primary: {
      kind: 'elbow-vel',
      side: 'both',
      thresholdKey: 'elbowExtendVel',
      label: 'elbow extension rad/s',
    },
    negative: false,
  }),
  def({
    id: 'rising-flame-x3',
    name: 'Rising flame',
    reps: 3,
    format: '3 reps',
    howTo:
      'Open both hands flat, palms facing the camera, and lower them to hip height at your sides. Pause there for a one-count. Then sweep BOTH palms straight up in front of you, fast, finishing above your shoulders. Let them float there a beat, then lower them slowly back to your hips.',
    pacing:
      'Do 3 reps. Hold the low position, still, for 1 to 2 seconds before each sweep.',
    mistakes:
      'Do not curl the hands into fists during the sweep, and do not sweep outward like wings. Straight up, palms open, both hands together in time.',
    anim: 'rising',
    primary: {
      kind: 'neg-vy',
      side: 'both',
      thresholdKey: 'risingUpVel',
      label: 'upward speed u/s',
    },
    negative: false,
  }),
  def({
    id: 'fire-whip-left-x3',
    name: 'Fire whip, left hand',
    reps: 3,
    format: '3 reps',
    howTo:
      'Raise your LEFT hand to shoulder height and make a grip: fingers curled like holding a rope handle, thumb wrapped up along the side, knuckles toward the camera. Hold the grip perfectly still for a half second. Then lash the hand sideways across your body, fast, like cracking a whip, and let it swing back to shoulder height.',
    pacing:
      'Do 3 lashes. Re-set the raised grip and hold it still for a full 1 to 2 seconds before each one.',
    mistakes:
      'The still hold before the lash matters as much as the lash. Do not skip it, and do not turn the lash into a downward chop; it travels sideways.',
    anim: 'whip-left',
    primary: {
      kind: 'abs-vx',
      side: 'left',
      thresholdKey: 'whipSwingVx',
      label: 'lateral speed u/s',
    },
    negative: false,
  }),
  def({
    id: 'fire-whip-right-x3',
    name: 'Fire whip, right hand',
    reps: 3,
    format: '3 reps',
    howTo:
      'Raise your RIGHT hand to shoulder height in the rope grip: fingers curled, thumb wrapped up along the side. Freeze it there for a half second. Then lash the hand sideways across your body, fast, and let it return to shoulder height.',
    pacing:
      'Do 3 lashes. Hold the raised grip still for 1 to 2 seconds before each one.',
    mistakes:
      'Do not open the hand during the lash and do not start the swing before the hand has been still. Still first, then fast.',
    anim: 'whip-right',
    primary: {
      kind: 'abs-vx',
      side: 'right',
      thresholdKey: 'whipSwingVx',
      label: 'lateral speed u/s',
    },
    negative: false,
  }),
  def({
    id: 'breath-charge-x3',
    name: 'Breath charge',
    reps: 3,
    format: '3 reps',
    howTo:
      'Stand tall. Make two fists and park them at your hips, one on each side, like a martial-arts chamber. Hold them there, completely still, while you take one slow deep breath, about two seconds. Then relax the hands and let them hang for a moment. That whole cycle is one rep.',
    pacing:
      'Do 3 cycles. The still hold at the hips IS the move; give each hold a full 2 seconds.',
    mistakes:
      'Do not hover the fists in front of your stomach. They sit at your hips, low and wide, and they do not move at all during the hold.',
    anim: 'breath',
    primary: {
      kind: 'wrist-speed',
      side: 'both',
      thresholdKey: 'breathStaticMax',
      label: 'wrist speed u/s',
    },
    negative: false,
  }),
  def({
    id: 'neg-talking-30s',
    name: 'Negative: talking hands',
    reps: 0,
    format: '30s continuous',
    howTo:
      'Pretend you are on a video call explaining your weekend. Talk out loud and let your hands gesture naturally the whole time: point, wave, shrug, count on your fingers, whatever feels normal. Stay in frame and keep it going for the full 30 seconds.',
    pacing: 'No reps. Just keep talking and gesturing until the recording stops.',
    mistakes:
      'Do not perform any of the drill moves, even by accident. If you feel a gesture turning into a punch or a palm push, soften it.',
    anim: 'neg-talking',
    primary: {
      kind: 'wrist-speed',
      side: 'both',
      thresholdKey: 'spikeSpeed',
      label: 'wrist speed u/s',
    },
    negative: true,
  }),
  def({
    id: 'neg-idle-20s',
    name: 'Negative: standing idle',
    reps: 0,
    format: '20s continuous',
    howTo:
      'Just stand there. Arms relaxed at your sides or loosely clasped in front of you. Shift your weight, look around, scratch your nose if you need to. Be a person waiting for a bus for 20 seconds.',
    pacing: 'No reps. Stay relaxed and in frame until the recording stops.',
    mistakes:
      'Do not freeze like a statue; natural small movement is exactly what this take is for. Just avoid anything fast or deliberate.',
    anim: 'neg-idle',
    primary: {
      kind: 'wrist-speed',
      side: 'both',
      thresholdKey: 'spikeSpeed',
      label: 'wrist speed u/s',
    },
    negative: true,
  }),
  def({
    id: 'neg-reaching-20s',
    name: 'Negative: reaching around',
    reps: 0,
    format: '20s continuous',
    howTo:
      'Act out desk life: reach for a mug, pick it up, sip, put it down, reach toward the keyboard, adjust something beside you, push hair out of your face. Slow, ordinary reaches in different directions, some toward the camera, for 20 seconds.',
    pacing: 'No reps. Keep making casual reaches until the recording stops.',
    mistakes:
      'Reaches should be ordinary speed, not snappy. A fast reach straight at the lens is a jab, and this take must NOT contain jabs.',
    anim: 'neg-reaching',
    primary: {
      kind: 'wrist-speed',
      side: 'both',
      thresholdKey: 'spikeSpeed',
      label: 'wrist speed u/s',
    },
    negative: true,
  }),
];

/** Lookup by id (all 16 present by construction). */
export function takeDef(id: TakeId): TakeDef {
  const d = TAKES.find((t) => t.id === id);
  if (!d) throw new Error(`unknown take id ${id}`);
  return d;
}

/**
 * Evaluate a take's primary review signal on one frame's signals. Pure:
 * drives the live rep counter, the signal-track waveform and peak detection
 * from the same math.
 */
export function primarySignalValue(
  sig: StudioFrameSignals,
  spec: PrimarySignalSpec,
): number {
  const sides =
    spec.side === 'both' ? ([sig.left, sig.right] as const) : ([sideOf(sig, spec.side)] as const);
  let best = 0;
  for (const s of sides) {
    let v = 0;
    switch (spec.kind) {
      case 'elbow-vel':
        v = Math.max(0, s.elbowVel);
        break;
      case 'palm-score':
        v = s.palm;
        break;
      case 'abs-vx':
        v = Math.abs(s.velX);
        break;
      case 'neg-vy':
        v = Math.max(0, -s.velY);
        break;
      case 'wrist-speed':
        v = s.wristSpeed;
        break;
    }
    if (v > best) best = v;
  }
  return best;
}

function sideOf(sig: StudioFrameSignals, side: 'left' | 'right') {
  return side === 'left' ? sig.left : sig.right;
}
