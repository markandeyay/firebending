"""Extract HaGRID hand-landmark fixtures for the pose classifiers.

Data sources (annotations ONLY, never images, never inference):

1. cj-mills/hagrid-sample-500k-384p on HuggingFace. This is a single
   13.4 GB zip; we range-request just the per-class ann_train_val JSONs
   (~10 MB each). These carry the v1 HaGRID schema: bboxes, labels,
   leading_hand, user_id. They do NOT carry landmarks.
2. The official HaGRID v2 "annotations_with_landmarks" zip
   (rndml-team-cv OBS bucket, linked from github.com/hukenovs/hagrid,
   same CC-BY-SA-4.0 dataset). Its val-split per-class JSONs carry
   hand_landmarks: 21 [x, y] points per hand, normalized to the FULL
   image (verified: every wrist landmark falls inside its labeled bbox
   when interpreted as full-image coords).

We join the two by image id, keeping only images that exist in the
cj-mills sample, so landmarks come from the official annotations while
the subset is exactly the 500k-sample. leading_hand from the v1 schema
supplies handedness; the joined hand side is validated downstream in
analyze.ts against the palmScore facing sign on stop/palm.

Player-space conversion: x -> 1 - x (webcam mirror), y unchanged,
z = 0 (HaGRID landmarks are 2D).

Output: fixtures/hagrid/<class>.json, arrays of
{landmarks: [{x,y,z} * 21], confidence: 1, handedness: 'left'|'right'}.
Coordinates rounded to 4 decimals. FIXTURE_PER_CLASS committed per class.

Usage: python tools/hagrid/extract.py
Downloads are cached under CACHE_DIR; a full cold run fetches ~250 MB.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rangezip import RemoteZip

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "fixtures" / "hagrid"
CACHE_DIR = Path(
    os.environ.get(
        "HAGRID_CACHE", str(Path(tempfile.gettempdir()) / "hagrid_extract_cache")
    )
)

SAMPLE_ZIP_URL = (
    "https://huggingface.co/datasets/cj-mills/hagrid-sample-500k-384p/"
    "resolve/main/hagrid-sample-500k-384p.zip"
)
V2_ANN_ZIP_URL = (
    "https://rndml-team-cv.obs.ru-moscow-1.hc.sbercloud.ru/"
    "datasets/hagrid_v2/annotations_with_landmarks/annotations.zip"
)

# Classes we extract. Positives: fist; palm + stop; like (thumbs-up = whip
# grip shape). Negatives: no_gesture (harvested from second hands inside
# these images; the sample has no dedicated no_gesture images) plus
# distractors.
CLASSES = [
    "fist",
    "palm",
    "stop",
    "like",
    "ok",
    "one",
    "peace",
    "four",
    "rock",
    "call",
    "dislike",
    "stop_inverted",
    "mute",
]

ANALYSIS_PER_CLASS = 400  # written to <cache>/analysis for threshold sweeps
FIXTURE_PER_CLASS = 300  # committed under fixtures/hagrid
LANDMARKS_PER_HAND = 21


def cached_member(rz_factory, cache_name: str, member: str, stats: dict) -> bytes:
    path = CACHE_DIR / cache_name
    if path.exists():
        return path.read_bytes()
    rz = rz_factory()
    before = rz.bytes_downloaded
    data = rz.read(member)
    stats["downloaded"] += rz.bytes_downloaded - before
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def other_side(side: str) -> str:
    return "left" if side == "right" else "right"


def to_player_space(points: list[list[float]]) -> list[dict]:
    return [
        {"x": round(1.0 - p[0], 4), "y": round(p[1], 4), "z": 0}
        for p in points
    ]


def main() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    stats = {"downloaded": 0}

    # Lazily opened remote zips (opening costs a central-directory fetch:
    # ~87 MB for the 509k-member sample zip, ~80 KB for the annotations zip).
    zips: dict[str, RemoteZip] = {}

    def open_zip(key: str, url: str) -> RemoteZip:
        if key not in zips:
            rz = RemoteZip(url)
            stats["downloaded"] += rz.bytes_downloaded
            zips[key] = rz
        return zips[key]

    # Image ids actually present in the sample zip, keyed by class. Cached
    # because listing the 509k-member central directory costs ~87 MB.
    ids_path = CACHE_DIR / "sample_image_ids.json"
    if ids_path.exists():
        sample_ids = {c: set(v) for c, v in json.loads(ids_path.read_text()).items()}
    else:
        rz = open_zip("sample", SAMPLE_ZIP_URL)
        sample_ids = {c: set() for c in CLASSES}
        prefix = "hagrid-sample-500k-384p/hagrid_500k/train_val_"
        for name in rz.namelist():
            if not name.startswith(prefix) or not name.endswith(".jpg"):
                continue
            rest = name[len(prefix):]
            cls, _, fname = rest.partition("/")
            if cls in sample_ids:
                sample_ids[cls].add(fname[:-4])
        ids_path.write_text(
            json.dumps({c: sorted(v) for c, v in sample_ids.items()})
        )

    per_class_hands: dict[str, list[dict]] = {c: [] for c in CLASSES}
    per_class_hands["no_gesture"] = []
    join_report: list[str] = []

    for cls in CLASSES:
        v1 = json.loads(
            cached_member(
                lambda: open_zip("sample", SAMPLE_ZIP_URL),
                f"sample_ann/{cls}.json",
                f"hagrid-sample-500k-384p/ann_train_val/{cls}.json",
                stats,
            )
        )
        v2 = json.loads(
            cached_member(
                lambda: open_zip("v2", V2_ANN_ZIP_URL),
                f"v2_val/{cls}.json",
                f"annotations/val/{cls}.json",
                stats,
            )
        )

        joined = 0
        in_sample = set(v1) & sample_ids[cls]
        for img_id in sorted(in_sample & set(v2)):
            entry = v2[img_id]
            leading = v1[img_id].get("leading_hand")
            if leading not in ("right", "left"):
                continue
            labels = entry.get("labels") or []
            hands = entry.get("hand_landmarks") or []
            if len(labels) != len(hands):
                continue
            valid = [
                (lab, hand)
                for lab, hand in zip(labels, hands)
                if len(hand) == LANDMARKS_PER_HAND
            ]
            gesture_hands = [(lab, h) for lab, h in valid if lab == cls]
            other_hands = [(lab, h) for lab, h in valid if lab != cls]
            # Only unambiguous side attribution: exactly one gesture hand
            # (it is the leading hand); any other hand is the opposite side.
            if len(gesture_hands) != 1:
                continue
            joined += 1
            _, ghand = gesture_hands[0]
            per_class_hands[cls].append(
                {
                    "landmarks": to_player_space(ghand),
                    "confidence": 1,
                    "handedness": leading,
                    "image_id": img_id,
                }
            )
            for lab, hand in other_hands:
                if lab == "no_gesture":
                    per_class_hands["no_gesture"].append(
                        {
                            "landmarks": to_player_space(hand),
                            "confidence": 1,
                            "handedness": other_side(leading),
                            "image_id": img_id,
                        }
                    )
        join_report.append(
            f"{cls}: v1-ann={len(v1)} in-sample-zip={len(in_sample)} "
            f"v2-val={len(v2)} joined-unambiguous={joined}"
        )

    # no_gesture came from many classes in image-id order per class; sort
    # for determinism and cap like everything else.
    per_class_hands["no_gesture"].sort(key=lambda h: h["image_id"])

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    analysis_dir = CACHE_DIR / "analysis"
    analysis_dir.mkdir(parents=True, exist_ok=True)
    total_fixture_bytes = 0
    for cls, hands in per_class_hands.items():
        for h in hands:
            h.pop("image_id", None)
        analysis = hands[:ANALYSIS_PER_CLASS]
        fixtures = hands[:FIXTURE_PER_CLASS]
        (analysis_dir / f"{cls}.json").write_text(
            json.dumps(analysis, separators=(",", ":")), encoding="utf-8"
        )
        out = FIXTURE_DIR / f"{cls}.json"
        out.write_text(json.dumps(fixtures, separators=(",", ":")), encoding="utf-8")
        total_fixture_bytes += out.stat().st_size
        print(
            f"{cls}: {len(hands)} joined hands -> {len(analysis)} analysis, "
            f"{len(fixtures)} committed"
        )

    print()
    for line in join_report:
        print(" ", line)
    print()
    print(f"downloaded this run: {stats['downloaded'] / 1e6:.1f} MB")
    print(f"committed fixtures: {total_fixture_bytes / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
