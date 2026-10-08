import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_LIMITS,
  SessionCache,
  VbbClient,
  buildJourneyParameters,
  normalizeJourneys,
  uncertaintyMarginMinutes,
} from "./transit.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const alexanderplatz = {
  type: "stop",
  id: "900100003",
  name: "S+U Alexanderplatz",
  latitude: 52.521508,
  longitude: 13.411267,
};

const address = {
  type: "location",
  id: null,
  name: "Zoologischer Garten",
  address: "Hardenbergplatz, Berlin",
  latitude: 52.5069,
  longitude: 13.3327,
};

test("journey parameters encode stop IDs, addresses, and bus-only filters", () => {
  const parameters = buildJourneyParameters(alexanderplatz, address);

  assert.equal(parameters.get("from"), "900100003");
  assert.equal(parameters.get("to.address"), "Hardenbergplatz, Berlin");
  assert.equal(parameters.get("to.latitude"), "52.5069");
  assert.equal(parameters.get("bus"), "true");
  assert.equal(parameters.get("subway"), "false");
  assert.match(parameters.toString(), /Hardenbergplatz%2C\+Berlin/);
});

test("journeys normalize realtime and scheduled bus legs", () => {
  const payload = {
    journeys: [
      {
        refreshToken: "real",
        legs: [
          {
            walking: true,
            departure: "2026-10-08T08:50:00+02:00",
            arrival: "2026-10-08T08:55:00+02:00",
          },
          {
            tripId: "trip-100",
            line: { name: "100", product: "bus" },
            direction: "Zoologischer Garten",
            origin: { name: "Alexanderplatz" },
            destination: { name: "Breitscheidplatz" },
            plannedDeparture: "2026-10-08T08:56:00+02:00",
            departure: "2026-10-08T08:58:00+02:00",
            departureDelay: 120,
            arrival: "2026-10-08T09:20:00+02:00",
          },
        ],
      },
      {
        refreshToken: "scheduled",
        legs: [
          {
            line: { name: "200", mode: "bus" },
            direction: "Zoo",
            origin: { name: "Alexanderplatz" },
            destination: { name: "Zoologischer Garten" },
            departure: "2026-10-08T09:10:00+02:00",
            plannedDeparture: "2026-10-08T09:10:00+02:00",
            departureDelay: null,
            arrival: "2026-10-08T09:35:00+02:00",
          },
        ],
      },
    ],
  };

  const rows = normalizeJourneys(payload);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].line, "100");
  assert.equal(rows[0].walkingMinutes, 5);
  assert.equal(rows[0].delayMinutes, 2);
  assert.equal(rows[0].realtime, true);
  assert.equal(rows[1].realtime, false);
});

test("session cache expires values and evicts the oldest entry", () => {
  let now = 0;
  const cache = new SessionCache(new MemoryStorage(), "test", 2, () => now);
  cache.set("first", 1);
  now += 1;
  cache.set("second", 2);
  now += 1;
  cache.set("third", 3);

  assert.equal(cache.get("first", 100), null);
  assert.equal(cache.get("second", 100).value, 2);
  now = 200;
  assert.equal(cache.get("second", 100), null);
});

test("journey requests use stale cache for a temporary API failure", async () => {
  let now = 0;
  let shouldFail = false;
  const storage = new MemoryStorage();
  const payload = { journeys: [] };
  const client = new VbbClient({
    storage,
    now: () => now,
    fetchFn: async () => {
      if (shouldFail) throw new Error("offline");
      return { ok: true, json: async () => payload };
    },
  });

  const first = await client.journeys(alexanderplatz, address);
  assert.equal(first.source, "network");

  now = CACHE_LIMITS.journeyTtlMs + 1;
  shouldFail = true;
  const stale = await client.journeys(alexanderplatz, address);
  assert.equal(stale.source, "stale");
  assert.deepEqual(stale.payload, payload);
});

test("identical in-flight location requests are deduplicated", async () => {
  let calls = 0;
  let resolveRequest;
  const response = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const client = new VbbClient({
    storage: new MemoryStorage(),
    fetchFn: () => {
      calls += 1;
      return response;
    },
  });

  const left = client.searchLocations("Alexanderplatz");
  const right = client.searchLocations("Alexanderplatz");
  resolveRequest({ ok: true, json: async () => [] });

  await Promise.all([left, right]);
  assert.equal(calls, 1);
});

test("the default browser fetch keeps its global invocation context", async () => {
  const originalFetch = globalThis.fetch;
  let receivedContext;
  globalThis.fetch = function () {
    receivedContext = this;
    return Promise.resolve({ ok: true, json: async () => [] });
  };

  try {
    const client = new VbbClient({ storage: new MemoryStorage() });
    await client.searchLocations("Alexanderplatz");
    assert.equal(receivedContext, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JavaScript uncertainty margin matches the Python reference case", () => {
  const margin = uncertaintyMarginMinutes(0.95, 2, 1);
  assert.ok(Math.abs(margin - 3.678004516666667) < 1e-8);
});
