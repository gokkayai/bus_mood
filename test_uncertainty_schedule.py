from datetime import datetime, timedelta, timezone
import unittest

from uncertainty_schedule import catch_probability, latest_safe_departure


class LatestSafeDepartureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.arrival = datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc)

    def test_departure_meets_95_percent_target(self) -> None:
        plan = latest_safe_departure(
            self.arrival,
            timedelta(minutes=5),
            bus_standard_deviation=timedelta(minutes=2),
            walk_standard_deviation=timedelta(minutes=1),
        )

        # datetime stores microseconds, so the calculated quantile is rounded.
        self.assertAlmostEqual(plan.catch_probability, 0.95, places=9)
        self.assertGreater(plan.expected_slack, timedelta(minutes=3))

    def test_leaving_later_falls_below_target(self) -> None:
        inputs = {
            "bus_standard_deviation": timedelta(minutes=2),
            "walk_standard_deviation": timedelta(minutes=1),
        }
        plan = latest_safe_departure(
            self.arrival,
            timedelta(minutes=5),
            **inputs,
        )

        probability = catch_probability(
            plan.leave_at + timedelta(seconds=1),
            self.arrival,
            timedelta(minutes=5),
            **inputs,
        )

        self.assertLess(probability, 0.95)

    def test_no_uncertainty_uses_expected_travel_time(self) -> None:
        plan = latest_safe_departure(
            self.arrival,
            timedelta(minutes=5),
            bus_standard_deviation=timedelta(0),
            walk_standard_deviation=timedelta(0),
        )

        self.assertEqual(plan.leave_at, self.arrival - timedelta(minutes=5))
        self.assertEqual(plan.catch_probability, 1.0)
        self.assertEqual(plan.expected_slack, timedelta(0))

    def test_invalid_confidence_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            latest_safe_departure(
                self.arrival,
                timedelta(minutes=5),
                bus_standard_deviation=timedelta(minutes=2),
                walk_standard_deviation=timedelta(minutes=1),
                confidence=1.0,
            )


if __name__ == "__main__":
    unittest.main()
