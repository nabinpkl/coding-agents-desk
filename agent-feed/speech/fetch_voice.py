# Puts the speech process's voice on this Mac: Phonon 31M English and the everyday English voices
# from Gradium's catalog, each pinned to a commit, into the folder `speech_server.py --models` reads
# (`node tools/runtime-paths.mjs speech-models`). `just speech-voice` runs it.
#
# Fetched once, here, rather than by the runtime on first use: the speech process then never reaches
# the network while it speaks, and a voice picked on the phone is already on disk. The catalog's
# character voices and other languages are left out, since the model speaks English only.
#
# Everything is written to a folder beside the target and moved into place once all of it arrived,
# so a failed run leaves the voice that was there, not half of a new one.
#
# Usage: python fetch_voice.py --models <dir>

import argparse
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

# The model, at the revision ptts 0.4.0 names as its default (`ptts.DEFAULT_MODEL`). Full precision
# only: the quantized files run on the CPU alone, and the speech process runs on the GPU.
MODEL_REPO = "gradium/phonon-31m-en"
MODEL_REVISION = "8c64b55ec301728e2d1695bfea87a08a267d0c2d"
MODEL_FILES = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer.model", "default-voice.safetensors"]

# The voice catalog, at the revision ptts 0.4.0 names (`ptts.DEFAULT_VOICE_CATALOG`).
VOICES_REPO = "gradium/phonon-voices"
VOICES_REVISION = "da6c9ec0d47be8df5c87c730a3aa97187f3229c3"
EVERYDAY_LOCALES = {"en-us", "en-gb"}  # the catalog marks the character voices with locale "characters"


def fetch(repo: str, revision: str, name: str, to: Path) -> str:
    """Downloads one file to `to`, returning its sha256."""
    to.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with urllib.request.urlopen(f"https://huggingface.co/{repo}/resolve/{revision}/{name}") as response, to.open("wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch the speech process's voice")
    parser.add_argument("--models", type=Path, required=True)
    target = parser.parse_args().models.resolve()
    staging = target.with_name(target.name + ".incoming")
    shutil.rmtree(staging, ignore_errors=True)  # only ever this script's own leftover

    record = [f"Phonon 31M English (Gradium, Apache-2.0) and its everyday English voices, for agent-feed/speech/speech_server.py.",
              f"Model: https://huggingface.co/{MODEL_REPO} at {MODEL_REVISION}",
              f"Voices: https://huggingface.co/{VOICES_REPO} at {VOICES_REVISION}", "", "sha256:"]
    for name in MODEL_FILES:
        record.append(f"  {fetch(MODEL_REPO, MODEL_REVISION, name, staging / name)}  {name}")
        print(f"fetched {name}")

    catalog = staging / "voices"
    record.append(f"  {fetch(VOICES_REPO, VOICES_REVISION, 'voices.jsonl', catalog / 'voices.full.jsonl')}  voices.jsonl")
    rows = [json.loads(line) for line in (catalog / "voices.full.jsonl").read_text().splitlines() if line.strip()]
    (catalog / "voices.full.jsonl").unlink()
    everyday = [row for row in rows if row.get("language") == "en" and row.get("locale") in EVERYDAY_LOCALES]
    if not everyday:
        raise SystemExit("the catalog lists no everyday English voice; refusing to install a voice with none")
    for row in everyday:
        record.append(f"  {fetch(VOICES_REPO, VOICES_REVISION, row['filename'], catalog / row['filename'])}  {row['filename']}  {row['name']}")
    (catalog / "voices.jsonl").write_text("".join(json.dumps(row) + "\n" for row in everyday))
    print(f"fetched {len(everyday)} voices")
    (staging / "SOURCE.txt").write_text("\n".join(record) + "\n")

    if target.exists():
        retired = target.with_name(target.name + ".previous")
        shutil.rmtree(retired, ignore_errors=True)
        target.rename(retired)
        staging.rename(target)
        shutil.rmtree(retired)
    else:
        staging.rename(target)
    print(f"voice ready in {target}")


if __name__ == "__main__":
    main()
