const cities = {
  london: {
    name: "London",
    flag: "🇬🇧",
    zone: "Europe/London",
    stops: [["490005183E", "Balgonie Road", "Stop GA · Chingford · TfL buses"]],
    routes: ["24", "29", "176"],
    destinations: ["Hampstead Heath", "Wood Green", "Penge"],
  },
  berlin: {
    name: "Berlin",
    flag: "🇩🇪",
    zone: "Europe/Berlin",
    stops: [
      ["alex", "Alexanderplatz", "Illustrative stop · Berlin"],
      ["zoo", "Zoologischer Garten", "Illustrative stop · Berlin"],
    ],
    routes: ["100", "200", "M48"],
    destinations: ["Zoologischer Garten", "Potsdamer Platz", "Zehlendorf"],
  },
  newyork: {
    name: "New York",
    flag: "🇺🇸",
    zone: "America/New_York",
    stops: [
      ["times", "Times Square", "Illustrative stop · Manhattan"],
      ["union", "Union Square", "Illustrative stop · Manhattan"],
    ],
    routes: ["M7", "M20", "M104"],
    destinations: ["West Village", "South Ferry", "West Harlem"],
  },
  tokyo: {
    name: "Tokyo",
    flag: "🇯🇵",
    zone: "Asia/Tokyo",
    stops: [
      ["shibuya", "Shibuya Station", "Illustrative stop · Tokyo"],
      ["shinjuku", "Shinjuku Station", "Illustrative stop · Tokyo"],
    ],
    routes: ["01", "06", "58"],
    destinations: ["Shimbashi Station", "Shinjuku Station", "Waseda"],
  },
  istanbul: {
    name: "Istanbul",
    flag: "🇹🇷",
    zone: "Europe/Istanbul",
    stops: [
      ["taksim", "Taksim", "Illustrative stop · Istanbul"],
      ["besiktas", "Beşiktaş", "Illustrative stop · Istanbul"],
    ],
    routes: ["40T", "42T", "DT1"],
    destinations: ["İstinye", "Bahçeköy", "Ortaköy"],
  },
};
const $ = (id) => document.getElementById(id);
const state = {
  city: "london",
  demo: false,
  scenario: "late",
  walk: 5,
  rows: [],
  selected: null,
  loading: false,
  error: null,
  updated: 0,
  request: 0,
};
let controller;
function text(id, value) {
  $(id).textContent = value;
}
function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function cityTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: cities[state.city].zone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
function setCity(id) {
  if (!cities[id]) throw Error("Unknown city");
  state.city = id;
  state.demo = id !== "london";
  $("demo").checked = state.demo;
  $("demo").disabled = id !== "london";
  $("stop").innerHTML = cities[id].stops
    .map((s) => `<option value="${s[0]}">${s[1]}</option>`)
    .join("");
  renderCities();
  load();
}
function renderCities() {
  $("cities").innerHTML = Object.entries(cities)
    .map(
      ([id, c]) =>
        `<button data-city="${id}" class="${state.city === id ? "active" : ""}" aria-pressed="${state.city === id}">${c.flag} ${c.name}<span>${id === "london" ? "LIVE" : "DEMO"}</span></button>`,
    )
    .join("");
}
function makeDemo() {
  const c = cities[state.city],
    now = Date.now(),
    mins =
      state.scenario === "late"
        ? [18, 25, 34]
        : state.scenario === "early"
          ? [6, 15, 23]
          : [10, 19, 28];
  return mins.map((m, i) => ({
    id: "demo-" + i,
    line: c.routes[i],
    destination: c.destinations[i],
    arrival: now + m * 60000,
    delay: state.scenario === "late" ? 8 : state.scenario === "early" ? -3 : 0,
  }));
}
async function load() {
  const request = ++state.request;
  controller?.abort();
  controller = new AbortController();
  state.loading = true;
  state.error = null;
  state.rows = [];
  state.selected = null;
  render();
  try {
    if (state.demo) {
      state.rows = makeDemo();
    } else {
      const timeout = setTimeout(() => controller.abort(), 12000);
      let data;
      try {
        const response = await fetch(
          `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent($("stop").value)}/Arrivals`,
          { signal: controller.signal },
        );
        if (!response.ok) throw Error("Feed unavailable");
        data = await response.json();
      } finally {
        clearTimeout(timeout);
      }
      if (request !== state.request) return;
      if (!Array.isArray(data)) throw Error("Unexpected feed");
      state.rows = data
        .filter(
          (r) =>
            r.modeName === "bus" &&
            Number.isFinite(Date.parse(r.expectedArrival)),
        )
        .map((r) => ({
          id: r.id,
          line: r.lineName,
          destination:
            r.destinationName || r.towards || "Destination not supplied",
          arrival: Date.parse(r.expectedArrival),
          delay: null,
        }))
        .filter((r) => r.arrival > Date.now())
        .sort((a, b) => a.arrival - b.arrival)
        .slice(0, 6);
    }
    state.selected = state.rows[0]?.id;
    state.updated = Date.now();
  } catch (e) {
    if (request !== state.request) return;
    state.error =
      "We couldn’t reach TfL. Try refreshing, or switch on demo mode to take a look around.";
    state.rows = [];
  } finally {
    if (request === state.request) {
      state.loading = false;
      render();
    }
  }
}
function advice(row, now = Date.now()) {
  const minutes = (row.arrival - now) / 60000,
    left = minutes - state.walk - 1;
  if (minutes <= 0)
    return {
      title: "That ship has sailed.",
      copy: "Well, bus. Pick the next departure. There’s always another plot twist.",
      tag: "THIS PREDICTION HAS PASSED",
      symbol: "oops",
      className: "missed",
      leave: "Pick another",
    };
  if (left < 0)
    return {
      title: "This one’s a stretch.",
      copy: "Your walk is longer than the time left. The next bus is probably your better bet.",
      tag: "LET’S NOT MAKE THIS A CHASE SCENE",
      symbol: "…",
      className: "missed",
      leave: "Too tight",
    };
  if (left <= 2)
    return {
      title: "RUN! (Okay, walk.)",
      copy: "Shoes on. Phone away. Your bus is making an entrance. Please cross roads safely.",
      tag:
        row.delay < 0
          ? "EARLY BUS. MAIN CHARACTER ENERGY."
          : "THIS IS YOUR CUE",
      symbol: "!",
      className: "urgent",
      leave: "Now",
    };
  if (left > 8)
    return {
      title: "Keep snoozing.",
      copy:
        row.delay > 0
          ? "Your bus is fashionably late. You, however, can be comfortably horizontal."
          : "There’s time to finish your coffee. Your bus isn’t ready for you yet.",
      tag:
        row.delay > 0
          ? "YOUR BUS IS TAKING ITS SWEET TIME"
          : "YOU HAVE A LITTLE TIME",
      symbol: "z z",
      className: "",
      leave: Math.floor(left) + " min",
    };
  return {
    title: "Time to find your shoes.",
    copy: "A little breathing room. Wrap up what you’re doing and get ready to head out.",
    tag: "A RARE MOMENT OF GOOD TIMING",
    symbol: ":)",
    className: "",
    leave: Math.floor(left) + " min",
  };
}
function render() {
  const c = cities[state.city],
    row = state.rows.find((r) => r.id === state.selected);
  text("clock", cityTime(new Date()));
  text("timezone", c.name.toUpperCase() + " LOCAL TIME");
  text("walkValue", state.walk);
  text("stopDetail", c.stops.find((s) => s[0] === $("stop").value)?.[2] || "");
  $("scenarios").hidden = !state.demo;
  document.querySelectorAll("[data-scenario]").forEach((b) => {
    b.classList.toggle("active", b.dataset.scenario === state.scenario);
    b.setAttribute("aria-pressed", b.dataset.scenario === state.scenario);
  });
  $("refresh").disabled = state.loading;
  text(
    "sourceBadge",
    state.demo
      ? "DEMO DATA"
      : state.loading
        ? "CONNECTING"
        : state.error
          ? "FEED UNAVAILABLE"
          : "LIVE · TFL",
  );
  text(
    "updated",
    state.loading
      ? "Checking departures…"
      : state.demo
        ? "Fictional departures"
        : state.error
          ? "No live predictions"
          : `Updated ${cityTime(new Date(state.updated))}`,
  );
  const a = row
    ? advice(row)
    : {
        title: state.loading
          ? "One moment."
          : state.error
            ? "Your bus is off the grid."
            : "A quiet moment.",
        copy: state.loading
          ? "Asking your bus about its plans."
          : state.error ||
            "No upcoming bus predictions for this stop. Refresh in a moment.",
        tag: state.loading
          ? "LET’S CHECK ON YOUR BUS"
          : "NO DEPARTURE ADVICE AVAILABLE",
        symbol: "…",
        className: "unavailable",
        leave: "—",
      };
  $("moodCard").className = "mood-card " + a.className;
  text("moodTitle", a.title);
  text("moodCopy", a.copy);
  text("moodTag", a.tag);
  text("moodSymbol", a.symbol);
  text("leaveTime", a.leave);
  text("leaveLabel", a.leave === "Now" ? "LEAVE" : "LEAVE IN");
  text("selectedRoute", row ? `BUS ${row.line} · EXPECTED` : "YOUR NEXT RIDE");
  text("arrivalTime", row ? cityTime(new Date(row.arrival)) : "—");
  $("departures").innerHTML = state.rows.length
    ? state.rows
        .map((r) => {
          const min = Math.max(0, Math.ceil((r.arrival - Date.now()) / 60000));
          return `<button class="departure ${state.selected === r.id ? "selected" : ""}" data-ride="${escapeHTML(r.id)}" aria-pressed="${state.selected === r.id}"><span class="route">${escapeHTML(r.line)}</span><span class="route-info"><strong>${escapeHTML(r.destination)}</strong><small>${state.demo ? "Demo journey" : "Arrival prediction"} · ${cityTime(new Date(r.arrival))}</small></span><span class="eta"><strong>${min === 0 ? "Due" : min + " min"}</strong><small>${r.delay === null ? "TfL prediction" : r.delay > 0 ? "+" + r.delay + " min late" : r.delay < 0 ? Math.abs(r.delay) + " min early" : "On time"}</small></span></button>`;
        })
        .join("")
    : `<div class="empty">${state.loading ? "Looking down the road…" : state.error ? "Live arrivals unavailable. Refresh or try the demo switch." : "No arrivals to display right now."}</div>`;
  text(
    "dataNote",
    state.demo
      ? "Demo mode · Fictional routes, timings and delays for exploring the app. Not for travel planning."
      : `Powered by Transport for London open data · Refreshes every 30 sec. ${state.updated && Date.now() - state.updated > 60000 ? "Predictions may be stale. " : ""}Leave times include your ${state.walk} min walk + 1 min buffer.`,
  );
}
$("cities").addEventListener("click", (e) => {
  const b = e.target.closest("[data-city]");
  if (b) setCity(b.dataset.city);
});
$("stop").addEventListener("change", load);
$("walk").addEventListener("input", (e) => {
  state.walk = Number(e.target.value);
  render();
});
$("demo").addEventListener("change", (e) => {
  state.demo = e.target.checked;
  load();
});
$("scenarios").addEventListener("click", (e) => {
  const b = e.target.closest("[data-scenario]");
  if (b) {
    state.scenario = b.dataset.scenario;
    load();
  }
});
$("departures").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ride]");
  if (b) {
    state.selected = b.dataset.ride;
    render();
  }
});
$("refresh").addEventListener("click", load);
["aboutButton", "sourcesButton"].forEach((id) =>
  $(id).addEventListener("click", () => $("about").showModal()),
);
$("closeAbout").addEventListener("click", () => $("about").close());
$("about").addEventListener("click", (e) => {
  if (e.target === $("about")) {
    const r = $("about").getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      $("about").close();
  }
});
setInterval(() => {
  if (!document.hidden && !state.loading) render();
}, 10000);
setInterval(() => {
  if (!document.hidden && !state.demo && !state.loading) load();
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !state.demo && !state.loading) load();
});
setCity("london");
if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(
      document.modelContext.registerTool({
        name: "configure_bus_mood",
        description:
          "Choose a city and walking time, and load its departures. Cities other than London use demo data.",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", enum: Object.keys(cities) },
            walkingMinutes: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["city", "walkingMinutes"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (input) => {
          if (
            !cities[input.city] ||
            !Number.isInteger(input.walkingMinutes) ||
            input.walkingMinutes < 1 ||
            input.walkingMinutes > 20
          )
            throw Error("Invalid city or walking time");
          state.walk = input.walkingMinutes;
          $("walk").value = state.walk;
          state.city = input.city;
          state.demo = input.city !== "london";
          $("demo").checked = state.demo;
          $("demo").disabled = input.city !== "london";
          $("stop").innerHTML = cities[input.city].stops
            .map((s) => `<option value="${s[0]}">${s[1]}</option>`)
            .join("");
          renderCities();
          await load();
          return {
            city: state.city,
            demo: state.demo,
            walkingMinutes: state.walk,
            departures: state.rows.length,
            error: state.error,
          };
        },
      }),
    ).catch(() => {});
  } catch {}
}
