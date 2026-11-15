// Geography format and map styles adapted from Project SHIFT (Apache 2.0).
// See assets/geography for the geography sources and licenses.
import "./assets/geography/topojson-client.js";
import { coastLines, landForMap } from "./assets/geography/coast.js";

const assets = new URL("./assets/geography/", import.meta.url).href;
const labelFont = ["Noto Sans Regular"];
const pointFilter = ["==", ["geometry-type"], "Point"];
const lineFilter = ["==", ["geometry-type"], "LineString"];
const empty = { type: "FeatureCollection", features: [] };
const collection = (features) => ({ type: "FeatureCollection", features });

async function readGeo(path) {
  const response = await fetch(assets + path);
  if (!response.ok) throw new Error(`Could not load map geography: ${path}`);
  return response.json();
}

function point(x, y, scale, properties) {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x / scale, y / scale] } };
}

function unpackLines(lines, scale, properties) {
  return lines.map(([startX, startY, ...deltas]) => {
    let x = startX;
    let y = startY;
    const coordinates = [[x / scale, y / scale]];
    for (let i = 0; i < deltas.length; i += 2) {
      x += deltas[i];
      y += deltas[i + 1];
      coordinates.push([x / scale, y / scale]);
    }
    return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
  });
}

function boundaryLayer(id, source, minzoom, color, width, dash) {
  return {
    id, source, type: "line", minzoom, filter: lineFilter,
    paint: {
      "line-color": color,
      "line-width": ["interpolate", ["linear"], ["zoom"], minzoom, width, 9, id === "geo-adm1-lines" ? 1.2 : 0.8],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], minzoom, 0, minzoom + .5, 1],
      ...dash,
    },
  };
}

export async function loadBasemap() {
  const [topology, { scale, l, places }] = await Promise.all([readGeo("countries-50m.json"), readGeo("world.json")]);
  const land = landForMap(globalThis.topojson.feature(topology, topology.objects.countries));
  const world = collection([
    ...unpackLines(l, scale, { k: "border" }),
    ...places.map(([x, y, n, k, r]) => point(x, y, scale, { k, n, r })),
  ]);
  return {
    version: 8,
    glyphs: assets + "fonts/{fontstack}/{range}.pbf",
    sources: {
      "geo-land": { type: "geojson", data: land },
      "geo-coast": { type: "geojson", data: coastLines(land) },
      "geo-world": { type: "geojson", data: world },
      "geo-adm1": { type: "geojson", data: empty },
      "geo-adm2": { type: "geojson", data: empty },
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": "#0d1a24" } },
      { id: "land", type: "fill", source: "geo-land",
        paint: { "fill-color": "#1d2933", "fill-antialias": false } },
      { id: "coast", type: "line", source: "geo-coast",
        paint: { "line-color": "#33424e", "line-width": .5 } },
      boundaryLayer("geo-adm2-lines", "geo-adm2", 6.5, "#3a4853", .3),
      boundaryLayer("geo-adm1-lines", "geo-adm1", 4.5, "#4c5c68", .5, { "line-dasharray": [4, 2] }),
      { id: "geo-intl-borders", type: "line", source: "geo-world", filter: ["==", ["get", "k"], "border"],
        paint: { "line-color": "#6c7d89", "line-width": ["interpolate", ["linear"], ["zoom"], 1, .6, 5, 1.2, 9, 2] } },
    ],
  };
}

function labelLayers(compact) {
  const size = compact ? .9 : 1;
  const later = compact ? .4 : 0;
  const label = "#c3cdd3";
  const halo = { "text-halo-color": "#0d141b", "text-halo-width": 1.4, "text-halo-blur": .4 };
  const rank = ["get", "r"];
  const country = (tier, minzoom, filter) => ({
    id: `geo-countries-${tier}`, type: "symbol", source: "geo-world", minzoom: minzoom + later, maxzoom: 8,
    filter: ["all", ["==", ["get", "k"], "country"], filter],
    layout: { "text-field": ["get", "n"], "text-font": labelFont, "symbol-sort-key": rank,
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11 * size, 6, 15 * size],
      "text-max-width": 7, "text-padding": 4 },
    paint: { "text-color": label, ...halo },
  });
  const area = (level, minzoom, upper) => ({
    id: `geo-adm${level}-labels`, type: "symbol", source: `geo-adm${level}`, minzoom: minzoom + later, filter: pointFilter,
    layout: { "text-field": ["get", "n"], "text-font": labelFont, "symbol-sort-key": ["-", 0, ["get", "a"]],
      "text-size": 10.5 * size, "text-max-width": 8, "text-padding": 3,
      ...(upper ? { "text-transform": "uppercase", "text-letter-spacing": .08 } : {}) },
    paint: { "text-color": label, "text-opacity": .9, ...halo },
  });
  return [
    country(1, 2.2, ["<=", rank, 2]),
    country(2, 3, ["all", [">", rank, 2], ["<=", rank, 4]]),
    country(3, 3.8, [">", rank, 4]),
    { id: "geo-oceans", type: "symbol", source: "geo-world", maxzoom: 5.5, filter: ["==", ["get", "k"], "ocean"],
      layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Italic"], "text-size": 13 * size,
        "text-letter-spacing": .1, "text-max-width": 6 },
      paint: { "text-color": "#7f9db0", "text-halo-color": halo["text-halo-color"], "text-halo-width": .8 } },
    { id: "geo-continents", type: "symbol", source: "geo-world", maxzoom: 3.4, filter: ["==", ["get", "k"], "continent"],
      layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Bold"], "text-size": 14 * size,
        "text-transform": "uppercase", "text-letter-spacing": .18, "text-max-width": 9 },
      paint: { "text-color": label, "text-opacity": ["interpolate", ["linear"], ["zoom"], 2.8, .85, 3.4, 0], ...halo } },
    // Keep the country view sparse by showing provinces and districts only at closer zooms.
    area(1, 8, true),
    area(2, 10, false),
  ];
}

function visibleTiles(bounds, size) {
  let west = bounds.getWest();
  let east = bounds.getEast();
  if (east < west) east += 360;
  if (east - west >= 360) [west, east] = [-180, 180];
  const keys = new Set();
  for (let lat = Math.floor(Math.max(-90, bounds.getSouth()) / size) * size; lat < Math.min(90, bounds.getNorth()); lat += size) {
    for (let lon = Math.floor(west / size) * size; lon < east; lon += size) {
      const lng = ((lon + 180) % 360 + 360) % 360 - 180;
      keys.add(`${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}${lng < 0 ? "W" : "E"}${String(Math.abs(lng)).padStart(3, "0")}`);
    }
  }
  return [...keys];
}

export function addGeography(map) {
  const container = map.getContainer();
  const labels = labelLayers(container.clientWidth < 600);
  for (const layer of labels) map.addLayer(layer);
  let showLabels;
  function updateLabels() {
    if (container.clientWidth < 100) return;
    const x = container.clientWidth / 2;
    const y = container.clientHeight / 2;
    const distance = map.unproject([x - 50, y]).distanceTo(map.unproject([x + 50, y]));
    const visible = Number.isFinite(distance) && distance < 3000000;
    if (visible === showLabels) return;
    showLabels = visible;
    for (const { id } of labels) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }

  const index = readGeo("tiles.json").catch(() => null);
  let lastView;
  const cache = new Map();
  function readTile(path, version) {
    if (!cache.has(path)) {
      cache.set(path, readGeo(`${path}?v=${version}`).then(({ scale, l, p }) => [
        ...unpackLines(l ?? [], scale, {}),
        ...p.filter(([, , name]) => !/(?!\p{Script=Latin})\p{Letter}/u.test(name))
          .map(([x, y, n, a]) => point(x, y, scale, { n, a })),
      ]).catch(() => []));
      if (cache.size > 48) cache.delete(cache.keys().next().value);
    }
    return cache.get(path);
  }

  async function updateBoundaries() {
    const geo = await index;
    if (!geo) return;
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const files = (keys, dir, available) => keys.filter((key) => available.includes(key)).map((key) => `${dir}/${key}.json`);
    const local = zoom >= 6 ? visibleTiles(bounds, 10) : [];
    const provinces = files(zoom >= 4 ? visibleTiles(bounds, 30) : [], "adm1", geo.tiles.adm1);
    const districts = [
      ...files(local, "adm2/attrib", geo.tiles.adm2_attrib),
      ...files(local, "adm2/odbl", geo.tiles.adm2_odbl),
    ];
    const view = [...provinces, ...districts].join(",");
    if (view === lastView) return;
    lastView = view;
    const load = (paths) => Promise.all(paths.map((path) => readTile(path, geo.v[path])));
    const [adm1, adm2] = await Promise.all([load(provinces), load(districts)]);
    if (view !== lastView) return;
    map.getSource("geo-adm1").setData(collection(adm1.flat()));
    map.getSource("geo-adm2").setData(collection(adm2.flat()));
  }

  function refresh() {
    updateLabels();
    updateBoundaries();
  }
  map.on("move", updateLabels);
  map.on("moveend", updateBoundaries);
  map.on("resize", refresh);
  refresh();
  return refresh;
}
