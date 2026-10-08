"""Serve Bus Mood and proxy transit requests to Google Routes API.

Configure the server in a local ``.env`` file. Keeping the request on the server
prevents the credential from being embedded in browser JavaScript.
"""

from __future__ import annotations

from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


BASE_DIR = Path(__file__).resolve().parent


def load_env(path: Path) -> None:
    """Load simple KEY=VALUE pairs without overriding process variables."""

    if not path.is_file():
        return
    for line_number, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RuntimeError(f"Invalid .env entry on line {line_number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value[:1] in {'"', "'"} and value[-1:] == value[:1]:
            value = value[1:-1]
        if not key:
            raise RuntimeError(f"Missing .env key on line {line_number}")
        os.environ.setdefault(key, value)


load_env(BASE_DIR / ".env")

GOOGLE_ROUTES_URL = os.environ.get("GOOGLE_ROUTES_URL", "")
FIELD_MASK = ",".join(
    (
        "routes.duration",
        "routes.legs.steps.duration",
        "routes.legs.steps.travelMode",
        "routes.legs.steps.transitDetails",
    )
)
MAX_REQUEST_BYTES = 8_192


class BusMoodHandler(SimpleHTTPRequestHandler):
    """Static-file handler with a same-origin Google Routes endpoint."""

    def do_POST(self) -> None:  # noqa: N802 - inherited HTTP method name
        if self.path != "/api/routes":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            request_data = self._read_json()
            origin = _required_address(request_data, "origin")
            destination = _required_address(request_data, "destination")
            routes = fetch_google_routes(origin, destination)
        except ClientRequestError as error:
            self._send_json({"error": str(error)}, error.status)
            return
        except GoogleRoutesError as error:
            self._send_json({"error": str(error)}, error.status)
            return

        self._send_json({"routes": routes})

    def _read_json(self) -> dict:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ClientRequestError("Invalid Content-Length header") from error
        if size <= 0 or size > MAX_REQUEST_BYTES:
            raise ClientRequestError("Request body must be between 1 and 8192 bytes")

        try:
            value = json.loads(self.rfile.read(size))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ClientRequestError("Request body must be valid JSON") from error
        if not isinstance(value, dict):
            raise ClientRequestError("Request body must be a JSON object")
        return value

    def _send_json(self, value: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class ClientRequestError(ValueError):
    status = HTTPStatus.BAD_REQUEST


class GoogleRoutesError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: int = HTTPStatus.BAD_GATEWAY,
    ) -> None:
        super().__init__(message)
        self.status = status


def _required_address(data: dict, field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ClientRequestError(f"{field} must be a non-empty string")
    value = value.strip()
    if len(value) > 300:
        raise ClientRequestError(f"{field} cannot exceed 300 characters")
    return value


def fetch_google_routes(origin: str, destination: str) -> list[dict]:
    """Fetch and normalize bus itineraries from Google Routes API."""

    api_key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise GoogleRoutesError(
            "Google Routes is not configured. Set GOOGLE_MAPS_API_KEY on the server.",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )
    if not GOOGLE_ROUTES_URL:
        raise GoogleRoutesError(
            "GOOGLE_ROUTES_URL is not configured in .env.",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )

    departure_time = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = json.dumps(
        {
            "origin": {"address": origin},
            "destination": {"address": destination},
            "travelMode": "TRANSIT",
            "departureTime": departure_time,
            "computeAlternativeRoutes": True,
            "transitPreferences": {
                "allowedTravelModes": ["BUS"],
                "routingPreference": "LESS_WALKING",
            },
            "languageCode": "en",
            "units": "METRIC",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        GOOGLE_ROUTES_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": FIELD_MASK,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        message = _google_error_message(error)
        raise GoogleRoutesError(message, _public_status(error.code)) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise GoogleRoutesError("Google Routes could not be reached. Try again shortly.") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GoogleRoutesError("Google Routes returned an unreadable response.") from error

    routes = normalize_google_routes(payload)
    if not routes:
        raise GoogleRoutesError(
            "Google found no bus journeys for those addresses right now.",
            HTTPStatus.NOT_FOUND,
        )
    return routes


def normalize_google_routes(payload: dict) -> list[dict]:
    """Reduce the Google response to the fields the browser needs."""

    normalized = []
    for route_index, route in enumerate(payload.get("routes", [])):
        steps = [
            step
            for leg in route.get("legs", [])
            for step in leg.get("steps", [])
        ]
        transit_steps = [step for step in steps if step.get("transitDetails")]
        if not transit_steps:
            continue

        first_transit = transit_steps[0]
        details = first_transit["transitDetails"]
        stop_details = details.get("stopDetails", {})
        departure_time = stop_details.get("departureTime")
        if not departure_time:
            continue

        line = details.get("transitLine", {})
        vehicle = line.get("vehicle", {})
        walking_seconds = sum(
            _duration_seconds(step.get("duration", "0s"))
            for step in steps[: steps.index(first_transit)]
            if step.get("travelMode") == "WALK"
        )
        normalized.append(
            {
                "id": f"google-{route_index}-{departure_time}",
                "line": line.get("nameShort") or line.get("name") or "Bus",
                "destination": details.get("headsign") or "Destination not supplied",
                "departureTime": departure_time,
                "departureStop": stop_details.get("departureStop", {}).get("name", "Bus stop"),
                "arrivalStop": stop_details.get("arrivalStop", {}).get("name", "Destination"),
                "walkingMinutes": round(walking_seconds / 60, 1),
                "durationMinutes": round(_duration_seconds(route.get("duration", "0s")) / 60),
                "vehicleType": vehicle.get("type", "BUS"),
            }
        )
    return normalized


def _duration_seconds(value: str) -> float:
    if not isinstance(value, str) or not value.endswith("s"):
        return 0.0
    try:
        return float(value[:-1])
    except ValueError:
        return 0.0


def _google_error_message(error: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(error.read())
        message = payload.get("error", {}).get("message")
    except (UnicodeDecodeError, json.JSONDecodeError):
        message = None
    if error.code in (401, 403):
        return "Google Routes rejected the server API key or API configuration."
    if error.code == 429:
        return "Google Routes quota has been reached. Try again later."
    return message or "Google Routes could not calculate this journey."


def _public_status(google_status: int) -> int:
    if google_status == 429:
        return HTTPStatus.TOO_MANY_REQUESTS
    if 400 <= google_status < 500:
        return HTTPStatus.BAD_REQUEST
    return HTTPStatus.BAD_GATEWAY


def main() -> None:
    os.chdir(BASE_DIR)
    host = os.environ.get("BUS_MOOD_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("BUS_MOOD_PORT", "8000"))
    except ValueError as error:
        raise RuntimeError("BUS_MOOD_PORT must be an integer") from error
    if not 1 <= port <= 65535:
        raise RuntimeError("BUS_MOOD_PORT must be between 1 and 65535")

    server = ThreadingHTTPServer((host, port), BusMoodHandler)
    print(f"Bus Mood is running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
