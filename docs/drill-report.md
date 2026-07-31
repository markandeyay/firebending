# Drill analysis report

- Source: `C:\Users\yalam\firebending\fixtures\recorded\firebending-drill-2026-07-31.json`
- Exported at: 2026-07-31T06:28:25.050Z
- Motion profile: DEFAULT_PROFILE (no calibration in export)

## Takes: reps confirmed vs fired

| take | status | starred | pose | reps confirmed | fired in-rep | misses | false positives |
| --- | --- | --- | --- | --- | --- | --- | --- |
| alt-jab-combo-x3#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| breath-charge-x3#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| fire-stream-4s-x2#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| fire-whip-left-x3#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| fire-whip-right-x3#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| flame-fan-4s-x2#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| jab-left-x5#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| jab-right-x5#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| palm-static-5s#1 | recorded | yes | yes | - | - | - | 0 |
| rising-flame-x3#1 | confirmed | yes | yes | 0 | 0 | 0 | - |
| twin-cannon-x3#1 | confirmed | yes | yes | 0 | 0 | 0 | - |

## Static palm hold: palmScore (3D) vs palmScore2D (live scorer)

palmScore2D is the LIVE scorer since the HaGRID investigation (see
docs/hagrid-report.md appendix): equal recall, better precision on
HaGRID, and no dependence on MediaPipe z. This section is the final,
player-data verdict: if the 2D column does not hold clearly more
frames above the 0.75 enter level on the static-palm take, the switch
must be re-reviewed.

| take | scorer | hands scored | p5 | median | p95 | frames > 0.75 | frames > 0.55 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| palm-static-5s#1 | palmScore (3D) | 83 | 1.000 | 1.000 | 1.000 | 83 | 83 |
| palm-static-5s#1 | palmScore2D (live) | 83 | 1.000 | 1.000 | 1.000 | 83 | 83 |

## Threshold proposals (max-margin separators)

No proposals: no confirmed reps with usable signals were found.

**PROPOSALS ARE NOT APPLIED AUTOMATICALLY.** Review the tables above
against the recording, then change the constants in
`src/gestures/profile.ts` / `src/gestures/moves.ts` by hand (the
orchestrator applies them once the user's recorded data supports them).

