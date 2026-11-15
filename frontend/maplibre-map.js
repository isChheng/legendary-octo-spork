import { addGeography, loadBasemap } from "./geography.js";
import { octagon } from "./map-detail.js";

const mapLibreDist = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.2/dist/";
const blueMarbleTiles = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
const fireLayer = "burnline-fire-grid";
const dotLayer = "burnline-fire-dots";
const satelliteLayer = "burnline-blue-marble";
const emptyGrid = { type: "FeatureCollection", features: [] };
const mercatorLimit = 85.051129;
function loadAsset(element) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("MapLibre took too long to load")), 12000);
    function finish(error) {
      clearTimeout(timer);
      if (error) {
        element.remove();
        reject(error);
      } else {
        resolve();
      }
    }
    element.crossOrigin = "anonymous";
    element.addEventListener("load", () => finish(), { once: true });
    element.addEventListener("error", () => finish(new Error("Could not load MapLibre")), { once: true });
    document.head.append(element);
  });
}

async function loadMapLibre() {
  const script = document.createElement("script");
  script.src = mapLibreDist + "maplibre-gl.js";
  script.integrity = "sha384-1qC0PnXk2fgMDybOtZF1ui4LM5Sxm7o0TbEkwfxTTVdlZvuNENNGCKUub7d644HP";
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = mapLibreDist + "maplibre-gl.css";
  css.integrity = "sha384-gNYNsUmuZqDYiT3gbirWTV5K7rt71RoveS/yXAaU09d4ZUmeDVTD3XoqB6uJAIFR";
  await Promise.all([loadAsset(script), loadAsset(css)]);
  return window.maplibregl;
}

const cellKey = (cell) => `${cell.west},${cell.south},${cell.size}`;

function cellFeature(cell, dots) {
  const properties = { key: cellKey(cell), color: cell.color, strength: cell.strength };
  if (dots) {
    if (Math.abs(cell.latitude) > mercatorLimit) return [];
    return [{ type: "Feature", properties, geometry: { type: "Point", coordinates: [cell.longitude, cell.latitude] } }];
  }
  if (cell.south >= mercatorLimit || cell.south + cell.size <= -mercatorLimit) return [];
  const ring = octagon(cell.south, cell.west, cell.size)
    .map(([lat, lon]) => [lon, Math.max(-mercatorLimit, Math.min(mercatorLimit, lat))]);
  return [{ type: "Feature", properties, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } }];
}

function waitForBasemap(map) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The dark basemap took too long to load")), 12000);
    const loaded = () => finish();
    const failed = ({ error, tile }) => {
      if (!tile) finish(error);
    };
    function finish(error) {
      clearTimeout(timer);
      map.off("load", loaded);
      map.off("error", failed);
      if (error) reject(error);
      else resolve();
    }
    map.on("load", loaded);
    map.on("error", failed);
  });
}

export async function createMapLibreMap(host, onSelect, onMove, onViewportChange) {
  const [maplibre, style] = await Promise.all([loadMapLibre(), loadBasemap()]);
  const map = new maplibre.Map({
    container: host,
    style,
    center: [0, 0],
    zoom: 1,
    attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
  });
  let items = new Map();
  let satellite = false;
  let flat = false;

  function center(area) {
    const west = area.min_lon;
    const east = area.max_lon < west ? area.max_lon + 360 : area.max_lon;
    if (east - west >= 359) {
      const side = Math.min(host.clientWidth, host.clientHeight);
      const zoom = Math.log2(Math.max(1, side) / (flat ? 512 : 220));
      map.jumpTo({ center: [0, 0], zoom });
      return;
    }
    const south = Math.max(-mercatorLimit, Math.min(mercatorLimit, area.min_lat));
    const north = Math.min(mercatorLimit, Math.max(-mercatorLimit, area.max_lat));
    const side = Math.round(host.clientWidth * .12);
    map.fitBounds([[west, south], [east, north]], {
      animate: false,
      maxZoom: 11,
      padding: { top: 90, bottom: 140, left: side, right: side },
    });
  }

  function reportCenter() {
    const { lat, lng } = map.getCenter().wrap();
    onMove(lat, lng);
  }

  try {
    await waitForBasemap(map);
    map.setProjection({ type: "globe" });
    map.addSource(satelliteLayer, { type: "raster", tiles: [blueMarbleTiles], maxzoom: 8, tileSize: 256 });
    map.addLayer({
      id: satelliteLayer, type: "raster", source: satelliteLayer,
      layout: { visibility: "none" },
      paint: { "raster-brightness-max": .8, "raster-saturation": -.14 },
    }, "land");
    map.addSource(fireLayer, { type: "geojson", data: emptyGrid });
    map.addLayer({
      id: fireLayer, type: "fill", source: fireLayer,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": ["to-color", ["get", "color"]], "fill-antialias": false },
    });
    map.addLayer({
      id: dotLayer, type: "circle", source: fireLayer,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": ["to-color", ["get", "color"]],
        "circle-radius": ["interpolate", ["linear"], ["zoom"],
          0, ["+", .6, ["*", .65, ["get", "strength"]]],
          5, ["+", .85, ["*", 1.3, ["get", "strength"]]]],
      },
    });
  } catch (error) {
    map.remove();
    throw error;
  }

  const refreshGeography = addGeography(map);
  map.on("move", reportCenter);
  map.on("moveend", onViewportChange);
  for (const layer of [fireLayer, dotLayer]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
  map.on("click", (event) => {
    const features = map.queryRenderedFeatures(event.point, { layers: [fireLayer, dotLayer] });
    const cell = items.get(features[0]?.properties.key);
    if (cell) onSelect(cell);
  });
  const canvas = map.getCanvas();
  canvas.setAttribute("aria-label", "Interactive fire map. Use arrow keys to move and plus or minus to zoom.");

  return {
    center,
    reportCenter,
    getViewport() {
      const area = map.getBounds();
      const west = area.getWest();
      const east = area.getEast();
      return [area.getSouth(), area.getNorth(), west, east < west ? east + 360 : east];
    },
    resize: () => map.resize(),
    changeZoom(factor) {
      map.zoomTo(map.getZoom() + Math.log2(factor), { duration: 180 });
    },
    setFlat(enabled) {
      flat = enabled;
      map.setProjection({ type: flat ? "mercator" : "globe" });
      refreshGeography();
    },
    setSatellite(enabled) {
      if (enabled === satellite) return;
      satellite = enabled;
      map.setLayoutProperty(satelliteLayer, "visibility", enabled ? "visible" : "none");
      map.setLayoutProperty("land", "visibility", enabled ? "none" : "visible");
      map.setPaintProperty("coast", "line-color", enabled ? "rgba(255, 255, 255, .55)" : "#33424e");
    },
    setCells(cells, dots) {
      items = new Map(cells.map((cell) => [cellKey(cell), cell]));
      map.getSource(fireLayer).setData({ type: "FeatureCollection", features: cells.flatMap((cell) => cellFeature(cell, dots)) });
    },
    exportImage(callback) {
      const output = document.createElement("canvas");
      output.width = canvas.width;
      output.height = canvas.height;
      const context = output.getContext("2d");
      context.drawImage(canvas, 0, 0);
      const credit = `Natural Earth · geoBoundaries${satellite ? " · NASA GIBS" : ""}`;
      context.font = "12px sans-serif";
      context.fillStyle = "#10151b";
      context.fillRect(0, output.height - 22, Math.min(context.measureText(credit).width + 16, output.width), 22);
      context.fillStyle = "#f0f1f4";
      context.fillText(credit, 8, output.height - 7, output.width - 16);
      output.toBlob(callback, "image/png");
    },
  };
}
