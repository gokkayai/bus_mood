# Bus Mood

A probability-aware companion for live Berlin bus journeys. Bus Mood combines
realtime-aware VBB journey data with uncertain bus arrivals and walking times to
answer: how late can you leave while keeping your chance of catching the bus
above a chosen target?

The site is plain HTML, CSS and JavaScript. It has no build step, backend, API
key, billing account or runtime dependency.

## Run locally

ES modules require an HTTP server. From this folder, run:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Data and privacy

Journey and location data come from
[vbb.transport.rest](https://v6.vbb.transport.rest/), a community-operated,
unauthenticated interface for VBB data. Its documented limit is 100 requests per
minute with a burst limit of 200. Availability is controlled by that third
party.

Typed locations are sent directly from the browser to the service. Location
results are cached for 60 minutes and journeys for 30 seconds in
`sessionStorage`; entries disappear when the browser session ends. Journey
results up to two minutes old may be shown, clearly labeled, if a refresh fails.

## Uncertainty-aware scheduling

`uncertainty_schedule.py` is the dependency-free Python reference model. The
browser uses the equivalent implementation in `transit.js`. Both model the bus
arrival `B` and walking duration `W` as jointly normal variables and calculate
the lower-tail quantile of `B - W`.

```python
from datetime import datetime, timedelta, timezone

from uncertainty_schedule import latest_safe_departure

plan = latest_safe_departure(
    datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc),
    timedelta(minutes=5),
    bus_standard_deviation=timedelta(minutes=2),
    walk_standard_deviation=timedelta(minutes=1),
    confidence=0.95,
)
```

## Tests

```bash
npm test
python3 -m unittest -v
```

The Node tests cover VBB request encoding, journey normalization, cache expiry,
stale fallback, request deduplication, and parity with the Python uncertainty
calculation.

## Deploy

The GitHub Actions workflow deploys the repository to GitHub Pages whenever
`main` is updated. In the repository settings, set **Pages → Source** to
**GitHub Actions**. No repository secrets are required.

Data attribution: Verkehrsverbund Berlin-Brandenburg (VBB). This project is not
affiliated with VBB or transport.rest.
