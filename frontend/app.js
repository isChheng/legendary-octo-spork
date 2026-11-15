import { createGlobe } from "./globe.js";
import { enhanceSelect } from "./choice-menu.js";
import { mapDetail } from "./map-detail.js";
import { seasonalMannKendall } from "./trend.js";
import config from "./config.js";
import { createData } from "./data.js";

const $ = (id) => document.getElementById(id);
const closeMenus = [
  enhanceSelect($("region")),
  enhanceSelect($("dataset")),
  enhanceSelect($("period-month"), { fixedCaption: true, alignEnd: true }),
  enhanceSelect($("period-year"), { fixedCaption: true, alignEnd: true, searchLabel: "Search years" }),
];
const regions = {
  cambodia: [10.35, 14.8, 102.3, 107.75],
  seasia: [-12, 29, 92, 143],
  global: [-90, 90, -180, 180],
  amazon: [-21, 9, -80, -44],
  africa: [-36, 10, 9, 52],
};
const datasets = { modis: "MODIS", viirs_noaa20: "VIIRS NOAA-20", viirs_snpp: "VIIRS Suomi NPP" };
const platformNames = { aqua: "Aqua", terra: "Terra", noaa20: "NOAA-20", snpp: "Suomi NPP" };
const monthFormat = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
const monthLabel = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
const formatter = new Intl.NumberFormat("en");
const format = (value) => formatter.format(value);
const dates = (period) => {
  const [year, month] = period.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first, days, start: `${period}-01`, end: `${period}-${days}` };
};
const dayFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const weekdayFormat = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
const isoDay = (period, number) => `${period}-${String(number).padStart(2, "0")}`;
// Monday-based position of the first of the month, used to group days into calendar weeks.
const weekOffset = (first) => (first.getUTCDay() + 6) % 7;
const monthNames = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2020, i, 1))),
);

let coverage = [];
let monthCoverage = new Map();
let harmonizing = false;
let areaLabel;
// Selected UTC days of the visible month, sorted. Empty means the whole month.
let selected = [];
let mode = "day";
let rangeAnchor = null;
let calendar = [];
let historyRows = [];
let selectionRequest;
let mapRequest;
let exportRequest;
let mapTimer;
let mapKey;
const mapCache = new Map();
let historyRequest;
let customBounds = asBounds(regions.cambodia);
let view = "explore";
let selectedPeriod = "2025-02";
let firstPeriod;
let lastPeriod;

function asBounds([min_lat, max_lat, min_lon, max_lon]) {
  return { min_lat, max_lat, min_lon, max_lon };
}

function bounds() {
  return $("region").value === "custom" ? customBounds : asBounds(regions[$("region").value]);
}

function areaName() {
  return $("region").selectedOptions[0].textContent;
}

function selectedDatasets() {
  return $("dataset").value ? [$("dataset").value] : [...new Set(coverage.map((row) => row.dataset))];
}

// With a data folder configured the browser answers every request itself.
// `?data=/path` points one visit at a folder on this site, for testing.
const dataOverride = new URLSearchParams(location.search).get("data");
const dataUrl = /^\/(?!\/)/.test(dataOverride ?? "") ? dataOverride : config.dataUrl;
const localData = dataUrl ? createData(dataUrl) : null;

async function api(path, params, signal) {
  if (path === "/map-config") {
    if (localData || config.googleMapsKey) return { googleMapsKey: config.googleMapsKey || null };
  } else if (localData) return localData(path, params, signal);
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(path + query, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`);
  }
  return response.json();
}

function status(message, state) {
  $("api-status").textContent = message;
  $("api-status").dataset.state = state;
}

function coordinate(value, negative, positive, digits = 1) {
  return `${Math.abs(value).toFixed(digits)}° ${value < 0 ? negative : positive}`;
}

function showCoordinates(lat, lon) {
  $("map-coordinates").textContent = `${coordinate(lat, "S", "N")} · ${coordinate(lon, "W", "E")}`;
}

let googleGlobe;
let mapLibre;
let flatMap = false;
let satellite = false;
let googleLoad;
let mapLibreStatus = "";
let mapCells = [];
let mapDots = true;
const globe = createGlobe($("globe"), showCell, (lat, lon) => {
  if (!googleGlobe && !mapLibre) showCoordinates(lat, lon);
}, () => {
  if (!googleGlobe && !mapLibre) scheduleMap();
});
const activeGlobe = () => googleGlobe ?? mapLibre ?? globe;

function setCells(items, dots = mapDots) {
  mapCells = items;
  mapDots = dots;
  activeGlobe().setCells(items, dots);
}

function centerMaps() {
  const area = bounds();
  globe.center(area);
  mapLibre?.center(area);
  googleGlobe?.center(area);
  scheduleMap();
}

function updateMapView() {
  const google = Boolean(googleGlobe);
  const vectorMap = Boolean(mapLibre) && !google;
  for (const [id, visible] of [["google-globe", google], ["maplibre", vectorMap]]) {
    $(id).inert = !visible;
    $(id).setAttribute("aria-hidden", String(!visible));
  }
  $("globe").hidden = google || vectorMap;
  $("explore").classList.toggle("google-active", google);
  $("explore").classList.toggle("maplibre-active", vectorMap);
  $("basemap").setAttribute("aria-pressed", String(google));
  $("view-globe").setAttribute("aria-pressed", String(!google && !flatMap));
  $("view-flat").setAttribute("aria-pressed", String(!google && flatMap));
  $("style-dark").setAttribute("aria-pressed", String(vectorMap && !satellite));
  $("style-satellite").setAttribute("aria-pressed", String(!google && (satellite || !mapLibre)));
  $("map-attribution").hidden = !vectorMap;
  $("nasa-attribution").hidden = !satellite;
  $("download-visual").disabled = google;
  $("download-visual").title = google ? "Switch to the dark map or NASA satellite to download a map PNG" : "Download map PNG";
  if (vectorMap) mapLibre.resize();
  activeGlobe().reportCenter?.();
  activeGlobe().setCells(mapCells, mapDots);
  scheduleMap();
}

function showLocalMap(flat) {
  googleLoad = undefined;
  $("basemap-status").textContent = mapLibreStatus;
  googleGlobe?.destroy();
  googleGlobe = undefined;
  flatMap = flat;
  globe.setFlat(flat);
  mapLibre?.setFlat(flat);
  updateMapView();
}

function selectBasemap(useSatellite) {
  satellite = useSatellite;
  mapLibre?.setSatellite(satellite);
  showLocalMap(flatMap);
}

async function initMapLibre() {
  try {
    const { createMapLibreMap } = await import("./maplibre-map.js");
    mapLibre = await createMapLibreMap($("maplibre"), showCell, (lat, lon) => {
      if (!googleGlobe) showCoordinates(lat, lon);
    }, () => {
      if (!googleGlobe) scheduleMap();
    });
    mapLibre.setFlat(flatMap);
    mapLibre.center(bounds());
    $("style-dark").disabled = false;
    $("style-satellite").disabled = false;
    updateMapView();
  } catch {
    mapLibreStatus = "Dark map unavailable. Showing bundled NASA Blue Marble.";
    if (!googleGlobe && !googleLoad) $("basemap-status").textContent = mapLibreStatus;
  }
}

async function initGoogleMap() {
  const config = await api("/map-config").catch(() => null);
  if (!config?.googleMapsKey) return;
  const button = $("basemap");
  button.hidden = false;
  const status = $("basemap-status");
  button.addEventListener("click", async () => {
    status.textContent = "";
    if (googleGlobe) {
      showLocalMap(flatMap);
      return;
    }
    button.disabled = true;
    const load = {};
    googleLoad = load;
    status.textContent = "Loading Google 3D…";
    let map;
    try {
      const { createGoogleMap } = await import("./google-map.js");
      const initialBounds = bounds();
      map = await createGoogleMap($("google-globe"), config.googleMapsKey, initialBounds, showCell,
        (lat, lon) => { if (googleGlobe === map && map) showCoordinates(lat, lon); },
        () => {
          if (!map || googleGlobe !== map) return;
          showLocalMap(flatMap);
          status.textContent = "Google 3D became unavailable.";
        }, () => { if (googleGlobe === map) scheduleMap(); });
      if (googleLoad !== load) {
        map.destroy();
        return;
      }
      const area = bounds();
      if (Object.keys(area).some((key) => area[key] !== initialBounds[key])) map.center(area);
      googleGlobe = map;
      updateMapView();
      status.textContent = "";
    } catch {
      map?.destroy();
      if (googleLoad === load) status.textContent = "Google 3D is unavailable. Check the Maps key, billing, or connection.";
    } finally {
      if (googleLoad === load) googleLoad = undefined;
      button.disabled = false;
    }
  });
}

function showDetails(title, values) {
  $("selection-title").textContent = title;
  $("selection-details").replaceChildren(...values.map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    term.textContent = label;
    definition.textContent = value;
    row.append(term, definition);
    return row;
  }));
}

function showCell(cell) {
  showDetails(mapDots ? "Selected activity dot" : "Selected grid cell", [
    [mapDots ? "Average location" : "Center", `${coordinate(cell.latitude, "S", "N", 3)}, ${coordinate(cell.longitude, "W", "E", 3)}`],
    ["Detections", format(cell.detection_count)],
    ["Days with detections", format(cell.observed_days)],
    ["Platforms", cell.platforms.map((platform) => platformNames[platform] ?? platform).join(", ")],
    ["Total FRP", `${format(Math.round(cell.frp_sum_mw))} MW`],
  ]);
  $("inspector").open = true;
}

function signatures(period, complete) {
  const datasets = selectedDatasets();
  return (monthCoverage.get(period) ?? []).filter((row) => datasets.includes(row.dataset)
    && (!complete || (row.is_complete_month && row.platform_complete)))
    .map((row) => `${row.dataset}/${row.platform}`).sort().join(",");
}

function level(value, peak) {
  if (value == null) return "missing";
  return value ? Math.min(4, Math.ceil(4 * Math.sqrt(value / Math.max(value, peak)))) : 0;
}

function daySpan(period, from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => isoDay(period, from + index));
}

// Calendar weeks run Monday to Sunday and stop at the edges of the visible month.
function weekOf(date) {
  const period = date.slice(0, 7);
  const { first, days } = dates(period);
  const number = Number(date.slice(8));
  const monday = number - (number - 1 + weekOffset(first)) % 7;
  return daySpan(period, Math.max(1, monday), Math.min(days, monday + 6));
}

function isRun() {
  return Number(selected.at(-1).slice(8)) - Number(selected[0].slice(8)) === selected.length - 1;
}

function selectionLabel() {
  if (!selected.length) return null;
  const first = new Date(selected[0]);
  if (selected.length === 1) return dayFormat.format(first);
  const month = monthNames[first.getUTCMonth()];
  return isRun()
    ? `${month} ${first.getUTCDate()}–${Number(selected.at(-1).slice(8))}, ${first.getUTCFullYear()}`
    : `${selected.length} days in ${month}`;
}

function selectionSlug() {
  if (!selected.length) return selectedPeriod;
  if (selected.length === 1) return selected[0];
  return isRun() ? `${selected[0]}_to_${selected.at(-1)}` : `${selectedPeriod}-${selected.length}-days`;
}

function drawCalendar() {
  const period = selectedPeriod;
  const { first, days } = dates(period);
  const offset = weekOffset(first);
  $("calendar-month").textContent = selectionLabel() ?? monthFormat.format(first);
  const byDate = new Map(calendar.map((row) => [row.date, row]));
  const peak = Math.max(1, ...calendar.map((row) => row.active_cell_days));
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= days; i++) {
    const date = isoDay(period, i);
    const button = document.createElement("button");
    const position = i - 1 + offset;
    button.dataset.date = date;
    button.dataset.week = Math.floor(position / 7);
    if (i > 1 && position % 7 === 0) button.className = "week-start";
    const data = byDate.get(date);
    const count = data?.active_cell_days;
    button.type = "button";
    button.textContent = i;
    button.dataset.level = level(count, peak);
    if (count) {
      const intensity = Math.sqrt(count / peak);
      button.style.setProperty("--bar", `${3 + 19 * intensity}px`);
      button.style.setProperty("--strength", .4 + .6 * intensity);
    }
    button.setAttribute("aria-pressed", selected.includes(date));
    button.setAttribute("aria-label", `${weekdayFormat.format(new Date(date))} ${date}, ${count == null ? "no eligible records or coverage unknown" : format(count) + " active cells"}`);
    button.title = button.getAttribute("aria-label");
    button.addEventListener("click", (event) => pickDay(date, event.shiftKey));
    fragment.append(button);
  }
  $("days").replaceChildren(fragment);
  $("whole-month").disabled = !selected.length;
  $("whole-month").hidden = !selected.length;
  $("download-calendar").disabled = !calendar.length;
}

// Harmonized cell-days restate a month as the full satellite set would have
// seen it, so months with different satellites can be compared.
function harmonizedTotal(rows) {
  return rows.reduce((sum, row) => sum + row.harmonized_cell_days, 0);
}

function drawSelection() {
  const rows = selected.length ? calendar.filter((row) => selected.includes(row.date)) : calendar;
  const total = (key) => format(rows.reduce((sum, row) => sum + row[key], 0));
  const sources = (monthCoverage.get(selectedPeriod) ?? []).map((row) => row.dataset);
  showDetails(selectionLabel() ?? "Month overview", rows.length ? [
    [selected.length === 1 ? "Active cells" : "Active cell-days", total("active_cell_days")],
    ...(rows.every((row) => row.harmonized_cell_days != null)
      && Math.round(harmonizedTotal(rows)) !== rows.reduce((sum, row) => sum + row.active_cell_days, 0)
      ? [["Full-constellation equivalent", format(Math.round(harmonizedTotal(rows)))]] : []),
    ...selectedDatasets().filter((key) => sources.includes(key)).map((key) => [datasets[key] + " detections", total(key)]),
    ...(sources.includes("modis") && sources.some((key) => key !== "modis") && !$("dataset").value
      ? [["MODIS + VIIRS overlaps", total("shared_cell_days")]] : []),
  ] : [["Activity", "No eligible records"]]);
}

function pickDay(date, extend) {
  if (mode === "week") {
    selected = weekOf(date);
  } else if (mode === "days") {
    const next = new Set(selected);
    if (extend && rangeAnchor) {
      const [from, to] = [rangeAnchor, date].map((value) => Number(value.slice(8))).sort((a, b) => a - b);
      daySpan(selectedPeriod, from, to).forEach((value) => next.add(value));
    } else if (!next.delete(date)) {
      next.add(date);
    }
    selected = [...next].sort();
    rangeAnchor = date;
  } else {
    selected = [date];
  }
  applySelection(date);
}

function applySelection(focusDate) {
  const focused = focusDate && $("days").contains(document.activeElement);
  drawCalendar();
  if (focused) $("days").querySelector(`[data-date="${focusDate}"]`)?.focus();
  drawSelection();
  resetMap();
}

function setMode(next) {
  mode = next;
  $("days").dataset.mode = next;
  document.querySelectorAll(".calendar-modes button").forEach((button) => button.setAttribute("aria-pressed", button.dataset.mode === next));
  if (!selected.length) return;
  const before = selected.join();
  if (next === "week") selected = weekOf(selected[0]);
  if (next === "day") selected = [selected[0]];
  rangeAnchor = selected[0];
  if (selected.join() !== before) applySelection();
}

function highlightWeek(week) {
  for (const button of $("days").children) button.classList.toggle("peer", week !== undefined && button.dataset.week === week);
}

function scheduleMap() {
  if (!firstPeriod || view !== "explore") return;
  clearTimeout(mapTimer);
  mapTimer = setTimeout(loadMap, 180);
}

function resetMap() {
  clearTimeout(mapTimer);
  mapRequest?.abort();
  exportRequest?.abort();
  exportRequest = new AbortController();
  mapCache.clear();
  mapKey = undefined;
  $("download-points").disabled = true;
  $("map-key-label").textContent = "";
  $("map-message").textContent = "Loading map observations…";
  setCells([]);
  loadMap();
}

async function loadMap() {
  const camera = activeGlobe().getViewport();
  if (!camera) return;
  const { dots, size, viewport } = mapDetail(camera);
  const { start, end } = dates(selectedPeriod);
  const params = new URLSearchParams({
    ...bounds(), ...sensorParam(), start_date: selected[0] ?? start, end_date: selected.at(-1) ?? end, cell_size: size,
  });
  for (const bound of viewport ?? []) params.append("viewport", bound);
  if (selected.length && !isRun()) {
    for (const day of selected) params.append("days", day);
  }
  const key = `${dots}:${params}`;
  if (key === mapKey) return;
  mapKey = key;
  mapRequest?.abort();
  const request = new AbortController();
  mapRequest = request;
  try {
    let items = mapCache.get(key);
    if (!items) {
      const { data } = await api("/v1/spatial/grid", params, request.signal);
      if (request.signal.aborted) return;
      items = data.map((row) => {
        const strength = Math.min(1, Math.log2(row.detection_count) / 9);
        const red = Math.round(149 + 106 * strength);
        const green = Math.round(58 + 113 * strength);
        const blue = Math.round(23 + 74 * strength);
        const color = `rgba(${red}, ${green}, ${blue}, ${.56 + .38 * strength})`;
        const latitude = dots ? row.mean_latitude : row.south + size / 2;
        const longitude = dots ? row.mean_longitude : row.west + size / 2;
        return { ...row, size, strength, color, latitude, longitude };
      });
    }
    mapCache.delete(key);
    mapCache.set(key, items);
    if (mapCache.size > 5) mapCache.delete(mapCache.keys().next().value);
    setCells(items, dots);
    if (items.length) $("download-points").disabled = false;
    const label = dots ? "Activity dots" : `${Number(size.toPrecision(4))}° grid`;
    $("map-key-label").textContent = `${label} · brighter = more detections`;
    $("map-message").textContent = items.length ? "" : "No mapped observations in this view";
  } catch (error) {
    if (!request.signal.aborted) {
      mapKey = undefined;
      $("map-message").textContent = error.message;
    }
  }
}

async function loadAnomaly(period, bbox, rows, signal) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5));
  const active = signatures(period, false);
  if (!rows.length || !active) return;
  // With harmonization any prior month with full coverage from some platform
  // is comparable. Without it, only months with the same satellites are.
  const harmonized = rows.every((row) => row.harmonized_cell_days != null);
  if (!harmonized && active !== signatures(period, true)) return;
  const key = harmonized ? "harmonized_cell_days" : "active_cell_days";
  const prior = [];
  for (let y = Math.max(2000, year - 5); y < year; y++) {
    const previous = `${y}-${period.slice(5)}`;
    const complete = signatures(previous, true);
    if (harmonized ? complete : complete === active && signatures(previous, false) === active) {
      prior.push(dates(previous));
    }
  }
  if (prior.length < 2) return;
  const historic = await api("/v1/calendar", {
    ...bbox, ...sensorParam(), interval: "month", month, start_date: prior[0].start, end_date: prior.at(-1).end,
  }, signal);
  if (signal.aborted) return;
  const matching = new Set(prior.map((span) => span.start));
  const values = historic.data.filter((row) => matching.has(row.date) && row[key] != null).map((row) => row[key]).sort((a, b) => a - b);
  if (values.length < 2) return;
  const median = (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2;
  if (!median) return;
  const delta = (rows.reduce((sum, row) => sum + row[key], 0) - median) / median;
  $("anomaly").textContent = new Intl.NumberFormat("en", { style: "percent", signDisplay: "exceptZero" }).format(delta);
  $("anomaly").title = `Median of ${values.length} previous ${monthNames[month - 1]} values: ${format(Math.round(median))} cell-days`
    + (harmonized ? ", adjusted for the satellites flying each year" : "");
}

function sensorParam() {
  return $("dataset").value ? { dataset: $("dataset").value } : {};
}

async function loadSelection() {
  selectionRequest?.abort();
  const request = new AbortController();
  selectionRequest = request;
  const period = selectedPeriod;
  $("previous").disabled = !firstPeriod || period <= firstPeriod;
  $("next").disabled = !lastPeriod || period >= lastPeriod;
  const bbox = bounds();
  const { start, end } = dates(period);
  $("area-name").textContent = areaName();
  $("history-area").textContent = areaName() + " · " + $("dataset").selectedOptions[0].textContent;
  selected = [];
  rangeAnchor = null;
  calendar = [];
  drawCalendar();
  $("activity").textContent = "—";
  $("anomaly").textContent = "—";
  $("anomaly").removeAttribute("title");
  $("coverage-note").textContent = "Loading calendar…";
  showDetails("Month overview", []);
  if (view === "history") loadHistory();
  resetMap();
  try {
    const response = await api("/v1/calendar", { ...bbox, ...sensorParam(), start_date: start, end_date: end }, request.signal);
    if (request.signal.aborted) return;
    calendar = response.data;
    drawCalendar();
    drawSelection();
    $("activity").textContent = calendar.length ? format(calendar.reduce((sum, row) => sum + row.active_cell_days, 0)) : "—";
    const active = signatures(period, false);
    const full = signatures(period, true);
    $("coverage-note").textContent = !active ? "No archive coverage for this month."
      : active !== full ? (calendar.some((row) => row.harmonized_cell_days != null)
        ? "Partial instrument coverage. The comparison uses only instruments that observed the whole month."
        : "Partial instrument coverage. This month is excluded from median comparisons.")
      : calendar.length ? "" : "No qualifying detections in this area.";
    if (active && !$("dataset").value) {
      const present = new Set((monthCoverage.get(period) ?? []).map((row) => row.dataset));
      const missing = selectedDatasets().filter((key) => !present.has(key));
      if (missing.length) {
        const existing = $("coverage-note").textContent;
        $("coverage-note").textContent = [existing, "Missing this month: " + missing.map((key) => datasets[key]).join(", ") + "."].filter(Boolean).join(" ");
      }
    }
    await loadAnomaly(period, bbox, calendar, request.signal);
  } catch (error) {
    if (!request.signal.aborted) $("coverage-note").textContent = calendar.length ? "Historical comparison unavailable." : error.message;
  }
}

function selectPeriod(period) {
  if (!firstPeriod || period < firstPeriod || period > lastPeriod) return false;
  selectedPeriod = period;
  const [year, month] = period.split("-");
  const picker = $("period-month");
  if (picker.dataset.year !== year) {
    const options = [];
    for (let index = 0; index < 12; index++) {
      const value = String(index + 1).padStart(2, "0");
      const candidate = `${year}-${value}`;
      if (candidate < firstPeriod || candidate > lastPeriod) continue;
      options.push(new Option(monthLabel.format(new Date(Date.UTC(Number(year), index, 1))), value));
    }
    picker.replaceChildren(...options);
    picker.dataset.year = year;
  }
  picker.value = month;
  $("period-year").value = year;
  return true;
}

function shiftMonth(delta) {
  const { first } = dates(selectedPeriod);
  first.setUTCMonth(first.getUTCMonth() + delta);
  if (selectPeriod(first.toISOString().slice(0, 7))) loadSelection();
}

function csvDownload(filename, rows, columns = Object.keys(rows[0] ?? {})) {
  if (!rows.length) return;
  const quote = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const content = [columns.map(quote).join(","), ...rows.map((row) => columns.map((key) => quote(row[key])).join(","))].join("\r\n");
  download(filename, new Blob([content], { type: "text/csv;charset=utf-8" }));
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPoints() {
  const button = $("download-points");
  const signal = exportRequest.signal;
  const period = selectedPeriod;
  const days = selected;
  const slug = selectionSlug();
  const { start, end } = dates(period);
  const bbox = bounds();
  const limit = Math.min(5000, Math.floor(35000 / Math.max(1, days.length)));
  const spans = days.length ? days.map((day) => ({ start_date: day, end_date: day })) : [{ start_date: start, end_date: end }];
  button.disabled = true;
  try {
    const pages = await Promise.all(selectedDatasets().flatMap((dataset) => spans.map((span) =>
      api("/v1/hotspots", { ...bbox, dataset, ...span, limit }, signal))));
    if (signal.aborted) return;
    const rows = pages.flatMap((page) => page.data);
    if (rows.length) csvDownload(`firms-${slug}-hotspots${pages.some((page) => page.truncated) ? "-limited-per-sensor" : ""}.csv`, rows);
    else $("map-message").textContent = "No hotspot rows to export";
  } catch (error) {
    if (!signal.aborted) $("map-message").textContent = error.message;
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

async function loadHistory() {
  historyRequest?.abort();
  const request = new AbortController();
  historyRequest = request;
  const from = $("history-start").value;
  const to = $("history-end").value;
  const table = $("history-table");
  const note = $("history-note");
  table.replaceChildren();
  $("history-trend").hidden = true;
  $("download-history").disabled = true;
  historyRows = [];
  if (!from || !to || from > to) {
    note.textContent = "Choose a valid month range.";
    return;
  }
  const bbox = bounds();
  const params = sensorParam();
  note.textContent = "Loading monthly activity…";
  try {
    // Query one calendar year at a time to stay within the API's bounded scan.
    const firstYear = Number(from.slice(0, 4));
    const lastYear = Number(to.slice(0, 4));
    const rows = [];
    for (let year = lastYear; year >= firstYear; year--) {
      const start = year === firstYear ? dates(from).start : `${year}-01-01`;
      const end = year === lastYear ? dates(to).end : `${year}-12-31`;
      if (!monthNames.some((_, index) => {
        const period = `${year}-${String(index + 1).padStart(2, "0")}`;
        return period >= from && period <= to && signatures(period, false);
      })) continue;
      const result = await api("/v1/calendar", { ...bbox, ...params, start_date: start, end_date: end, interval: "month" }, request.signal);
      rows.push(...result.data);
    }
    if (request.signal.aborted) return;
    historyRows = rows.sort((a, b) => a.date.localeCompare(b.date));
    $("download-history").disabled = !rows.length;
    note.textContent = !rows.length ? "No eligible records in this range."
      : "Select a month to inspect it. Hatched months have no eligible records. " + (harmonizing
        ? "Values are adjusted to what the full satellite set would have seen, so years are comparable. Hover for observed counts."
        : "Satellite coverage can change across months.");
    const observed = new Map(rows.map((row) => [row.date.slice(0, 7), row.active_cell_days]));
    const index = new Map(rows.map((row) => [row.date.slice(0, 7),
      row.harmonized_cell_days == null ? row.active_cell_days : Math.round(row.harmonized_cell_days)]));
    const peak = Math.max(1, ...index.values());
    drawTrend(rows, from, to);
    const header = table.createTHead().insertRow();
    for (const name of ["Year", ...monthNames]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = name;
      header.append(cell);
    }
    const body = table.createTBody();
    for (let year = lastYear; year >= firstYear; year--) {
      const row = body.insertRow();
      const yearCell = document.createElement("th");
      yearCell.scope = "row";
      yearCell.textContent = year;
      row.append(yearCell);
      monthNames.forEach((name, i) => {
        const period = `${year}-${String(i + 1).padStart(2, "0")}`;
        const cell = row.insertCell();
        if (period < from || period > to) return;
        const count = index.get(period);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "history-cell";
        button.dataset.level = level(count, peak);
        button.textContent = count == null ? "—" : format(count);
        const active = signatures(period, false);
        const satelliteNames = (monthCoverage.get(period) ?? []).filter((item) => selectedDatasets().includes(item.dataset))
          .map((item) => platformNames[item.platform] ?? item.platform);
        const partial = active !== signatures(period, true);
        button.setAttribute("aria-label", `${name} ${year}: ${count == null ? "no eligible records" : format(count) + " active cell-days"}`);
        const adjusted = harmonizing && count != null && count !== observed.get(period);
        if (active) {
          button.title = satelliteNames.join(", ") + (partial ? " · partial coverage" : "")
            + (adjusted ? ` · observed ${format(observed.get(period))}` : harmonizing && count != null && partial ? " · not adjusted" : "");
        }
        button.addEventListener("click", () => {
          if (!selectPeriod(period)) return;
          setView("explore");
          loadSelection();
        });
        cell.append(button);
      });
    }
  } catch (error) {
    if (!request.signal.aborted) note.textContent = error.message;
  }
}

// Tests the adjusted monthly series for a monotonic trend. Months that no
// platform observed in full are left out; observed months without fire count as zero.
function drawTrend(rows, from, to) {
  const output = $("history-trend");
  if (!harmonizing) return;
  const values = new Map(rows.map((row) => [row.date.slice(0, 7), row.harmonized_cell_days]));
  const points = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (let month = 1; month <= 12; month++) {
      const period = `${year}-${String(month).padStart(2, "0")}`;
      if (period < from || period > to || !signatures(period, true)) continue;
      const value = values.has(period) ? values.get(period) : 0;
      if (value != null) points.push({ year, month, value });
    }
  }
  const years = new Set(points.map((point) => point.year)).size;
  const result = years >= 5 ? seasonalMannKendall(points) : null;
  output.hidden = false;
  if (!result) {
    output.textContent = "Trend test: choose a range of at least five years with fire activity.";
    return;
  }
  const mean = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const rate = new Intl.NumberFormat("en", { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(result.slope / mean);
  const p = result.p < .001 ? "p < 0.001" : "p = " + result.p.toFixed(3);
  const significant = result.p < .05;
  const headline = significant
    ? `${result.s > 0 ? "Increasing" : "Decreasing"} trend, ${rate} per year`
    : "No significant trend";
  const detail = document.createElement("small");
  detail.textContent = `Seasonal Mann-Kendall test on ${points.length} adjusted months, ${points[0].year}–${points.at(-1).year}: `
    + `τ = ${result.tau.toFixed(2)}, Z = ${result.z.toFixed(2)}, ${p}`
    + (significant ? "" : `, Sen slope ${rate} per year`)
    + ". Trends that cross 2012 or 2018 rely on the satellite adjustment.";
  output.replaceChildren(headline, detail);
}

function setView(next) {
  view = next;
  if (next !== "explore") closeMenus.forEach((close) => close?.());
  $("explore").hidden = next !== "explore";
  $("history").hidden = next !== "history";
  document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-pressed", button.dataset.view === next));
  if (next === "history") loadHistory();
  else {
    mapLibre?.resize();
    scheduleMap();
  }
}

async function init() {
  $("download-points").disabled = true;
  $("download-calendar").disabled = true;
  $("download-history").disabled = true;
  $("whole-month").disabled = true;
  try {
    const [health, page, months] = await Promise.all([api("/health"), api("/v1/coverage"), api("/v1/coverage/monthly")]);
    coverage = page.data;
    for (const row of months.data) {
      const period = row.month_start.slice(0, 7);
      if (!monthCoverage.has(period)) monthCoverage.set(period, []);
      monthCoverage.get(period).push(row);
    }
    if (!coverage.length) throw new Error("The archive contains no usable coverage.");
    areaLabel = health.area_label;
    harmonizing = health.calibration_available;
    status(areaLabel ? areaLabel + " archive" : "Global FIRMS archive", "ready");
    for (const [key, name] of Object.entries(datasets)) {
      if (coverage.some((row) => row.dataset === key)) $("dataset").add(new Option(name, key));
    }
    const first = coverage.map((row) => row.first_date).sort()[0].slice(0, 7);
    const latest = coverage.map((row) => row.last_date).sort().at(-1).slice(0, 7);
    for (const id of ["history-start", "history-end"]) {
      $(id).min = first;
      $(id).max = latest;
    }
    firstPeriod = first;
    lastPeriod = latest;
    const yearOptions = document.createDocumentFragment();
    for (let year = Number(latest.slice(0, 4)); year >= Number(first.slice(0, 4)); year--) {
      yearOptions.append(new Option(String(year)));
    }
    $("period-year").replaceChildren(yearOptions);
    if (areaLabel?.toLowerCase().includes("cambodia")) $("region").value = "cambodia";
    const platforms = new Set(coverage.map((row) => row.platform)).size;
    const latestComplete = [...monthCoverage.keys()].sort().reverse().find((period) =>
      (monthCoverage.get(period) ?? []).filter((row) => row.is_complete_month && row.platform_complete).length === platforms);
    selectPeriod(latestComplete ?? latest);
    $("period-month").disabled = false;
    $("period-year").disabled = false;
    $("history-start").value = first;
    $("history-end").value = latest;
    centerMaps();
    loadSelection();
  } catch (error) {
    status("Archive unavailable", "error");
    $("coverage-note").textContent = error.message;
    $("map-message").textContent = "Connect a validated FIRMS archive to view observations.";
  }
}

$("region").addEventListener("change", () => {
  $("bounds").hidden = $("region").value !== "custom";
  centerMaps();
  loadSelection();
});
$("bounds").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries([...new FormData(event.target)].map(([key, value]) => [key, Number(value)]));
  if (data.max_lat < data.min_lat) {
    $("coverage-note").textContent = "North latitude must be greater than or equal to south latitude.";
    return;
  }
  customBounds = data;
  centerMaps();
  loadSelection();
});
$("dataset").addEventListener("change", loadSelection);
$("period-month").addEventListener("change", () => {
  if (selectPeriod(`${$("period-year").value}-${$("period-month").value}`)) loadSelection();
});
$("period-year").addEventListener("change", () => {
  const period = `${$("period-year").value}-${selectedPeriod.slice(5)}`;
  const next = period < firstPeriod ? firstPeriod : period > lastPeriod ? lastPeriod : period;
  if (selectPeriod(next)) loadSelection();
});
$("previous").addEventListener("click", () => shiftMonth(-1));
$("next").addEventListener("click", () => shiftMonth(1));
$("whole-month").addEventListener("click", () => {
  selected = [];
  rangeAnchor = null;
  applySelection();
  $("days").querySelector("button")?.focus();
});
document.querySelectorAll(".calendar-modes button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
for (const type of ["pointerover", "focusin"]) {
  $("days").addEventListener(type, (event) => highlightWeek(mode === "week" ? event.target.dataset?.week : undefined));
}
for (const type of ["pointerleave", "focusout"]) $("days").addEventListener(type, () => highlightWeek());
$("view-globe").addEventListener("click", () => showLocalMap(false));
$("view-flat").addEventListener("click", () => showLocalMap(true));
$("style-dark").addEventListener("click", () => selectBasemap(false));
$("style-satellite").addEventListener("click", () => selectBasemap(true));
$("zoom-in").addEventListener("click", () => activeGlobe().changeZoom(1.35));
$("zoom-out").addEventListener("click", () => activeGlobe().changeZoom(1 / 1.35));
$("recenter").addEventListener("click", centerMaps);
$("about").addEventListener("click", () => $("methodology").showModal());
$("history-form").addEventListener("submit", (event) => { event.preventDefault(); loadHistory(); });
$("download-calendar").addEventListener("click", () => csvDownload(`firms-${selectedPeriod}-calendar.csv`, calendar));
$("download-points").addEventListener("click", downloadPoints);
$("download-history").addEventListener("click", () => csvDownload("firms-monthly-history.csv", historyRows));
$("download-visual").addEventListener("click", () => {
  const filename = `firms-${selectionSlug()}-map.png`;
  activeGlobe().exportImage?.((blob) => {
    if (blob) download(filename, blob);
  });
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

init();
initMapLibre();
initGoogleMap();
