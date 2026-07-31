# Round 5 Phase 1 visual review: RATES block + studio capture gate

Reviewed 2026-07-31 against firebending.md Section 9 (ink/parchment/firelight palette,
no neon, brush aesthetic, weighty motion) and Section 2 rule 2. Evidence:

- `r5p1-hud-rates.png` - arena on `?screen=arena&replay=twin-cannon`, D HUD open (replay path, RATES hidden)
- `r5p1-hud-rates-live.png` - arena on `?debug=rates` with fake camera, D HUD open (RATES visible, zero-sample state)
- `r5p1-studio-gate.png` / `r5p1-studio-full.png` - studio at 0.4-0.5 fps under headless software GL, chip in low state, gate banner up

Colors below were sampled from the rendered pages (computed styles plus pixel reads
from the screenshots), not from the source.

## Surface 1: D-key debug HUD RATES block

**Verdict: FIX.** One real defect (line clipping) and one empty-state color gap.
Palette, copy, and empty-state degradation are otherwise clean.

Issues, ordered by severity:

1. **HIGH - fusion lines overflow and clip the verdict.** The panel is
   `maxWidth: 360px`; a fusion line ("L elbow 0.00/3.60 FAIL speed 0.01/0.90 FAIL
   bbox 0.23/1.35 FAIL") is ~66 chars of 11px Consolas, ~400px. In the capture the
   line reads "bbox 0.23/1.35 FAI" and the PASS/FAIL token, the entire point of the
   line, is cut. At 1280 wide the viewport clips it; on a wider window the text will
   overflow past the panel border onto the raw scene with no charcoal backing.
   Fix: raise `maxWidth` to ~420px in src/ui/debugHud.ts, or compress the tokens
   (drop the word FAIL per signal, keep one verdict per line). Not a RATES line
   itself, but the RATES change widened this panel's job and the clip is visible the
   moment the HUD opens.
2. **MEDIUM - zero-sample handHz never gets the degraded color.** The bad-color rule
   is `count > 0 && p50 < 28`, so on the live path with a stalled hand tracker the
   block shows `hand -Hz` in the normal amber (confirmed: span color rgb(201,119,46)
   with count 0). Zero samples on a live source is the most degraded state there is;
   it should read at least as alarming as 27 Hz. Fix: treat `count === 0` as bad in
   `updateRates` when a live probe exists.
3. **LOW - RATES sits below the variable-length near-miss log.** The ratesEl is
   appended after the engine text, and near misses are the last lines of that text,
   so the whole RATES block jumps vertically at 10 Hz as misses appear and expire.
   The fixed-size RATES block should render above the log; variable-length content
   belongs last. As shipped the two do not visually collide, but the ordering makes
   the log push the rates around rather than the reverse.
4. **LOW - replay empty state is graceful but silent.** With a replay source
   `composeRates()` returns null and the section vanishes entirely (confirmed: rates
   child empty, no garbage, no "0.0/0.0" noise). That is the right degrade, but a
   single `rates  - (no live probe)` line would tell a developer the block exists and
   why it is empty. Optional.

What passes:

- **Palette: PASS.** Panel bg rgba(26,21,18,0.85) is exactly the spec charcoal
  family (sampled rgb(25,18,15) over the scene). Text #c9772e and border
  rgba(201,119,46,0.4) are warm amber. The degraded color #d0532f is vermilion
  family, warm, nothing synthwave, no pure alert red anywhere.
- **Empty percentiles render as "-"** ("hand -Hz", "photon>emit -ms"), never NaN or
  0.0/0.0 garbage. Good.
- **Copy tone: PASS.** Terse lowercase section labels consistent with the rest of
  the HUD ("state", "cooldowns", "thresholds", "rates (p50/p95)"), no em dashes, no
  exclamation marks. "workers hand:OFF" caps for the alarming token only.
- **Typography.** Consolas 11px diverges from the game HUD's serif ink styling, but
  this is a diagnostic overlay reading dense columns of numbers; monospace is the
  correct call and it is consistent within the whole debug panel. 11px is small but
  legible over the 85% charcoal backing.

## Surface 2: studio capture-rate chip + low-fps gate banner

**Verdict: SHIP.** Palette, typography, layout, and behavior are all inside the
spec. Two copy nits, neither blocking.

Issues, ordered by severity:

1. **LOW - banner head starts a sentence with a bare numeral.** "Capture is running
   at 0.4 fps. 30 is required for usable data." The second sentence opening with
   "30" reads slightly like a log line. Suggest "Takes need 30 fps to be usable."
   Same meaning, same terseness.
2. **LOW - chip/banner near-collision at narrow stage widths.** Banner is centered
   with `max-width: min(560px, 86%)` at top 52px; the chip is at top 44px right
   14px. At the measured 785px stage the banner rendered 390px wide and cleared the
   chip by ~50px, but a wider head line (a two-digit fps plus long copy) at a
   narrower stage can bring the banner's top corner under the chip. Worth a glance
   after any copy change; no fix needed today.

What passes:

- **Palette: PASS.** Banner is parchment #d8c8a8 (sampled rgb(211,193,162)) with the
  head in oxblood #6b1f15 and a vermilion rgba(138,47,29,0.85) border: exactly the
  Section 9 danger language, roughly 7.7:1 contrast for the head text. Chip good
  state is muted gold #a8853c on near-black; low state swaps to warm salmon #e0a08a
  on rgba(43,15,9,0.82) with the vermilion border, still ~5:1 over the bright fake
  video. No neon, no #ff0000, no cool hue anywhere in the chrome. (All green in the
  captures is Chrome's fake-camera test pattern, i.e. video content, not UI.)
- **Typography: PASS.** Banner head uses the display serif stack, body Georgia
  serif, chip matches the mode-chip letterspaced small-caps styling. Consistent with
  the rest of the studio chrome.
- **Layout: PASS.** Chip stacks cleanly under the LIVE chip; banner floats top
  center with pointer-events none and never blocks the record seal or timeline.
- **Behavior under the gate.** The banner shows only in idle/recording, updates its
  measured fps live, recording stays possible, and the take board carries the LOW
  FPS badge downstream. The empty chip state before camera-ready is "capture --
  fps" (double hyphen, not an em dash), degrading gracefully.
- **Copy tone: PASS.** No em dashes, no exclamation marks, the fix line gives three
  concrete remedies in one sentence.
