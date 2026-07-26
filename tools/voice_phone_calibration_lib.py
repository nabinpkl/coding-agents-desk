"""Shared, deterministic R131 phone-score extraction and calibration helpers."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import math
from typing import Any, Iterable, Sequence

import numpy as np


FEATURE_VERSION = "r131-v1"
CANDIDATES = (
    "alignedPosteriorMargin",
    "alignedLogitMargin",
    "alignmentFreeSubstitutionMargin",
    "alignmentFreeSubstitutionDeletionMargin",
)
PRODUCT_PHONES = ("θ", "s", "ɹ", "l", "v", "w", "ɪ", "iː")


class CalibrationError(RuntimeError):
    pass


def log_sum_exp(values: Sequence[float]) -> float:
    if not values:
        return -math.inf
    maximum = max(values)
    if not math.isfinite(maximum):
        return -math.inf
    return maximum + math.log(sum(math.exp(value - maximum) for value in values))


def log_posteriors(logits: np.ndarray) -> np.ndarray:
    if logits.ndim != 2 or logits.shape[0] == 0 or logits.shape[1] == 0:
        raise CalibrationError(f"invalid logits shape {logits.shape}")
    maximum = np.max(logits.astype(np.float64), axis=1, keepdims=True)
    shifted = logits.astype(np.float64) - maximum
    return shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))


def ctc_sequence_log_probability(
    posteriors: np.ndarray,
    token_ids: Sequence[int],
    blank_token_id: int,
) -> float:
    if posteriors.ndim != 2 or posteriors.shape[0] == 0:
        raise CalibrationError("CTC input contains no frames")
    vocabulary_size = posteriors.shape[1]
    if not 0 <= blank_token_id < vocabulary_size:
        raise CalibrationError("blank token is outside the vocabulary")
    if any(not 0 <= token < vocabulary_size for token in token_ids):
        raise CalibrationError("target token is outside the vocabulary")

    states = [blank_token_id]
    for token in token_ids:
        states.extend((token, blank_token_id))
    previous = [-math.inf] * len(states)
    previous[0] = float(posteriors[0, blank_token_id])
    if len(states) > 1:
        previous[1] = float(posteriors[0, states[1]])

    for frame_index in range(1, posteriors.shape[0]):
        current = [-math.inf] * len(states)
        for state_index, token in enumerate(states):
            incoming = [previous[state_index]]
            if state_index > 0:
                incoming.append(previous[state_index - 1])
            if (
                state_index > 1
                and token != blank_token_id
                and token != states[state_index - 2]
            ):
                incoming.append(previous[state_index - 2])
            current[state_index] = log_sum_exp(incoming) + float(
                posteriors[frame_index, token]
            )
        previous = current
    terminal = (
        previous[0]
        if len(states) == 1
        else log_sum_exp((previous[-1], previous[-2]))
    )
    if not math.isfinite(terminal):
        raise CalibrationError("CTC sequence has no finite path")
    return terminal


def viterbi_alignment(
    posteriors: np.ndarray,
    target_token_ids: Sequence[int],
    blank_token_id: int,
) -> tuple[float, list[tuple[int, int]]]:
    if not target_token_ids:
        raise CalibrationError("target pronunciation is empty")
    states = [blank_token_id]
    for token in target_token_ids:
        states.extend((token, blank_token_id))
    frame_count = posteriors.shape[0]
    scores = np.full((frame_count, len(states)), -math.inf, dtype=np.float64)
    previous_states = np.full((frame_count, len(states)), -1, dtype=np.int32)
    scores[0, 0] = posteriors[0, blank_token_id]
    scores[0, 1] = posteriors[0, states[1]]
    for frame_index in range(1, frame_count):
        for state_index, token in enumerate(states):
            candidates = [(scores[frame_index - 1, state_index], state_index)]
            if state_index > 0:
                candidates.append(
                    (scores[frame_index - 1, state_index - 1], state_index - 1)
                )
            if (
                state_index > 1
                and token != blank_token_id
                and token != states[state_index - 2]
            ):
                candidates.append(
                    (scores[frame_index - 1, state_index - 2], state_index - 2)
                )
            best_score, best_state = max(candidates)
            scores[frame_index, state_index] = (
                best_score + posteriors[frame_index, token]
            )
            previous_states[frame_index, state_index] = best_state
    final_candidates = (
        (scores[-1, -1], len(states) - 1),
        (scores[-1, -2], len(states) - 2),
    )
    final_score, state_index = max(final_candidates)
    if not math.isfinite(float(final_score)):
        raise CalibrationError("target pronunciation cannot be aligned")
    path = [0] * frame_count
    for frame_index in range(frame_count - 1, -1, -1):
        path[frame_index] = state_index
        if frame_index:
            state_index = int(previous_states[frame_index, state_index])
            if state_index < 0:
                raise CalibrationError("alignment backtrace is incomplete")
    ranges: list[tuple[int, int]] = []
    for target_index in range(len(target_token_ids)):
        target_state = target_index * 2 + 1
        frames = [index for index, state in enumerate(path) if state == target_state]
        if not frames:
            raise CalibrationError("aligned phone has no frames")
        ranges.append((frames[0], frames[-1]))
    return float(final_score), ranges


def phone_score_features(
    *,
    logits: np.ndarray,
    posteriors: np.ndarray,
    target_token_ids: Sequence[int],
    target_index: int,
    aligned_range: tuple[int, int],
    assessment_token_ids: Sequence[int],
    blank_token_id: int,
    excluded_token_ids: set[int],
    vocabulary: Sequence[str],
) -> dict[str, float | int | str]:
    start, end = aligned_range
    frame_slice = slice(start, end + 1)
    mean_posteriors = posteriors[frame_slice].mean(axis=0)
    mean_logits = logits[frame_slice].astype(np.float64).mean(axis=0)
    target_token = target_token_ids[target_index]
    competitors = [
        token
        for token in range(len(vocabulary))
        if token != target_token
        and token not in excluded_token_ids
        and not vocabulary[token].startswith("<")
    ]
    if not competitors:
        raise CalibrationError("no aligned competitor is available")
    strongest_posterior = max(
        competitors,
        key=lambda token: float(mean_posteriors[token]),
    )
    strongest_logit = max(
        competitors,
        key=lambda token: float(mean_logits[token]),
    )
    canonical = ctc_sequence_log_probability(
        posteriors,
        target_token_ids,
        blank_token_id,
    )
    substitution_probabilities = []
    for alternative in assessment_token_ids:
        if alternative in (target_token, blank_token_id):
            continue
        sequence = list(target_token_ids)
        sequence[target_index] = alternative
        substitution_probabilities.append(
            ctc_sequence_log_probability(
                posteriors,
                sequence,
                blank_token_id,
            )
        )
    if not substitution_probabilities:
        raise CalibrationError("assessment inventory has no substitution")
    substitution_sum = log_sum_exp(substitution_probabilities)
    deletion_sequence = list(target_token_ids)
    del deletion_sequence[target_index]
    deletion = ctc_sequence_log_probability(
        posteriors,
        deletion_sequence,
        blank_token_id,
    )
    substitution_deletion_sum = log_sum_exp((substitution_sum, deletion))

    aligned = posteriors[frame_slice]
    winners = np.argmax(aligned, axis=1)
    blank_ratio = float(np.mean(winners == blank_token_id))
    strongest_assessment = np.max(
        aligned[:, list(assessment_token_ids)],
        axis=1,
    )
    effective_count = int(
        np.sum(strongest_assessment > aligned[:, blank_token_id])
    )
    return {
        "featureVersion": FEATURE_VERSION,
        "alignedPosteriorMargin": float(
            mean_posteriors[target_token]
            - mean_posteriors[strongest_posterior]
        ),
        "alignedLogitMargin": float(
            mean_logits[target_token] - mean_logits[strongest_logit]
        ),
        "alignmentFreeSubstitutionMargin": float(canonical - substitution_sum),
        "alignmentFreeSubstitutionDeletionMargin": float(
            canonical - substitution_deletion_sum
        ),
        "canonicalSequenceLogProbability": float(canonical),
        "substitutionSequenceLogSumProbability": float(substitution_sum),
        "deletionSequenceLogProbability": float(deletion),
        "blankFrameRatio": blank_ratio,
        "effectiveNonBlankFrameCount": effective_count,
    }


def pearson(values: Sequence[float], grades: Sequence[float]) -> float:
    if len(values) < 2 or np.std(values) == 0 or np.std(grades) == 0:
        return math.nan
    return float(np.corrcoef(values, grades)[0, 1])


def spearman(values: Sequence[float], grades: Sequence[float]) -> float:
    from scipy.stats import spearmanr

    if len(values) < 2:
        return math.nan
    return float(spearmanr(values, grades).statistic)


def auroc(values: Sequence[float], grades: Sequence[float]) -> float:
    from sklearn.metrics import roc_auc_score

    selected = [
        (value, 0 if grade <= 0.5 else 1)
        for value, grade in zip(values, grades)
        if grade <= 0.5 or grade >= 1.5
    ]
    if len({label for _, label in selected}) != 2:
        return math.nan
    return float(
        roc_auc_score(
            [label for _, label in selected],
            [value for value, _ in selected],
        )
    )


def calibration_error(
    predictions: Sequence[float],
    grades: Sequence[float],
    bin_count: int = 10,
) -> float:
    if len(predictions) == 0:
        return math.nan
    order = np.argsort(np.asarray(predictions))
    bins = np.array_split(order, min(bin_count, len(order)))
    errors = [
        abs(
            float(np.mean(np.asarray(predictions)[indices])) / 2
            - float(np.mean(np.asarray(grades)[indices])) / 2
        )
        for indices in bins
        if len(indices)
    ]
    weights = [len(indices) for indices in bins if len(indices)]
    return float(np.average(errors, weights=weights))


def fit_isotonic(
    values: Sequence[float],
    grades: Sequence[float],
) -> list[dict[str, float]]:
    from sklearn.isotonic import IsotonicRegression

    model = IsotonicRegression(y_min=0, y_max=2, out_of_bounds="clip")
    model.fit(values, grades)
    knots = [
        {"margin": float(margin), "expectedGrade": float(grade)}
        for margin, grade in zip(model.X_thresholds_, model.y_thresholds_)
    ]
    if len(knots) < 2:
        raise CalibrationError("isotonic fit produced fewer than two knots")
    return compress_knots(knots)


def compress_knots(
    knots: list[dict[str, float]],
    maximum_count: int = 128,
) -> list[dict[str, float]]:
    if len(knots) <= maximum_count:
        return knots
    indices = np.linspace(0, len(knots) - 1, maximum_count)
    selected = sorted({int(round(index)) for index in indices})
    return [knots[index] for index in selected]


def predict_knots(
    values: Sequence[float],
    knots: Sequence[dict[str, float]],
) -> list[float]:
    margins = np.asarray([knot["margin"] for knot in knots], dtype=np.float64)
    grades = np.asarray(
        [knot["expectedGrade"] for knot in knots],
        dtype=np.float64,
    )
    return [
        float(np.interp(value, margins, grades))
        for value in values
    ]


def metric_summary(
    values: Sequence[float],
    grades: Sequence[float],
    predictions: Sequence[float],
) -> dict[str, float | int]:
    return {
        "count": len(values),
        "pearsonCorrelation": pearson(values, grades),
        "spearmanCorrelation": spearman(values, grades),
        "meanAbsoluteError": float(
            np.mean(np.abs(np.asarray(predictions) - np.asarray(grades)))
        ),
        "auroc": auroc(values, grades),
        "calibrationError": calibration_error(predictions, grades),
    }


def grouped_cross_validation(
    rows: Sequence[dict[str, Any]],
    candidate: str,
) -> dict[str, float | int]:
    from sklearn.model_selection import GroupKFold

    values = np.asarray([row[candidate] for row in rows], dtype=np.float64)
    grades = np.asarray([row["grade"] for row in rows], dtype=np.float64)
    groups = np.asarray([row["speaker"] for row in rows])
    group_count = len(set(groups))
    if group_count < 2:
        raise CalibrationError("calibration requires at least two speakers")
    folds = GroupKFold(n_splits=min(5, group_count))
    predictions = np.empty_like(grades)
    for train_indices, validation_indices in folds.split(values, grades, groups):
        knots = fit_isotonic(values[train_indices], grades[train_indices])
        predictions[validation_indices] = predict_knots(
            values[validation_indices],
            knots,
        )
    return metric_summary(values, grades, predictions)


def choose_candidate(
    reports: dict[str, dict[str, float | int]],
) -> str:
    finite = {
        candidate: report
        for candidate, report in reports.items()
        if math.isfinite(float(report["pearsonCorrelation"]))
        and math.isfinite(float(report["meanAbsoluteError"]))
    }
    if not finite:
        raise CalibrationError("no candidate produced finite grouped-fold metrics")
    best_pearson = max(
        float(report["pearsonCorrelation"]) for report in finite.values()
    )
    best_mae = min(
        float(report["meanAbsoluteError"]) for report in finite.values()
    )
    eligible = {
        candidate
        for candidate, report in finite.items()
        if float(report["pearsonCorrelation"]) >= best_pearson - 0.02
        and float(report["meanAbsoluteError"]) <= best_mae + 0.02
    }
    return next(candidate for candidate in CANDIDATES if candidate in eligible)


def phone_support(
    train_rows: Sequence[dict[str, Any]],
    test_rows: Sequence[dict[str, Any]],
    candidate: str,
    knots: Sequence[dict[str, float]],
) -> list[dict[str, float | int | str]]:
    train_by_phone: dict[str, list[dict[str, Any]]] = defaultdict(list)
    test_by_phone: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in train_rows:
        train_by_phone[row["phone"]].append(row)
    for row in test_rows:
        test_by_phone[row["phone"]].append(row)
    supported = []
    for phone in PRODUCT_PHONES:
        training = train_by_phone[phone]
        held_out = test_by_phone[phone]
        low_count = sum(row["grade"] < 1 for row in training)
        high_count = sum(row["grade"] >= 1.5 for row in training)
        if (
            len(training) < 100
            or len(held_out) < 20
            or low_count == 0
            or high_count == 0
        ):
            continue
        values = [row[candidate] for row in held_out]
        grades = [row["grade"] for row in held_out]
        low_test_count = sum(grade <= 0.5 for grade in grades)
        high_test_count = sum(grade >= 1.5 for grade in grades)
        predictions = predict_knots(values, knots)
        summary = metric_summary(values, grades, predictions)
        if (
            not math.isfinite(float(summary["pearsonCorrelation"]))
            or float(summary["pearsonCorrelation"]) < 0
            or float(summary["meanAbsoluteError"]) > 0.5
            or low_test_count < 10
            or high_test_count < 10
        ):
            continue
        supported.append(
            {
                "phone": phone,
                "trainingCount": len(training),
                "testCount": len(held_out),
                "lowGradeTrainingCount": low_count,
                "highGradeTrainingCount": high_count,
                "lowGradeTestCount": low_test_count,
                "highGradeTestCount": high_test_count,
                "testPearsonCorrelation": summary["pearsonCorrelation"],
                "testMeanAbsoluteError": summary["meanAbsoluteError"],
            }
        )
    return supported


def bootstrap_pearson_lower_bound(
    rows: Sequence[dict[str, Any]],
    candidate: str,
    *,
    repetitions: int = 1_000,
    seed: int = 13_131,
) -> float:
    by_speaker: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_speaker[row["speaker"]].append(row)
    speakers = sorted(by_speaker)
    if len(speakers) < 2:
        return math.nan
    generator = np.random.default_rng(seed)
    correlations = []
    for _ in range(repetitions):
        sampled = generator.choice(speakers, size=len(speakers), replace=True)
        selected = [
            row
            for speaker in sampled
            for row in by_speaker[str(speaker)]
        ]
        correlation = pearson(
            [row[candidate] for row in selected],
            [row["grade"] for row in selected],
        )
        if math.isfinite(correlation):
            correlations.append(correlation)
    return (
        float(np.quantile(correlations, 0.025))
        if correlations
        else math.nan
    )


def report_groups(
    rows: Sequence[dict[str, Any]],
    candidate: str,
    knots: Sequence[dict[str, float]],
    group_key: str,
) -> dict[str, dict[str, float | int]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row[group_key])].append(row)
    return {
        group: metric_summary(
            [row[candidate] for row in selected],
            [row["grade"] for row in selected],
            predict_knots(
                [row[candidate] for row in selected],
                knots,
            ),
        )
        for group, selected in sorted(grouped.items())
    }
