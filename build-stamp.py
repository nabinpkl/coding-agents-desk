"""Bake build identity into dist/ at pack time. No manual version bumps.

Prefers git (count + short sha) when available, else falls back to a content
hash of the runtime files. Writes dist/build.js and stamps the dist manifest
description, which is what chrome://extensions shows. Source files untouched.
"""
import datetime
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"
SOURCES = ["manifest.json", "background.js", "format.js", "content.js",
           "styles.css", "popup.html", "popup.js"]


def git(*args):
    try:
        return subprocess.run(["git"] + list(args), capture_output=True,
                              text=True, cwd=ROOT, check=True).stdout.strip()
    except Exception:
        return None


def main():
    h = hashlib.sha256()
    for f in SOURCES:
        h.update((ROOT / f).read_bytes())
    sha = git("rev-parse", "--short", "HEAD") or h.hexdigest()[:12]
    count = git("rev-list", "--count", "HEAD") or "n/a"
    man = json.loads((ROOT / "manifest.json").read_text())
    info = {
        "sha": sha,
        "count": count,
        "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "version": man["version"],
    }
    (DIST / "build.js").write_text("window.AX_BUILD = %s;\n" % json.dumps(info))
    dman = json.loads((DIST / "manifest.json").read_text())
    dman["description"] = "%s (build %s #%s)" % (man["description"], sha, count)
    (DIST / "manifest.json").write_text(json.dumps(dman, indent=2) + "\n")
    print("stamp", json.dumps(info))


if __name__ == "__main__":
    main()
