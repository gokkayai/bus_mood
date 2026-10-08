import {
  VbbClient,
  latestSafeDeparture,
  normalizeJourneys,
  uncertaintyMarginMinutes,
} from "./transit.js";

const BERLIN_ZONE = "Europe/Berlin";
const DEFAULT_LOCATIONS = {
  origin: {
    type: "stop",
    id: "900100003",
    name: "S+U Alexanderplatz",
    latitude: 52.521508,
    longitude: 13.411267,
  },
  destination: {
    type: "stop",
    id: "900023201",
    name: "S+U Zoologischer Garten",
    latitude: 52.507,
    longitude: 13.3327,
  },
};

const $ = (id) => document.getElementById(id);
const client = new VbbClient();
const state = {
  demo: false,
  scenario: "late",
  walk: 5,
  confidence: 0.95,
  busUncertainty: 2,
  walkUncertainty: 1,
  rows: [],
  selected: null,
  loading: false,
  error: null,
  warning: null,
  updated: 0,
  cacheSource: null,
  cacheAgeMs: 0,
  request: 0,
  locations: structuredClone(DEFAULT_LOCATIONS),
  suggestions: { origin: [], destination: [] },
};

let journeyController;
const autocomplete = {
  origin: { timer: null, controller: null, activeIndex: -1 },
  destination: { timer: null, controller: null, activeIndex: -1 },
};

function text(id, value) {
  $(id).textContent = value;
}

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function berlinTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function uncertaintyMargin() {
  return uncertaintyMarginMinutes(
    state.confidence,
    state.busUncertainty,
    state.walkUncertainty,
  );
}

function safeDeparture(row) {
  return latestSafeDeparture(
    row.arrival,
    state.walk,
    state.confidence,
    state.busUncertainty,
    state.walkUncertainty,
  );
}

function makeDemo() {
  const now = Date.now();
  const minutes =
    state.scenario === "late"
      ? [18, 25, 34]
      : state.scenario === "early"
        ? [6, 15, 23]
        : [10, 19, 28];
  const routes = ["100", "200", "M29"];
  const destinations = [
    "Zoologischer Garten",
    "Michelangelostraße",
    "Grunewald, Roseneck",
  ];

  return minutes.map((minute, index) => ({
    id: `demo-${index}`,
    line: routes[index],
    destination: destinations[index],
    departureStop: "S+U Alexanderplatz",
    arrivalStop: destinations[index],
    arrival: now + minute * 60_000,
    departureTime: new Date(now + minute * 60_000).toISOString(),
    plannedTime: new Date(now + minute * 60_000).toISOString(),
    delayMinutes:
      state.scenario === "late" ? 8 : state.scenario === "early" ? -3 : 0,
    walkingMinutes: 5,
    durationMinutes: 26 + index * 4,
    realtime: true,
  }));
}

async function load() {
  const request = ++state.request;
  journeyController?.abort();
  journeyController = new AbortController();
  state.loading = true;
  state.error = null;
  state.warning = null;
  state.rows = [];
  state.selected = null;
  render();

  try {
    if (state.demo) {
      state.rows = makeDemo();
      state.cacheSource = "demo";
      state.cacheAgeMs = 0;
    } else {
      if (!state.locations.origin || !state.locations.destination) {
        throw new Error(
          "Choose a suggestion for both the starting point and destination",
        );
      }
      const result = await client.journeys(
        state.locations.origin,
        state.locations.destination,
        { signal: journeyController.signal },
      );
      if (request !== state.request) return;
      state.rows = normalizeJourneys(result.payload)
        .filter((row) => row.arrival > Date.now())
        .sort((left, right) => left.arrival - right.arrival)
        .slice(0, 4);
      if (!state.rows.length) {
        throw new Error("No upcoming bus-only journeys were found");
      }
      state.cacheSource = result.source;
      state.cacheAgeMs = result.ageMs;
      state.warning = result.warning || null;
    }

    state.selected = state.rows[0]?.id;
    useRouteWalkingTime(state.rows[0]);
    state.updated = Date.now();
  } catch (error) {
    if (request !== state.request || error.name === "AbortError") return;
    state.error = `${error.message}. Try again or switch on demo data.`;
    state.rows = [];
  } finally {
    if (request === state.request) {
      state.loading = false;
      render();
    }
  }
}

function useRouteWalkingTime(row) {
  if (!Number.isFinite(row?.walkingMinutes)) return;
  state.walk = Math.min(30, Math.max(0, Math.ceil(row.walkingMinutes)));
  $("walk").value = state.walk;
}

function advice(row, now = Date.now()) {
  const minutes = (row.arrival - now) / 60_000;
  const timeUntilSafeDeparture = (safeDeparture(row) - now) / 60_000;
  if (minutes <= 0) {
    return {
      title: "That ship has sailed.",
      copy: "Well, bus. Pick the next journey. There’s always another plot twist.",
      tag: "THIS DEPARTURE HAS PASSED",
      symbol: "oops",
      className: "missed",
      leave: "Pick another",
    };
  }
  if (timeUntilSafeDeparture < 0) {
    return {
      title: "This one’s a stretch.",
      copy: "Your walk and safety margin need more time. The next bus is probably the better bet.",
      tag: "LET’S NOT MAKE THIS A CHASE SCENE",
      symbol: "…",
      className: "missed",
      leave: "Too tight",
    };
  }
  if (timeUntilSafeDeparture <= 2) {
    return {
      title: "RUN! (Okay, walk.)",
      copy: "Shoes on. Phone away. Your bus is making an entrance. Please cross roads safely.",
      tag:
        row.delayMinutes < 0
          ? "EARLY BUS. MAIN CHARACTER ENERGY."
          : "THIS IS YOUR CUE",
      symbol: "!",
      className: "urgent",
      leave: "Now",
    };
  }
  if (timeUntilSafeDeparture > 8) {
    return {
      title: "Keep snoozing.",
      copy:
        row.delayMinutes > 0
          ? "Your bus is fashionably late. You can be comfortably horizontal."
          : "There’s time to finish your coffee. Your bus isn’t ready for you yet.",
      tag:
        row.delayMinutes > 0
          ? "YOUR BUS IS TAKING ITS SWEET TIME"
          : "YOU HAVE A LITTLE TIME",
      symbol: "z z",
      className: "",
      leave: `${Math.floor(timeUntilSafeDeparture)} min`,
    };
  }
  return {
    title: "Time to find your shoes.",
    copy: "A little breathing room. Wrap up what you’re doing and get ready to head out.",
    tag: "A RARE MOMENT OF GOOD TIMING",
    symbol: ":)",
    className: "",
    leave: `${Math.floor(timeUntilSafeDeparture)} min`,
  };
}

function sourceLabel() {
  if (state.demo) return "DEMO DATA";
  if (state.loading) return "CONNECTING";
  if (state.error) return "DATA UNAVAILABLE";
  if (state.cacheSource === "stale") return "STALE CACHE · VBB";
  if (state.cacheSource === "cache") return "CACHED · VBB";
  return "VBB · COMMUNITY API";
}

function updatedLabel() {
  if (state.loading) return "Checking Berlin journeys…";
  if (state.error) return "No journey data";
  if (state.demo) return "Fictional departures";
  if (state.cacheSource === "stale") {
    return `Cached ${Math.ceil(state.cacheAgeMs / 1000)} sec ago`;
  }
  if (state.cacheSource === "cache") {
    return `Reused ${Math.ceil(state.cacheAgeMs / 1000)} sec cache`;
  }
  return `Updated ${berlinTime(new Date(state.updated))}`;
}

function render() {
  const row = state.rows.find((item) => item.id === state.selected);
  text("clock", berlinTime(new Date()));
  text("walkValue", state.walk);
  text("busUncertaintyValue", state.busUncertainty);
  text("walkUncertaintyValue", state.walkUncertainty);
  text("confidenceBadge", `${Math.round(state.confidence * 100)}%`);
  text(
    "probabilitySummary",
    `Adds a ${uncertaintyMargin().toFixed(1)} min uncertainty margin to your ${state.walk} min walk.`,
  );
  $("scenarios").hidden = !state.demo;
  document.querySelectorAll("[data-scenario]").forEach((button) => {
    const active = button.dataset.scenario === state.scenario;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
  });
  $("refresh").disabled = state.loading;
  $("planTrip").disabled = state.loading;
  text("sourceBadge", sourceLabel());
  text("updated", updatedLabel());

  const mood = row
    ? advice(row)
    : {
        title: state.loading
          ? "One moment."
          : state.error
            ? "Berlin is off the grid."
            : "A quiet moment.",
        copy: state.loading
          ? "Asking Berlin about its bus plans."
          : state.error || "No upcoming bus journeys to display.",
        tag: state.loading
          ? "LET’S CHECK ON YOUR BUS"
          : "NO DEPARTURE ADVICE AVAILABLE",
        symbol: "…",
        className: "unavailable",
        leave: "—",
      };

  $("moodCard").className = `mood-card ${mood.className}`;
  text("moodTitle", mood.title);
  text("moodCopy", mood.copy);
  text("moodTag", mood.tag);
  text("moodSymbol", mood.symbol);
  text("leaveTime", mood.leave);
  text("leaveLabel", mood.leave === "Now" ? "LEAVE" : "LEAVE IN");
  text(
    "confidenceResult",
    `${Math.round(state.confidence * 100)}% CATCH TARGET`,
  );
  text(
    "marginResult",
    row
      ? `${uncertaintyMargin().toFixed(1)} MIN UNCERTAINTY MARGIN · LEAVE BY ${berlinTime(new Date(safeDeparture(row)))}`
      : `${uncertaintyMargin().toFixed(1)} MIN UNCERTAINTY MARGIN`,
  );
  text(
    "selectedRoute",
    row
      ? `BUS ${row.line} · ${row.realtime ? "REALTIME" : "SCHEDULED"}`
      : "YOUR NEXT RIDE",
  );
  text("arrivalTime", row ? berlinTime(new Date(row.arrival)) : "—");

  $("departures").innerHTML = state.rows.length
    ? state.rows
        .map((departure) => {
          const minutes = Math.max(
            0,
            Math.ceil((departure.arrival - Date.now()) / 60_000),
          );
          const timing = departure.realtime
            ? departure.delayMinutes > 0
              ? `Live · +${departure.delayMinutes} min`
              : departure.delayMinutes < 0
                ? `Live · ${Math.abs(departure.delayMinutes)} min early`
                : "Live · on time"
            : "Scheduled time";
          return `<button class="departure ${state.selected === departure.id ? "selected" : ""}" data-ride="${escapeHTML(departure.id)}" aria-pressed="${state.selected === departure.id}"><span class="route">${escapeHTML(departure.line)}</span><span class="route-info"><strong>${escapeHTML(departure.destination)}</strong><small>${escapeHTML(departure.departureStop)} · ${berlinTime(new Date(departure.arrival))}</small></span><span class="eta"><strong>${minutes === 0 ? "Due" : `${minutes} min`}</strong><small>${timing}</small></span></button>`;
        })
        .join("")
    : `<div class="empty">${state.loading ? "Looking down the road…" : state.error ? "Berlin journey data is unavailable. Retry or use demo data." : "No journeys to display right now."}</div>`;

  const cacheNotice =
    state.cacheSource === "stale"
      ? ` Showing ${Math.ceil(state.cacheAgeMs / 1000)}-second-old cached results because the live service failed.`
      : state.cacheSource === "cache"
        ? " Reused a recent response to reduce API traffic."
        : "";
  $("dataNote").innerHTML = state.demo
    ? `Demo mode · Fictional routes and timings. The ${Math.round(state.confidence * 100)}% plan uses a ${uncertaintyMargin().toFixed(1)} min uncertainty margin. Not for travel planning.`
    : `Journey data via <a href="https://v6.vbb.transport.rest/" target="_blank" rel="noopener">vbb.transport.rest</a>, a community-operated interface for VBB data. Times may be realtime or scheduled.${cacheNotice}`;
}

function renderSuggestions(field, message = "") {
  const input = $(field);
  const list = $(`${field}Suggestions`);
  const suggestions = state.suggestions[field];
  autocomplete[field].activeIndex = -1;
  if (message) {
    list.innerHTML = `<p class="suggestion-message">${escapeHTML(message)}</p>`;
  } else {
    list.innerHTML = suggestions
      .map(
        (location, index) =>
          `<button type="button" role="option" aria-selected="false" data-location-index="${index}"><strong>${escapeHTML(location.name)}</strong><small>${escapeHTML(location.type)}</small></button>`,
      )
      .join("");
  }
  const visible = Boolean(message || suggestions.length);
  list.hidden = !visible;
  input.setAttribute("aria-expanded", String(visible));
}

function selectLocation(field, location) {
  state.locations[field] = location;
  $(field).value = location.name;
  $(field).removeAttribute("aria-invalid");
  state.suggestions[field] = [];
  renderSuggestions(field);
}

function setupAutocomplete(field) {
  const input = $(field);
  const list = $(`${field}Suggestions`);
  const controls = autocomplete[field];

  input.addEventListener("input", () => {
    state.locations[field] = null;
    input.removeAttribute("aria-invalid");
    clearTimeout(controls.timer);
    controls.controller?.abort();
    const query = input.value.trim();
    if (query.length < 3) {
      state.suggestions[field] = [];
      renderSuggestions(field);
      return;
    }
    controls.timer = setTimeout(async () => {
      controls.controller = new AbortController();
      renderSuggestions(field, "Searching Berlin…");
      try {
        state.suggestions[field] = await client.searchLocations(query, {
          signal: controls.controller.signal,
        });
        renderSuggestions(
          field,
          state.suggestions[field].length ? "" : "No matching place found",
        );
      } catch (error) {
        if (error.name !== "AbortError") {
          state.suggestions[field] = [];
          renderSuggestions(field, "Location search is unavailable");
        }
      }
    }, 300);
  });

  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-location-index]");
    if (!option) return;
    selectLocation(
      field,
      state.suggestions[field][Number(option.dataset.locationIndex)],
    );
  });

  input.addEventListener("keydown", (event) => {
    const options = [...list.querySelectorAll("[role=option]")];
    if (event.key === "Escape") {
      state.suggestions[field] = [];
      renderSuggestions(field);
      return;
    }
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      options.length
    ) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      controls.activeIndex =
        (controls.activeIndex + step + options.length) % options.length;
      options.forEach((option, index) => {
        const active = index === controls.activeIndex;
        option.setAttribute("aria-selected", String(active));
        option.classList.toggle("active", active);
      });
      options[controls.activeIndex].scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (
        controls.activeIndex >= 0 &&
        state.suggestions[field][controls.activeIndex]
      ) {
        selectLocation(field, state.suggestions[field][controls.activeIndex]);
      } else if (state.locations.origin && state.locations.destination) {
        load();
      }
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      state.suggestions[field] = [];
      renderSuggestions(field);
    }, 150);
  });
}

$("origin").value = DEFAULT_LOCATIONS.origin.name;
$("destination").value = DEFAULT_LOCATIONS.destination.name;
setupAutocomplete("origin");
setupAutocomplete("destination");

$("planTrip").addEventListener("click", () => {
  ["origin", "destination"].forEach((field) => {
    if (!state.locations[field]) $(field).setAttribute("aria-invalid", "true");
  });
  load();
});
$("walk").addEventListener("input", (event) => {
  state.walk = Number(event.target.value);
  render();
});
$("confidence").addEventListener("change", (event) => {
  state.confidence = Number(event.target.value);
  render();
});
$("busUncertainty").addEventListener("input", (event) => {
  state.busUncertainty = Number(event.target.value);
  render();
});
$("walkUncertainty").addEventListener("input", (event) => {
  state.walkUncertainty = Number(event.target.value);
  render();
});
$("demo").addEventListener("change", (event) => {
  state.demo = event.target.checked;
  load();
});
$("scenarios").addEventListener("click", (event) => {
  const button = event.target.closest("[data-scenario]");
  if (button) {
    state.scenario = button.dataset.scenario;
    load();
  }
});
$("departures").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ride]");
  if (button) {
    state.selected = button.dataset.ride;
    useRouteWalkingTime(state.rows.find((row) => row.id === state.selected));
    render();
  }
});
$("refresh").addEventListener("click", load);
["aboutButton", "sourcesButton"].forEach((id) =>
  $(id).addEventListener("click", () => $("about").showModal()),
);
$("closeAbout").addEventListener("click", () => $("about").close());
$("about").addEventListener("click", (event) => {
  if (event.target === $("about")) {
    const rectangle = $("about").getBoundingClientRect();
    if (
      event.clientX < rectangle.left ||
      event.clientX > rectangle.right ||
      event.clientY < rectangle.top ||
      event.clientY > rectangle.bottom
    ) {
      $("about").close();
    }
  }
});

setInterval(() => {
  if (!document.hidden && !state.loading) render();
}, 10_000);
setInterval(() => {
  if (!document.hidden && !state.demo && !state.loading) load();
}, 60_000);

load();
