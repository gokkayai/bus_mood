"""Probability-aware departure scheduling.

The scheduler models the predicted bus arrival time ``B`` and walking duration
``W`` as jointly normal random variables.  A departure at time ``d`` catches
the bus when ``d + W <= B``, or equivalently when ``d <= B - W``.

The latest departure with a requested catch probability is therefore the
``1 - confidence`` quantile of the slack time ``B - W``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sqrt
from statistics import NormalDist


@dataclass(frozen=True)
class DeparturePlan:
    """The recommended departure and the assumptions used to calculate it."""

    leave_at: datetime
    catch_probability: float
    expected_slack: timedelta
    slack_standard_deviation: timedelta


def latest_safe_departure(
    bus_arrival: datetime,
    walking_time: timedelta,
    *,
    bus_standard_deviation: timedelta,
    walk_standard_deviation: timedelta,
    confidence: float = 0.95,
    correlation: float = 0.0,
) -> DeparturePlan:
    """Return the latest departure meeting the catch-probability target.

    Args:
        bus_arrival: Mean predicted arrival time of the bus.
        walking_time: Mean walking duration to the stop.
        bus_standard_deviation: Standard deviation of the arrival prediction.
        walk_standard_deviation: Standard deviation of the walking duration.
        confidence: Minimum probability of reaching the stop before the bus.
        correlation: Correlation between bus arrival and walking duration.
            Zero is appropriate when they can reasonably be treated as
            independent.

    The normal model is useful when the inputs come from historical prediction
    errors and walking times.  Standard deviations describe uncertainty; they
    are not extra buffers.
    """

    _validate_inputs(
        walking_time,
        bus_standard_deviation,
        walk_standard_deviation,
        confidence,
        correlation,
    )

    bus_sd = bus_standard_deviation.total_seconds()
    walk_sd = walk_standard_deviation.total_seconds()
    slack_variance = (
        bus_sd**2
        + walk_sd**2
        - 2 * correlation * bus_sd * walk_sd
    )
    # Protect against a tiny negative value caused by floating-point rounding.
    slack_sd = sqrt(max(0.0, slack_variance))
    mean_slack = bus_arrival - walking_time

    if slack_sd == 0:
        leave_at = mean_slack
    else:
        lower_quantile = NormalDist().inv_cdf(1.0 - confidence)
        leave_at = mean_slack + timedelta(seconds=lower_quantile * slack_sd)

    return DeparturePlan(
        leave_at=leave_at,
        catch_probability=catch_probability(
            leave_at,
            bus_arrival,
            walking_time,
            bus_standard_deviation=bus_standard_deviation,
            walk_standard_deviation=walk_standard_deviation,
            correlation=correlation,
        ),
        expected_slack=mean_slack - leave_at,
        slack_standard_deviation=timedelta(seconds=slack_sd),
    )


def catch_probability(
    departure: datetime,
    bus_arrival: datetime,
    walking_time: timedelta,
    *,
    bus_standard_deviation: timedelta,
    walk_standard_deviation: timedelta,
    correlation: float = 0.0,
) -> float:
    """Return ``P(departure + W <= B)`` under the same normal model."""

    _validate_inputs(
        walking_time,
        bus_standard_deviation,
        walk_standard_deviation,
        0.5,
        correlation,
    )

    bus_sd = bus_standard_deviation.total_seconds()
    walk_sd = walk_standard_deviation.total_seconds()
    slack_sd = sqrt(
        max(
            0.0,
            bus_sd**2
            + walk_sd**2
            - 2 * correlation * bus_sd * walk_sd,
        )
    )
    mean_slack = bus_arrival - walking_time
    distance_from_mean = (departure - mean_slack).total_seconds()

    if slack_sd == 0:
        return 1.0 if distance_from_mean <= 0 else 0.0

    return 1.0 - NormalDist().cdf(distance_from_mean / slack_sd)


def _validate_inputs(
    walking_time: timedelta,
    bus_standard_deviation: timedelta,
    walk_standard_deviation: timedelta,
    confidence: float,
    correlation: float,
) -> None:
    if walking_time < timedelta(0):
        raise ValueError("walking_time cannot be negative")
    if bus_standard_deviation < timedelta(0):
        raise ValueError("bus_standard_deviation cannot be negative")
    if walk_standard_deviation < timedelta(0):
        raise ValueError("walk_standard_deviation cannot be negative")
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be between 0 and 1")
    if not -1.0 <= correlation <= 1.0:
        raise ValueError("correlation must be between -1 and 1")

