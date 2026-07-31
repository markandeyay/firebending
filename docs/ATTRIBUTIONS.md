# Audio attributions

## What ships today

Every sound in the game, music included, is synthesized at runtime from plain
Web Audio oscillators and seeded noise buffers (`src/audio/engine.ts`,
`src/audio/score.ts`). There are no audio files in the repository and no
third-party audio is bundled, so the shipped build has nothing to attribute:
it is license-clean by construction.

The adaptive score is: a low drone bed that swells with combat intensity, a
synthesized taiko hit on kills and Twin Cannon impacts, a breathy
shakuhachi-style phrase (filtered noise blended with a bent sine) on camera
travels, and a single struck bell with inharmonic partials for the title.
All of it is original synthesis; none of it samples or imitates any
recording.

## Optional ambient layer: HUMAN-fetchable candidates (not bundled)

An optional looped ambient track could sit under the procedural score. The
candidates below were researched but deliberately NOT downloaded or bundled,
because the license text could not be verified on the hosting page itself by
automated fetch (incompetech renders track pages with JavaScript), and the
project rule is: bundle only when the license is unambiguously CC0 or CC-BY
as stated on the actual page. A human should verify the license on the
linked page before adding any file, then record title, artist, license, and
source URL here.

Candidates (East Asian instrumental, believed CC-BY 4.0, verify on page):

- "Ishikari Lore" by Kevin MacLeod, incompetech.
  Koto and shakuhachi folk piece. Search it at
  https://incompetech.com/music/royalty-free/music.html and confirm the
  Creative Commons By Attribution license shown for the track.
- "Eastern Thought" by Kevin MacLeod, incompetech.
  Slow East Asian instrumental. Same verification page as above.
- Free Music Archive search pools (license filter set to CC0 or CC-BY):
  https://freemusicarchive.org/search?quicksearch=koto and
  https://freemusicarchive.org/search?quicksearch=taiko
  FMA states each track's exact CC license on its track page.

Required attribution if a MacLeod track is added (per incompetech's license
page, https://incompetech.com/music/royalty-free/licenses/):
credit in the form "TRACK TITLE by Kevin MacLeod (incompetech.com), licensed
under Creative Commons: By Attribution", in both this file and the README.

Ruled out:

- Pixabay music: distributed under the Pixabay Content License, which is not
  CC0 or CC-BY, so it does not meet this project's license bar.
- Any music associated with existing fantasy properties. This project uses
  only original synthesis and generic traditional-instrument sources.

## Other data attributions

Pose score thresholds were tuned against landmark annotations from the
HaGRID dataset sample `cj-mills/hagrid-sample-500k-384p` (CC-BY-SA-4.0);
see `docs/hagrid-report.md`. No audio relation, listed here for
completeness.
