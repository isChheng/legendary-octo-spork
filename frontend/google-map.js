import { bindMapZoom } from "./map-zoom.js";
import { cameraBounds, octagon } from "./map-detail.js";

let loader;
const minZoomRange = 50;
const maxZoomRange = 24000000;
const maxCells = 500;

function loadMaps(key) {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const callback = "burnlineGoogleMapsReady";
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      delete window[callback];
      delete window.gm_authFailure;
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve(window.google.maps);
      }
    }
    window[callback] = () => finish();
    window.gm_authFailure = () => finish(new Error("Google Maps did not authorize the browser key."));
    script.onerror = () => finish(new Error("Could not reach Google Maps."));
    const timeout = setTimeout(() => finish(new Error("Google Maps took too long to load.")), 20000);
    const params = new URLSearchParams({ key, callback, loading: "async", libraries: "maps3d", v: "weekly" });
    script.src = "https://maps.googleapis.com/maps/api/js?" + params;
    script.async = true;
    document.head.append(script);
  }).catch((error) => {
    loader = undefined;
    throw error;
  });
  return loader;
}

function cameraFor(bounds, aspect) {
  const longitudeSpan = (bounds.max_lon - bounds.min_lon + 360) % 360 || 360;
  const lat = (bounds.min_lat + bounds.max_lat) / 2;
  const lng = ((bounds.min_lon + longitudeSpan / 2 + 540) % 360) - 180;
  const span = Math.max(bounds.max_lat - bounds.min_lat, longitudeSpan * Math.cos(lat * Math.PI / 180) / Math.min(1, aspect));
  const range = span >= 150 ? 22000000 : Math.min(22000000, Math.max(750, span * 170000));
  return { center: { lat, lng, altitude: 0 }, range, tilt: 0, heading: 0 };
}

export async function createGoogleMap(host, key, bounds, onSelect, onMove, onError, onViewportChange) {
  const maps = await loadMaps(key);
  const { Map3DElement, Polygon3DInteractiveElement } = await maps.importLibrary("maps3d");
  const camera = (area) => cameraFor(area, host.clientWidth / Math.max(1, host.clientHeight));
  const map = new Map3DElement({
    ...camera(bounds),
    mode: "SATELLITE",
    language: "en",
    gestureHandling: "GREEDY",
    defaultUIHidden: true,
    minAltitude: minZoomRange,
    maxAltitude: maxZoomRange,
    description: "Google 3D Earth with FIRMS detection grid cells. Drag to move, or pinch or scroll to zoom.",
  });

  function changeZoom(factor) {
    const next = Math.max(minZoomRange, Math.min(maxZoomRange, map.range / factor));
    if (!Number.isFinite(next) || next === map.range) return false;
    map.range = next;
  }
  const zoomSurface = document.createElement("div");
  zoomSurface.className = "google-map-surface";
  zoomSurface.append(map);
  const { cancelZoom } = bindMapZoom(zoomSurface, changeZoom);
  zoomSurface.addEventListener("pointerdown", cancelZoom, { capture: true });
  const reportCenter = () => {
    if (map.center) onMove(map.center.lat, map.center.lng);
  };
  map.addEventListener("gmp-centerchange", reportCenter);

  // Each polygon is a DOM element. Limit large selections to the busiest cells near the camera.
  let ranked = [];
  let shown = new Map();
  let cellTimer;
  let dots;
  function polygonFor(cell) {
    const polygon = new Polygon3DInteractiveElement({
      path: dots ? Array.from({ length: 8 }, (_, i) => {
        const angle = i * Math.PI / 4;
        const radius = cell.size * (.2 + .2 * cell.strength);
        return { lat: cell.south + cell.size / 2 + radius * Math.sin(angle),
          lng: cell.west + cell.size / 2 + radius * Math.cos(angle) };
      }) : octagon(cell.south, cell.west, cell.size).map(([lat, lng]) => ({ lat, lng })),
      altitudeMode: "CLAMP_TO_GROUND",
      fillColor: cell.color,
      strokeWidth: 0,
    });
    polygon.addEventListener("gmp-click", () => onSelect(cell));
    return polygon;
  }
  function showNearbyCells() {
    clearTimeout(cellTimer);
    cellTimer = undefined;
    const center = map.center;
    // Generous view radius in degrees, so tilted views still reach their horizon.
    const radius = center && Number.isFinite(map.range) ? map.range * 2 / 111320 : Infinity;
    const stretch = center ? Math.max(.05, Math.cos(center.lat * Math.PI / 180)) : 1;
    const next = new Map();
    for (const item of ranked) {
      if (ranked.length > maxCells && radius < 90) {
        const lat = item.latitude - center.lat;
        const lng = (((item.longitude - center.lng) % 360 + 540) % 360 - 180) * stretch;
        if (lat * lat + lng * lng > radius * radius) continue;
      }
      next.set(item, shown.get(item) ?? polygonFor(item));
      if (next.size === maxCells) break;
    }
    for (const [item, polygon] of shown) if (!next.has(item)) polygon.remove();
    const added = document.createDocumentFragment();
    for (const [item, polygon] of next) if (!shown.has(item)) added.append(polygon);
    map.append(added);
    shown = next;
  }
  const scheduleCells = () => {
    if (ranked.length > maxCells) cellTimer ??= setTimeout(showNearbyCells, 250);
  };
  map.addEventListener("gmp-centerchange", scheduleCells);
  map.addEventListener("gmp-rangechange", scheduleCells);

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Google 3D imagery took too long to load.")), 25000);
      const steady = (event) => { if (event.isSteady) finish(); };
      const failed = () => finish(new Error("Google 3D imagery could not be loaded."));
      function finish(error) {
        clearTimeout(timeout);
        map.removeEventListener("gmp-steadychange", steady);
        map.removeEventListener("gmp-error", failed);
        if (error) reject(error);
        else resolve();
      }
      map.addEventListener("gmp-steadychange", steady);
      map.addEventListener("gmp-error", failed);
      host.append(zoomSurface);
    });
  } catch (error) {
    cancelZoom();
    zoomSurface.remove();
    throw error;
  }
  map.addEventListener("gmp-error", onError);
  map.addEventListener("gmp-centerchange", onViewportChange);
  map.addEventListener("gmp-rangechange", onViewportChange);

  return {
    getViewport() {
      if (!map.center || !Number.isFinite(map.range)) return;
      const { lat, lng } = map.center;
      const radius = map.range / 111320;
      const aspect = host.clientWidth / Math.max(1, host.clientHeight);
      const longitudeRadius = Math.min(180, radius * Math.max(1, aspect) / Math.max(.05, Math.cos(lat * Math.PI / 180)));
      return cameraBounds(lat, lng, radius, longitudeRadius);
    },
    changeZoom(factor) {
      cancelZoom();
      changeZoom(factor);
    },
    center(area) {
      cancelZoom();
      Object.assign(map, camera(area));
      reportCenter();
    },
    setCells(items, showDots) {
      if (dots !== showDots) {
        for (const polygon of shown.values()) polygon.remove();
        shown.clear();
      }
      dots = showDots;
      ranked = [...items].sort((a, b) => b.detection_count - a.detection_count);
      showNearbyCells();
    },
    reportCenter,
    destroy() {
      cancelZoom();
      clearTimeout(cellTimer);
      zoomSurface.remove();
    },
  };
}
