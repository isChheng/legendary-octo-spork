import { bindMapZoom } from "./map-zoom.js";
import { createEarthRenderer } from "./earth-renderer.js";
import { cameraBounds, octagon } from "./map-detail.js";

const radians = Math.PI / 180;
const degrees = 1 / radians;
const wrap = (value) => ((value + 180) % 360 + 360) % 360 - 180;
const globeRadius = (width, height) => Math.min(width * .43, height * .35);
const globeCenterY = .46;
const flatMapWidth = (width, height) => Math.max(width, height * 1.4);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const flatZoomMin = 1;
const flatZoomMax = 48;
const maxZoomTurn = 3;

export function createGlobe(canvas, onSelect, onMove, onViewportChange) {
  const ctx = canvas.getContext("2d");
  const earthCanvas = document.createElement("canvas");
  earthCanvas.id = "globe-earth";
  earthCanvas.setAttribute("aria-hidden", "true");
  canvas.before(earthCanvas);
  let renderer = createEarthRenderer(earthCanvas);
  const texture = document.createElement("canvas");
  const earth = new Image();
  let source;
  let longitude = 104.8;
  let latitude = 17;
  let zoom = 1;
  let flatZoom = 1;
  let flat = false;
  let steeringRemaining = 0;
  let zoomAnchor;
  let cells = [];
  let cellsByLocation = new Map();
  let cellSize;
  let dots = true;
  let frame;
  let drag;
  let geometry;
  let base;
  let reportedLatitude;
  let reportedLongitude;
  let reportedViewport;

  function loadFallbackImage() {
    if (!earth.naturalWidth || source) return;
    const pixels = texture.getContext("2d", { willReadFrequently: true });
    texture.width = earth.naturalWidth;
    texture.height = earth.naturalHeight;
    pixels.drawImage(earth, 0, 0);
    source = pixels.getImageData(0, 0, texture.width, texture.height);
  }

  earth.onload = () => {
    if (renderer && !renderer.setImage(earth)) renderer = null;
    if (!renderer) loadFallbackImage();
    geometry = undefined;
    redraw();
  };
  earth.src = new URL("./assets/earth.jpg", import.meta.url).href;

  earthCanvas.addEventListener("webglcontextlost", () => {
    renderer = null;
    loadFallbackImage();
    geometry = undefined;
    redraw();
  });

  function redraw() {
    if (frame === undefined) frame = requestAnimationFrame(() => draw());
  }

  function drawEarth(width, height, radius, centerX, centerY, sinLat, cosLat) {
    const image = ctx.createImageData(width, height);
    const output = image.data;
    const input = source?.data;
    for (let py = Math.max(0, Math.floor(centerY - radius)); py < Math.min(height, centerY + radius); py++) {
      const y = (centerY - py - .5) / radius;
      const half = radius * Math.sqrt(Math.max(0, 1 - y * y));
      for (let px = Math.max(0, Math.floor(centerX - half)); px < Math.min(width, centerX + half); px++) {
        const x = (px + .5 - centerX) / radius;
        const depth = 1 - x * x - y * y;
        if (depth <= 0) continue;
        const z = Math.sqrt(depth);
        const light = .32 + .58 * Math.max(0, -.48 * x + .42 * y + .77 * z);
        const index = (py * width + px) * 4;
        const u = Math.atan2(x, z * cosLat - y * sinLat) * degrees;
        const lon = wrap(longitude + u);
        const lat = Math.asin(y * cosLat + z * sinLat) * degrees;
        const sx = Math.floor((lon + 180) / 360 * texture.width);
        const sy = Math.min(texture.height - 1, Math.floor((90 - lat) / 180 * texture.height));
        const sample = (sy * texture.width + sx) * 4;
        const rim = (1 - z) ** 4;
        output[index] = (input ? input[sample] : 29) * light + 15 * rim;
        output[index + 1] = (input ? input[sample + 1] : 52) * light + 43 * rim;
        output[index + 2] = (input ? input[sample + 2] : 80) * light + 82 * rim;
        output[index + 3] = Math.min(255, depth * radius * 148);
      }
    }
    return image;
  }

  function drawFlatMap(width, height, centerX, centerY, worldWidth) {
    ctx.clearRect(0, 0, width, height);
    const west = centerX - (longitude + 180) * worldWidth / 360;
    const north = centerY - (90 - latitude) * worldWidth / 360;
    ctx.fillStyle = "#131d2a";
    ctx.fillRect(0, north, width, worldWidth / 2);
    if (!earth.naturalWidth) return;
    // Draw the adjacent copy when the viewport crosses the antimeridian.
    const left = west > 0 ? west - worldWidth : west;
    for (let x = left; x < width; x += worldWidth) {
      ctx.drawImage(earth, x, north, worldWidth, worldWidth / 2);
    }
  }

  function drawFlatCells(width, height, centerX, centerY, worldWidth) {
    const pixelsPerDegree = worldWidth / 360;
    const size = cellSize * pixelsPerDegree;
    const inset = Math.min(.35, size * .035);
    for (const { cell } of cells) {
      const y = centerY - (cell.south + cellSize - latitude) * pixelsPerDegree;
      if (y + size < 0 || y > height) continue;
      const west = centerX + (cell.west - longitude) * pixelsPerDegree;
      const first = west + worldWidth * Math.ceil((-size - west) / worldWidth);
      ctx.fillStyle = cell.color;
      for (let x = first; x < width; x += worldWidth) {
        if (dots) drawDot(cell, x + (cell.longitude - cell.west) * pixelsPerDegree,
          y + (cell.south + cellSize - cell.latitude) * pixelsPerDegree);
        else drawOctagon(x + size / 2, y + size / 2, size / 2 - inset);
      }
    }
  }

  function drawDot(cell, x, y) {
    drawOctagon(x, y, .7 + cell.strength * 1.4);
  }

  // A regular octagon with flat sides, `apothem` from centre to each side.
  function drawOctagon(x, y, apothem) {
    const cut = apothem * (Math.SQRT2 - 1);
    ctx.beginPath();
    ctx.moveTo(x - cut, y - apothem);
    ctx.lineTo(x + cut, y - apothem);
    ctx.lineTo(x + apothem, y - cut);
    ctx.lineTo(x + apothem, y + cut);
    ctx.lineTo(x + cut, y + apothem);
    ctx.lineTo(x - cut, y + apothem);
    ctx.lineTo(x - apothem, y + cut);
    ctx.lineTo(x - apothem, y - cut);
    ctx.closePath();
    ctx.fill();
  }

  function drawGlobeCells(width, height, centerX, centerY, radius, sinLat, cosLat) {
    const sinLon = Math.sin(longitude * radians);
    const cosLon = Math.cos(longitude * radians);
    function project({ east, north, up }) {
      const forward = north * cosLon + east * sinLon;
      return {
        x: east * cosLon - north * sinLon,
        y: up * cosLat - forward * sinLat,
        depth: up * sinLat + forward * cosLat,
      };
    }
    for (const { cell, corners, center } of cells) {
      if (dots) {
        const { x, y, depth } = project(center);
        if (depth <= 0) continue;
        ctx.fillStyle = cell.color;
        drawDot(cell, centerX + radius * x, centerY - radius * y);
        continue;
      }
      const projected = corners.map(project);
      if (projected.every(({ depth }) => depth <= 0)
        || projected.every(({ x }) => centerX + radius * x < 0)
        || projected.every(({ x }) => centerX + radius * x > width)
        || projected.every(({ y }) => centerY - radius * y < 0)
        || projected.every(({ y }) => centerY - radius * y > height)) continue;
      ctx.fillStyle = cell.color;
      ctx.beginPath();
      let previous = projected.at(-1);
      for (const point of projected) {
        if ((previous.depth > 0) !== (point.depth > 0)) {
          const fraction = previous.depth / (previous.depth - point.depth);
          const x = previous.x + fraction * (point.x - previous.x);
          const y = previous.y + fraction * (point.y - previous.y);
          const limb = radius / Math.hypot(x, y);
          ctx.lineTo(centerX + limb * x, centerY - limb * y);
        }
        if (point.depth > 0) ctx.lineTo(centerX + radius * point.x, centerY - radius * point.y);
        previous = point;
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  function cellAt(clientX, clientY) {
    if (!cellSize) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = rect.top + rect.height * (flat ? .5 : globeCenterY) - clientY;
    let lat;
    let lon;
    if (flat) {
      const degreesPerPixel = 360 / (flatMapWidth(rect.width, rect.height) * flatZoom);
      lat = latitude + y * degreesPerPixel;
      lon = longitude + x * degreesPerPixel;
    } else {
      const radius = globeRadius(rect.width, rect.height) * zoom;
      const across = x / radius;
      const up = y / radius;
      const depth = 1 - across * across - up * up;
      if (depth <= 0) return;
      const forward = Math.sqrt(depth);
      const sinLat = Math.sin(latitude * radians);
      const cosLat = Math.cos(latitude * radians);
      lat = Math.asin(clamp(up * cosLat + forward * sinLat, -1, 1)) * degrees;
      lon = longitude + Math.atan2(across, forward * cosLat - up * sinLat) * degrees;
    }
    if (Math.abs(lat) > 90) return;
    const south = Math.min(90 - cellSize, Math.floor(lat / cellSize) * cellSize);
    const west = Math.floor(wrap(lon) / cellSize) * cellSize;
    return cellsByLocation.get(`${south},${west}`);
  }

  function getViewport() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    if (flat) {
      const scale = 180 / (flatMapWidth(width, height) * flatZoom);
      return cameraBounds(latitude, longitude, height * scale, width * scale);
    }
    const diagonal = Math.hypot(width / 2, height * (1 - globeCenterY));
    const angle = Math.asin(Math.min(1, diagonal / (globeRadius(width, height) * zoom)));
    const lonRadius = Math.abs(latitude) + angle * degrees >= 90
      ? 180 : Math.asin(Math.sin(angle) / Math.cos(latitude * radians)) * degrees;
    return cameraBounds(latitude, longitude, angle * degrees, lonRadius);
  }

  function draw(fullResolution = false) {
    frame = undefined;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const pixelLimit = renderer || fullResolution ? 1200 : 480;
    const scale = Math.min(1, pixelLimit / Math.max(box.width, box.height));
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const radius = globeRadius(width, height) * zoom;
    const centerX = width / 2;
    const centerY = height * (flat ? .5 : globeCenterY);
    const worldWidth = flatMapWidth(width, height) * flatZoom;
    const sinLat = Math.sin(latitude * radians);
    const cosLat = Math.cos(latitude * radians);
    const key = [width, height, zoom, latitude, longitude].join(",");
    if (flat) {
      drawFlatMap(width, height, centerX, centerY, worldWidth);
    } else if (renderer) {
      renderer.draw(width, height, radius, centerX, centerY, sinLat, cosLat, longitude);
      ctx.clearRect(0, 0, width, height);
    } else {
      if (geometry !== key) {
        base = drawEarth(width, height, radius, centerX, centerY, sinLat, cosLat);
        geometry = key;
      }
      ctx.putImageData(base, 0, 0);
    }
    if (cells.length) {
      if (flat) drawFlatCells(width, height, centerX, centerY, worldWidth);
      else drawGlobeCells(width, height, centerX, centerY, radius, sinLat, cosLat);
    }
    if (latitude !== reportedLatitude || longitude !== reportedLongitude) {
      reportedLatitude = latitude;
      reportedLongitude = longitude;
      onMove(latitude, longitude);
    }
    const viewport = [key, flat, flatZoom].join(",");
    if (viewport !== reportedViewport) {
      reportedViewport = viewport;
      onViewportChange();
    }
  }

  function rotate(dx, dy) {
    longitude = wrap(longitude + dx);
    latitude = Math.max(-85, Math.min(85, latitude + dy));
    redraw();
  }

  function steerZoom(next, clientX, clientY) {
    if (!steeringRemaining || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      zoomAnchor = undefined;
      return;
    }
    const box = canvas.getBoundingClientRect();
    const radius = globeRadius(box.width, box.height);
    if (!radius) return;
    const x = (clientX - box.left - box.width / 2) / radius;
    const y = (box.top + box.height * globeCenterY - clientY) / radius;
    if (!zoomAnchor || zoomAnchor.x !== x || zoomAnchor.y !== y) {
      const across = x / zoom;
      const up = y / zoom;
      const depth = 1 - across * across - up * up;
      zoomAnchor = undefined;
      if (depth <= 0) return;

      // Unproject the cursor onto the visible side of the sphere.
      const sinLat = Math.sin(latitude * radians);
      const cosLat = Math.cos(latitude * radians);
      const forward = Math.sqrt(depth);
      const horizontal = forward * cosLat - up * sinLat;
      const vertical = up * cosLat + forward * sinLat;
      zoomAnchor = { x, y, vertical, horizontal, across, lon: longitude + Math.atan2(across, horizontal) * degrees };
    }

    const across = x / next;
    const up = y / next;
    const depth = 1 - across * across - up * up;
    const { vertical, horizontal, across: initialAcross, lon } = zoomAnchor;
    const horizontalSquared = horizontal * horizontal + initialAcross * initialAcross - across * across;
    if (depth <= 0 || horizontalSquared <= 0) return;

    // Solve for the new center that puts the same surface point under the cursor, with north up.
    const forward = Math.sqrt(depth);
    const nextHorizontal = (horizontal < 0 ? -1 : 1) * Math.sqrt(horizontalSquared);
    const targetLon = lon - Math.atan2(across, nextHorizontal) * degrees;
    const targetLat = (Math.atan2(vertical, nextHorizontal) - Math.atan2(up, forward)) * degrees;
    const dx = wrap(targetLon - longitude);
    const dy = clamp(wrap(targetLat), -85, 85) - latitude;
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-8) return;
    const turn = Math.min(.5, steeringRemaining, distance);
    steeringRemaining -= turn;
    longitude = wrap(longitude + dx * turn / distance);
    latitude += dy * turn / distance;
  }

  function changeZoom(factor, clientX, clientY) {
    if (flat) {
      const next = clamp(flatZoom * factor, flatZoomMin, flatZoomMax);
      if (next === flatZoom) return false;
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
        const box = canvas.getBoundingClientRect();
        const degreesPerPixel = 360 * (1 / flatZoom - 1 / next) / flatMapWidth(box.width, box.height);
        longitude = wrap(longitude + (clientX - box.left - box.width / 2) * degreesPerPixel);
        latitude = clamp(latitude - (clientY - box.top - box.height / 2) * degreesPerPixel, -85, 85);
      }
      flatZoom = next;
      redraw();
      return;
    }
    const next = Math.min(7, Math.max(1, zoom * factor));
    if (next === zoom) return false;
    steerZoom(next, clientX, clientY);
    zoom = next;
    redraw();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    cancelZoom();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 2 && !drag.moved) return;
    let sensitivity = .35 / zoom;
    if (flat) {
      const box = canvas.getBoundingClientRect();
      sensitivity = 360 / (flatMapWidth(box.width, box.height) * flatZoom);
    }
    rotate(-dx * sensitivity, dy * sensitivity);
    Object.assign(drag, { x: event.clientX, y: event.clientY, moved: true });
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved) {
      const cell = cellAt(event.clientX, event.clientY);
      if (cell) onSelect(cell);
    }
    drag = undefined;
  });
  canvas.addEventListener("lostpointercapture", (event) => {
    if (drag?.id === event.pointerId) drag = undefined;
  });
  const { cancelZoom, zoomBy } = bindMapZoom(canvas, changeZoom, {
    getFlatScale: () => flat ? { current: flatZoom, min: flatZoomMin, max: flatZoomMax } : null,
    onStart() {
      drag = undefined;
      steeringRemaining = maxZoomTurn;
      zoomAnchor = undefined;
    },
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      zoomBy(event.key === "-" ? 1 / 1.35 : 1.35);
      return;
    }
    const arrows = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] };
    if (!arrows[event.key]) return;
    event.preventDefault();
    cancelZoom();
    rotate(...arrows[event.key].map((step) => flat ? step / flatZoom : step));
  });
  new ResizeObserver(redraw).observe(canvas);

  return {
    changeZoom: zoomBy,
    getViewport,
    setFlat(enabled) {
      cancelZoom();
      flat = enabled;
      earthCanvas.hidden = flat;
      canvas.setAttribute("aria-label", `Interactive ${flat ? "2D map. Drag or use the arrow keys to pan." : "Earth globe. Drag or use the arrow keys to rotate."} Pinch, scroll, or press plus and minus to zoom.`);
      redraw();
    },
    exportImage(callback) {
      if (frame !== undefined) cancelAnimationFrame(frame);
      draw(true);
      const image = document.createElement("canvas");
      image.width = canvas.width;
      image.height = canvas.height;
      const exportContext = image.getContext("2d");
      if (renderer && !flat) exportContext.drawImage(earthCanvas, 0, 0);
      exportContext.drawImage(canvas, 0, 0);
      image.toBlob(callback, "image/png");
      if (!renderer) redraw();
    },
    center(bounds) {
      cancelZoom();
      const lonSpan = (bounds.max_lon - bounds.min_lon + 360) % 360 || 360;
      const latSpan = bounds.max_lat - bounds.min_lat;
      longitude = wrap(bounds.min_lon + lonSpan / 2);
      latitude = (bounds.min_lat + bounds.max_lat) / 2;
      zoom = Math.min(4, Math.max(1, 54 / Math.max(lonSpan, latSpan)));
      const box = canvas.parentElement.getBoundingClientRect();
      const worldWidth = flatMapWidth(box.width, box.height);
      flatZoom = worldWidth
        ? clamp(300 * Math.min(box.width / Math.max(lonSpan, 1), box.height / Math.max(latSpan, 1)) / worldWidth, 1, 32)
        : 1;
      redraw();
    },
    setCells(items, showDots) {
      dots = showDots;
      cellSize = items[0]?.size;
      cellsByLocation = new Map(items.map((cell) => [`${cell.south},${cell.west}`, cell]));
      cells = items.map((cell) => {
        if (dots) return { cell, center: spherePoint(cell.latitude, cell.longitude) };
        const corners = octagon(cell.south, cell.west, cell.size).map(([lat, lon]) => spherePoint(lat, lon));
        return { cell, corners };
      });
      redraw();
    },
  };
}

function spherePoint(latitude, longitude) {
  const lat = latitude * radians;
  const lon = longitude * radians;
  const cosLat = Math.cos(lat);
  return {
    east: cosLat * Math.sin(lon), north: cosLat * Math.cos(lon), up: Math.sin(lat),
  };
}

