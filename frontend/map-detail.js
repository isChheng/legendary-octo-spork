export const wrapLongitude = (longitude) => ((longitude + 180) % 360 + 360) % 360 - 180;

export function cameraBounds(lat, lon, latitudeRadius, longitudeRadius) {
  return [
    Math.max(-90, lat - latitudeRadius), Math.min(90, lat + latitudeRadius),
    lon - longitudeRadius, lon + longitudeRadius,
  ];
}

// Grid cells are drawn as regular octagons inscribed in their square.
// Returns the eight [latitude, longitude] corners, counter-clockwise.
export function octagon(south, west, size, inset = size * .025) {
  const north = south + size - inset;
  const east = west + size - inset;
  south += inset;
  west += inset;
  const cut = (east - west) / (2 + Math.SQRT2);
  return [
    [south, west + cut], [south, east - cut], [south + cut, east], [north - cut, east],
    [north, east - cut], [north, west + cut], [north - cut, west], [south + cut, west],
  ];
}

export function mapDetail([south, north, west, east]) {
  const span = Math.max(north - south, east - west);
  if (span >= 115) return { dots: true, size: 1 };

  // Pad and round the request to blocks of cells so short pans reuse data.
  const dots = span >= 85;
  const size = dots ? .5 : 2 ** Math.max(-8, Math.ceil(Math.log2(span / 192)));
  const block = (dots ? 8 : 16) * size;
  const lower = (value) => (Math.floor(value / block) - 1) * block;
  const upper = (value) => (Math.ceil(value / block) + 1) * block;
  const left = lower(west);
  const right = upper(east);
  const longitudes = right - left >= 360 ? [-180, 180] : [wrapLongitude(left), wrapLongitude(right)];
  return {
    dots,
    size,
    viewport: [Math.max(-90, lower(south)), Math.min(90, upper(north)), ...longitudes],
  };
}
