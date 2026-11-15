// Mouse wheels, trackpads, and the flat map use different easing rates.
const wheelEasing = .18;
const trackpadEasing = .10;
const flatEasing = 1 / 14;
const maxLogZoomRate = 7.2;
const maxLogZoomFrame = .12;
const anchorTolerance = 3;
const anchorTimeout = 600;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function bindMapZoom(surface, changeZoom, { getFlatScale, onStart } = {}) {
  let gestureScale;
  let gestureX;
  let gestureY;
  let frame;
  let lastFrame;
  let pending = 0;
  let easing = wheelEasing;
  let anchorX;
  let anchorY;
  let lastInput = -Infinity;

  function cancelZoom() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = 0;
    lastInput = -Infinity;
    gestureScale = undefined;
  }

  function tick(now) {
    frame = undefined;
    const dt = clamp((now - lastFrame) / 1000, .001, .064);
    lastFrame = now;
    const fraction = 1 - Math.exp(-dt / easing);
    // Ease in log units on the globe and in linear scale on the flat map.
    const easedStep = easing === flatEasing
      ? Math.log1p(Math.expm1(pending) * fraction)
      : pending * fraction;
    const limit = Math.min(maxLogZoomRate * dt, maxLogZoomFrame);
    const step = clamp(easedStep, -limit, limit);
    const settled = Math.abs(pending) <= limit && Math.abs(pending - step) < (easing === flatEasing ? .002 : .0001);
    const applied = settled ? pending : step;
    pending -= applied;
    if (changeZoom(Math.exp(applied), anchorX, anchorY) === false) pending = 0;
    if (pending) frame = requestAnimationFrame(tick);
  }

  function queueZoom(delta, eventX, eventY, tau, flatScale) {
    if (!delta) return;
    const now = performance.now();
    if (flatScale || eventX === undefined || anchorX === undefined || now - lastInput > anchorTimeout ||
        Math.hypot(eventX - anchorX, eventY - anchorY) > anchorTolerance) {
      anchorX = eventX;
      anchorY = eventY;
    }
    lastInput = now;
    easing = flatScale ? flatEasing : tau;
    // A direction change should take effect immediately instead of fighting the old glide.
    if (pending * delta < 0) pending = 0;
    pending = flatScale
      ? clamp(pending + delta, Math.log(flatScale.min / flatScale.current), Math.log(flatScale.max / flatScale.current))
      : clamp(pending + delta, -2.2, 2.2);
    if (frame === undefined && pending) {
      onStart?.();
      lastFrame = now;
      frame = requestAnimationFrame(tick);
    }
  }

  // Safari can expose a cumulative gesture scale instead of Ctrl+wheel.
  surface.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    event.stopPropagation();
    gestureScale = 1;
    gestureX = event.clientX;
    gestureY = event.clientY;
  }, { capture: true, passive: false });
  surface.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (gestureScale !== undefined && Number.isFinite(event.scale) && event.scale > 0) {
      queueZoom(Math.log(event.scale) - Math.log(gestureScale), gestureX, gestureY, trackpadEasing, getFlatScale?.());
      gestureScale = event.scale;
    }
  }, { capture: true, passive: false });
  surface.addEventListener("gestureend", (event) => {
    event.preventDefault();
    event.stopPropagation();
    gestureScale = undefined;
  }, { capture: true, passive: false });
  surface.addEventListener("wheel", (event) => {
    const mode = event.deltaMode;
    const delta = event.deltaY;
    if (!Number.isFinite(delta) || !delta || !event.cancelable || (event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    if (gestureScale !== undefined) return;

    const flatScale = getFlatScale?.();
    if (flatScale) {
      const pixels = mode === 1 ? delta * 16 : delta;
      queueZoom(clamp(-pixels * .0025, -.9, .9), event.clientX, event.clientY, flatEasing, flatScale);
      return;
    }

    const pixels = mode === 1 ? delta * 33 : mode === 2 ? delta * 400 : delta;
    const notch = mode !== 0 || (!event.ctrlKey && event.deltaX === 0 && Number.isInteger(delta) && Math.abs(delta) >= 40);
    const sensitivity = event.ctrlKey ? .008 : notch ? .0028 : .0014;
    queueZoom(-pixels * sensitivity, event.clientX, event.clientY, notch ? wheelEasing : trackpadEasing);
  }, { capture: true, passive: false });

  return {
    cancelZoom,
    zoomBy(factor) {
      queueZoom(Math.log(factor), undefined, undefined, wheelEasing, getFlatScale?.());
    },
  };
}
