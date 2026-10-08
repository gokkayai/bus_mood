export const VBB_API_BASE = "https://v6.vbb.transport.rest";

export const CACHE_LIMITS = Object.freeze({
  locationTtlMs: 60 * 60 * 1000,
  journeyTtlMs: 30 * 1000,
  journeyStaleMs: 2 * 60 * 1000,
  maxLocations: 50,
  maxJourneys: 20,
});

const CONFIDENCE_QUANTILES = Object.freeze({
  0.9: 1.2815515655446004,
  0.95: 1.6448536269514722,
  0.99: 2.3263478740408408,
});

export class SessionCache {
  constructor(storage, namespace, maxEntries, now = () => Date.now()) {
    this.storage = storage;
    this.key = `bus-mood:${namespace}`;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key, freshForMs, staleForMs = freshForMs) {
    const entries = this.#read();
    const entry = entries[key];
    if (!entry) return null;

    const ageMs = Math.max(0, this.now() - entry.storedAt);
    if (ageMs > staleForMs) {
      delete entries[key];
      this.#write(entries);
      return null;
    }
    return { value: entry.value, ageMs, stale: ageMs > freshForMs };
  }

  set(key, value) {
    const entries = this.#read();
    entries[key] = { value, storedAt: this.now() };
    const ordered = Object.entries(entries).sort(
      ([, left], [, right]) => left.storedAt - right.storedAt,
    );
    while (ordered.length > this.maxEntries) {
      const [oldestKey] = ordered.shift();
      delete entries[oldestKey];
    }
    this.#write(entries);
  }

  #read() {
    try {
      const value = JSON.parse(this.storage?.getItem(this.key) || "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }

  #write(entries) {
    try {
      this.storage?.setItem(this.key, JSON.stringify(entries));
    } catch {
      // A full or unavailable sessionStorage should not break journey planning.
    }
  }
}

export class VbbClient {
  constructor({
    fetchFn = globalThis.fetch?.bind(globalThis),
    storage = globalThis.sessionStorage,
    now = () => Date.now(),
    baseUrl = VBB_API_BASE,
  } = {}) {
    this.fetchFn = fetchFn;
    this.now = now;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.inflight = new Map();
    this.locationCache = new SessionCache(
      storage,
      "locations",
      CACHE_LIMITS.maxLocations,
      now,
    );
    this.journeyCache = new SessionCache(
      storage,
      "journeys",
      CACHE_LIMITS.maxJourneys,
      now,
    );
  }

  async searchLocations(query, { signal } = {}) {
    const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");
    if (normalizedQuery.length < 3) return [];

    const cached = this.locationCache.get(
      normalizedQuery,
      CACHE_LIMITS.locationTtlMs,
    );
    if (cached) return cached.value;

    const parameters = new URLSearchParams({
      query: query.trim(),
      results: "5",
      stops: "true",
      addresses: "true",
      poi: "true",
      linesOfStops: "false",
      language: "en",
      pretty: "false",
    });
    const payload = await this.#requestJson(
      `${this.baseUrl}/locations?${parameters}`,
      signal,
    );
    const locations = Array.isArray(payload)
      ? payload.map(normalizeLocation).filter(Boolean)
      : [];
    this.locationCache.set(normalizedQuery, locations);
    return locations;
  }

  async journeys(origin, destination, { signal } = {}) {
    const parameters = buildJourneyParameters(origin, destination);
    const cacheKey = parameters.toString();
    const cached = this.journeyCache.get(
      cacheKey,
      CACHE_LIMITS.journeyTtlMs,
      CACHE_LIMITS.journeyStaleMs,
    );
    if (cached && !cached.stale) {
      return { payload: cached.value, source: "cache", ageMs: cached.ageMs };
    }

    try {
      const payload = await this.#requestJson(
        `${this.baseUrl}/journeys?${parameters}`,
        signal,
      );
      this.journeyCache.set(cacheKey, payload);
      return { payload, source: "network", ageMs: 0 };
    } catch (error) {
      if (error.name === "AbortError" || !cached) throw error;
      return {
        payload: cached.value,
        source: "stale",
        ageMs: cached.ageMs,
        warning: error.message,
      };
    }
  }

  #requestJson(url, signal) {
    if (this.inflight.has(url)) return this.inflight.get(url);

    const request = this.fetchFn(url, {
      headers: { Accept: "application/json" },
      signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 429) {
            throw new Error(
              "The Berlin data service is receiving too many requests",
            );
          }
          throw new Error(
            `The Berlin data service returned ${response.status}`,
          );
        }
        return response.json();
      })
      .finally(() => this.inflight.delete(url));

    this.inflight.set(url, request);
    return request;
  }
}

export function normalizeLocation(location) {
  const latitude = Number(location?.location?.latitude ?? location?.latitude);
  const longitude = Number(
    location?.location?.longitude ?? location?.longitude,
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const type = location.type || "location";
  return {
    type,
    id: location.id || null,
    name: location.name || location.address || "Unnamed location",
    address: location.address || location.name || "",
    latitude,
    longitude,
  };
}

export function appendWaypoint(parameters, prefix, location) {
  if (
    (location.type === "stop" || location.type === "station") &&
    location.id
  ) {
    parameters.set(prefix, location.id);
    return;
  }

  parameters.set(`${prefix}.latitude`, String(location.latitude));
  parameters.set(`${prefix}.longitude`, String(location.longitude));
  if (location.type === "poi") {
    if (location.id) parameters.set(`${prefix}.id`, location.id);
    parameters.set(`${prefix}.name`, location.name);
  } else {
    parameters.set(`${prefix}.address`, location.address || location.name);
  }
}

export function buildJourneyParameters(origin, destination) {
  const parameters = new URLSearchParams({
    results: "4",
    stopovers: "false",
    remarks: "true",
    language: "en",
    pretty: "false",
    bus: "true",
    suburban: "false",
    subway: "false",
    tram: "false",
    ferry: "false",
    express: "false",
    regional: "false",
  });
  appendWaypoint(parameters, "from", origin);
  appendWaypoint(parameters, "to", destination);
  return parameters;
}

export function normalizeJourneys(payload) {
  if (!Array.isArray(payload?.journeys)) return [];

  return payload.journeys.flatMap((journey, journeyIndex) => {
    const legs = Array.isArray(journey.legs) ? journey.legs : [];
    const busIndex = legs.findIndex(
      (leg) => leg?.line?.product === "bus" || leg?.line?.mode === "bus",
    );
    if (busIndex < 0) return [];

    const busLeg = legs[busIndex];
    const departure = Date.parse(busLeg.departure);
    const plannedDeparture = Date.parse(
      busLeg.plannedDeparture || busLeg.departure,
    );
    if (!Number.isFinite(departure)) return [];

    const walkingSeconds = legs
      .slice(0, busIndex)
      .filter((leg) => leg.walking || leg.mode === "walking")
      .reduce((total, leg) => total + legDurationSeconds(leg), 0);
    const firstDeparture = Date.parse(legs[0]?.departure);
    const finalArrival = Date.parse(legs.at(-1)?.arrival);
    const durationSeconds =
      Number.isFinite(firstDeparture) && Number.isFinite(finalArrival)
        ? Math.max(0, (finalArrival - firstDeparture) / 1000)
        : legDurationSeconds(busLeg);
    const explicitDelay = Number(busLeg.departureDelay);
    const delaySeconds = Number.isFinite(explicitDelay)
      ? explicitDelay
      : Number.isFinite(plannedDeparture)
        ? (departure - plannedDeparture) / 1000
        : null;
    const realtime =
      busLeg.departureDelay !== null &&
      busLeg.departureDelay !== undefined &&
      Number.isFinite(delaySeconds);

    return [
      {
        id:
          busLeg.tripId ||
          journey.refreshToken ||
          `journey-${journeyIndex}-${busLeg.departure}`,
        line: busLeg.line?.name || "Bus",
        destination:
          busLeg.direction || busLeg.destination?.name || "Destination",
        departureStop: busLeg.origin?.name || "Bus stop",
        arrivalStop: busLeg.destination?.name || "Destination",
        departureTime: busLeg.departure,
        plannedTime: busLeg.plannedDeparture || busLeg.departure,
        arrival: departure,
        delayMinutes:
          delaySeconds === null ? null : Math.round(delaySeconds / 60),
        walkingMinutes: Math.round((walkingSeconds / 60) * 10) / 10,
        durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
        realtime,
      },
    ];
  });
}

export function uncertaintyMarginMinutes(
  confidence,
  busUncertainty,
  walkUncertainty,
) {
  const quantile = CONFIDENCE_QUANTILES[confidence];
  if (!quantile) throw new Error("Unsupported confidence target");
  return quantile * Math.hypot(busUncertainty, walkUncertainty);
}

export function latestSafeDeparture(
  arrivalTimestamp,
  walkingMinutes,
  confidence,
  busUncertainty,
  walkUncertainty,
) {
  return (
    arrivalTimestamp -
    (walkingMinutes +
      uncertaintyMarginMinutes(confidence, busUncertainty, walkUncertainty)) *
      60_000
  );
}

function legDurationSeconds(leg) {
  const departure = Date.parse(leg?.departure);
  const arrival = Date.parse(leg?.arrival);
  return Number.isFinite(departure) && Number.isFinite(arrival)
    ? Math.max(0, (arrival - departure) / 1000)
    : 0;
}
