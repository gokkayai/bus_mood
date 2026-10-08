import os
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from server import (
    GoogleRoutesError,
    fetch_google_routes,
    load_env,
    normalize_google_routes,
)


class NormalizeGoogleRoutesTests(unittest.TestCase):
    def test_extracts_first_bus_and_walking_time(self) -> None:
        payload = {
            "routes": [
                {
                    "duration": "1500s",
                    "legs": [
                        {
                            "steps": [
                                {"travelMode": "WALK", "duration": "330s"},
                                {
                                    "travelMode": "TRANSIT",
                                    "transitDetails": {
                                        "stopDetails": {
                                            "departureStop": {"name": "Balgonie Road"},
                                            "arrivalStop": {"name": "Trafalgar Square"},
                                            "departureTime": "2026-10-08T09:00:00Z",
                                        },
                                        "headsign": "Westminster",
                                        "transitLine": {
                                            "nameShort": "24",
                                            "vehicle": {"type": "BUS"},
                                        },
                                    },
                                },
                            ]
                        }
                    ],
                }
            ]
        }

        routes = normalize_google_routes(payload)

        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["line"], "24")
        self.assertEqual(routes[0]["walkingMinutes"], 5.5)
        self.assertEqual(routes[0]["durationMinutes"], 25)

    def test_ignores_routes_without_transit(self) -> None:
        payload = {
            "routes": [
                {"legs": [{"steps": [{"travelMode": "WALK", "duration": "60s"}]}]}
            ]
        }

        self.assertEqual(normalize_google_routes(payload), [])

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_api_key_has_clear_error(self) -> None:
        with self.assertRaisesRegex(GoogleRoutesError, "GOOGLE_MAPS_API_KEY"):
            fetch_google_routes("Origin", "Destination")

    def test_env_file_loads_values_without_overriding_process(self) -> None:
        with TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "FROM_FILE=loaded\nEXISTING=from-file\nQUOTED='hello world'\n"
            )
            with patch.dict("os.environ", {"EXISTING": "from-process"}, clear=True):
                load_env(env_file)

                self.assertEqual(os.environ["FROM_FILE"], "loaded")
                self.assertEqual(os.environ["EXISTING"], "from-process")
                self.assertEqual(os.environ["QUOTED"], "hello world")


if __name__ == "__main__":
    unittest.main()
