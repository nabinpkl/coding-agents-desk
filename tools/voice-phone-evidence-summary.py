#!/usr/bin/env python3
"""Summarize pulled iPhone voice metadata and bounded phone analyzer evidence."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


class SummaryError(Exception):
    """Raised when pulled evidence is malformed or incomplete."""


EVIDENCE_RELATIVE_PATH = re.compile(
    r"^[0-9A-Fa-f-]{36}/(?:metadata|phone-evidence|phone-analysis-log)\.json$"
)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SummaryError(f"cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise SummaryError(f"{path} must contain a JSON object")
    return value


def quoted(value: Any) -> str:
    return json.dumps("" if value is None else str(value), ensure_ascii=False)


def nested_text(value: Any, *keys: str) -> str:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return ""
        current = current.get(key)
    return current if isinstance(current, str) else ""


def number(value: Any, digits: int = 2) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{value:.{digits}f}"
    return "?"


def summarize_analysis_log(
    attempt_directory: Path,
    attempt_id: str,
) -> list[str]:
    log_path = attempt_directory / "phone-analysis-log.json"
    if not log_path.exists():
        return ["  phone-log status=missing"]

    analysis_log = load_json(log_path)
    if analysis_log.get("schemaVersion") != 1:
        raise SummaryError(
            f"{log_path} schemaVersion {analysis_log.get('schemaVersion')!r} "
            "is unsupported"
        )
    if analysis_log.get("attemptID") != attempt_id:
        raise SummaryError(
            f"{log_path} attemptID {analysis_log.get('attemptID')!r} "
            "does not match metadata"
        )
    model_hash = analysis_log.get("modelWeightSHA256")
    if not isinstance(model_hash, str) or not model_hash:
        raise SummaryError(f"{log_path} modelWeightSHA256 must be a non-empty string")
    events = analysis_log.get("events")
    if not isinstance(events, list) or not events:
        raise SummaryError(f"{log_path} events must be a non-empty array")

    validated_events: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise SummaryError(f"{log_path} event {index} must be an object")
        if not isinstance(event.get("timestamp"), str) or not event["timestamp"]:
            raise SummaryError(f"{log_path} event {index} has no timestamp")
        if not isinstance(event.get("stage"), str) or not event["stage"]:
            raise SummaryError(f"{log_path} event {index} has no stage")
        details = event.get("details")
        if not isinstance(details, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in details.items()
        ):
            raise SummaryError(
                f"{log_path} event {index} details must be string pairs"
            )
        resident_memory = event.get("residentMemoryBytes")
        if resident_memory is not None and (
            not isinstance(resident_memory, int)
            or isinstance(resident_memory, bool)
            or resident_memory < 0
        ):
            raise SummaryError(
                f"{log_path} event {index} residentMemoryBytes must be non-negative"
            )
        validated_events.append(event)

    lines = [
        "  phone-log status=present "
        f"eventCount={len(validated_events)} "
        f"lastStage={quoted(validated_events[-1]['stage'])} "
        f"modelHash={quoted(model_hash)}"
    ]
    for event in validated_events:
        details = ", ".join(
            f"{key}={value}" for key, value in sorted(event["details"].items())
        )
        lines.append(
            "    log "
            f"timestamp={quoted(event['timestamp'])} "
            f"stage={quoted(event['stage'])} "
            f"residentBytes={event.get('residentMemoryBytes', '?')} "
            f"details={quoted(details)}"
        )
    return lines


def summarize_attempt(
    attempt_directory: Path,
    expected_model_weight_sha256: str | None,
) -> list[str]:
    metadata_path = attempt_directory / "metadata.json"
    metadata = load_json(metadata_path)
    attempt_id = metadata.get("id")
    if attempt_id != attempt_directory.name:
        raise SummaryError(
            f"{metadata_path} id {attempt_id!r} does not match its directory"
        )

    build = metadata.get("build")
    if not isinstance(build, dict):
        build = {}
    lines = [
        (
            f"attempt id={attempt_id} createdAt={quoted(metadata.get('createdAt'))} "
            f"target={quoted(metadata.get('targetPhrase'))} "
            f"durationSeconds={number(metadata.get('durationSeconds'), 1)} "
            f"build={quoted(build.get('marketingVersion'))}"
            f"({quoted(build.get('buildNumber'))}) "
            f"gitSHA={quoted(build.get('gitSHA'))}"
        )
    ]

    analysis = metadata.get("analysis")
    if isinstance(analysis, dict):
        lines.append(
            "  recognition "
            f"unaided={quoted(nested_text(analysis, 'withoutContext', 'top', 'text'))} "
            f"targetBiased={quoted(nested_text(analysis, 'withContext', 'top', 'text'))} "
            f"verdict={quoted(analysis.get('verdict'))}"
        )
    elif metadata.get("analysisFailure"):
        lines.append(
            f"  recognition status=failed error={quoted(metadata['analysisFailure'])}"
        )
    else:
        lines.append("  recognition status=pending")

    lines.extend(summarize_analysis_log(attempt_directory, attempt_id))

    phone_path = attempt_directory / "phone-evidence.json"
    if not phone_path.exists():
        lines.append(
            "  phone status=missing "
            "detail=\"Analyze raw audio has not produced phone-evidence.json.\""
        )
        return lines

    stored = load_json(phone_path)
    if stored.get("attemptID") != attempt_id:
        raise SummaryError(
            f"{phone_path} attemptID {stored.get('attemptID')!r} does not match metadata"
        )
    evidence = stored.get("evidence")
    failure = stored.get("failure")
    if (isinstance(evidence, dict)) == (isinstance(failure, str) and bool(failure)):
        raise SummaryError(
            f"{phone_path} must contain exactly one completed evidence or failure"
        )

    stored_model_hash = stored.get("modelWeightSHA256")
    if isinstance(failure, str) and failure:
        lines.append(f"  phone status=failed error={quoted(failure)}")
        return lines

    if (
        expected_model_weight_sha256
        and stored_model_hash != expected_model_weight_sha256
    ):
        lines.append(
            "  phone status=stale "
            f"storedModel={quoted(stored_model_hash)} "
            f"expectedModel={quoted(expected_model_weight_sha256)}"
        )
        return lines

    if not isinstance(evidence, dict):
        raise SummaryError(f"{phone_path} completed evidence is missing")
    if evidence.get("audioSHA256") != stored.get("audioSHA256"):
        raise SummaryError(
            f"{phone_path} evidence audio hash does not match its stored envelope"
        )
    model = evidence.get("model")
    metrics = evidence.get("metrics")
    aligned_phones = evidence.get("alignedPhones")
    if not isinstance(model, dict) or not isinstance(metrics, dict):
        raise SummaryError(f"{phone_path} is missing model or inference metrics")
    if not isinstance(aligned_phones, list):
        raise SummaryError(f"{phone_path} alignedPhones must be an array")

    lines.append(
        "  phone status=completed "
        f"model={quoted(model.get('identifier'))} "
        f"modelHash={quoted(stored_model_hash)} "
        f"alignedPhoneCount={len(aligned_phones)}"
    )
    for phone in aligned_phones:
        if not isinstance(phone, dict):
            raise SummaryError(f"{phone_path} contains a non-object aligned phone")
        observed = phone.get("observedPhone")
        competitors = phone.get("competingPhones")
        if not isinstance(observed, dict) or not isinstance(competitors, list):
            raise SummaryError(
                f"{phone_path} aligned phone is missing observed or competing phones"
            )
        competitor_text = ", ".join(
            f"{item.get('phone')}:{number(item.get('logPosterior'))}"
            for item in competitors
            if isinstance(item, dict)
        )
        lines.append(
            "    phone "
            f"target={quoted(phone.get('targetPhone'))} "
            f"observed={quoted(observed.get('phone'))} "
            f"start={number(phone.get('startSeconds'))} "
            f"end={number(phone.get('endSeconds'))} "
            f"targetLogPosterior={number(phone.get('targetLogPosterior'))} "
            f"observedLogPosterior={number(observed.get('logPosterior'))} "
            f"margin={number(phone.get('posteriorMargin'))} "
            f"competitors={quoted(competitor_text)}"
        )
    lines.append(
        "  metrics "
        f"sourceSeconds={number(metrics.get('sourceDurationSeconds'))} "
        f"loadMs={number(metrics.get('modelLoadMilliseconds'), 0)} "
        f"inferenceMs={number(metrics.get('inferenceMilliseconds'), 0)} "
        f"observedRSSDeltaBytes={metrics.get('observedResidentMemoryDeltaBytes', '?')}"
    )
    return lines


def summarize(
    attempts_directory: Path,
    model_manifest_path: Path | None = None,
) -> list[str]:
    if not attempts_directory.is_dir():
        raise SummaryError(f"attempts directory does not exist: {attempts_directory}")

    expected_model_hash = None
    if model_manifest_path is not None:
        manifest = load_json(model_manifest_path)
        value = manifest.get("modelWeightSHA256")
        if not isinstance(value, str) or not value:
            raise SummaryError(
                f"{model_manifest_path} does not declare modelWeightSHA256"
            )
        expected_model_hash = value

    attempt_directories = sorted(
        (
            path
            for path in attempts_directory.iterdir()
            if path.is_dir() and (path / "metadata.json").is_file()
        ),
        key=lambda path: path.name,
    )
    lines = [
        "Voice phone evidence summary",
        f"attemptsDirectory={attempts_directory}",
        f"attemptCount={len(attempt_directories)}",
    ]
    for directory in attempt_directories:
        lines.extend(
            summarize_attempt(
                directory,
                expected_model_weight_sha256=expected_model_hash,
            )
        )
    return lines


def inventory_copy_paths(inventory_path: Path) -> list[str]:
    inventory = load_json(inventory_path)
    result = inventory.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("files"), list):
        raise SummaryError(f"{inventory_path} does not contain a devicectl file list")
    paths: list[str] = []
    for item in result["files"]:
        if not isinstance(item, dict):
            continue
        relative_path = item.get("relativePath")
        if isinstance(relative_path, str) and EVIDENCE_RELATIVE_PATH.fullmatch(
            relative_path
        ):
            paths.append(relative_path)
    return sorted(paths)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("attempts_directory", nargs="?", type=Path)
    parser.add_argument("--model-manifest", type=Path)
    parser.add_argument("--inventory-copy-paths", type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.inventory_copy_paths is not None:
            if arguments.attempts_directory is not None or arguments.model_manifest is not None:
                raise SummaryError(
                    "--inventory-copy-paths cannot be combined with summary arguments"
                )
            print("\n".join(inventory_copy_paths(arguments.inventory_copy_paths)))
            return 0
        if arguments.attempts_directory is None:
            raise SummaryError("attempts_directory is required")
        print(
            "\n".join(
                summarize(
                    arguments.attempts_directory,
                    model_manifest_path=arguments.model_manifest,
                )
            )
        )
    except SummaryError as error:
        print(f"voice-phone-evidence-summary: error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
