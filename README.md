# Bus Mood

Plain HTML, CSS and JavaScript. No build step or npm dependencies.

## Run locally

From this folder:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 in your browser.

London fetches TfL live bus arrival predictions for Balgonie Road (Stop GA). Other cities use labeled fictional demo data. Internet access is needed for live arrivals and optional Google Fonts.

Files: index.html (interface), style.css (styles), app.js (data and departure advice).

The uncertainty-aware scheduling idea discussed in chat is not implemented.
