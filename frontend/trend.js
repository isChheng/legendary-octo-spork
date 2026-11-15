// Seasonal Mann-Kendall trend test (Hirsch, Slack and Smith 1982) with the
// seasonal Sen slope. Each calendar month is compared only with the same
// month in other years, so the burning season does not register as a trend.
// The test is rank-based: it makes no assumption about the size or
// distribution of the values, and corrects for ties.

function normalCdf(z) {
  // Abramowitz and Stegun 26.2.17, accurate to about 1e-7.
  const t = 1 / (1 + .2316419 * Math.abs(z));
  const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)
    * t * (.31938153 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

// points: [{ year, month, value }]. Returns null when no month has two years.
export function seasonalMannKendall(points) {
  const seasons = new Map();
  for (const point of points) {
    if (!seasons.has(point.month)) seasons.set(point.month, []);
    seasons.get(point.month).push(point);
  }
  let s = 0;
  let variance = 0;
  let pairs = 0;
  const slopes = [];
  for (const season of seasons.values()) {
    const n = season.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const years = season[j].year - season[i].year;
        if (!years) continue;
        const change = (season[j].value - season[i].value) / years;
        s += Math.sign(change);
        slopes.push(change);
      }
    }
    pairs += n * (n - 1) / 2;
    variance += n * (n - 1) * (2 * n + 5);
    const ties = new Map();
    for (const { value } of season) ties.set(value, (ties.get(value) ?? 0) + 1);
    for (const t of ties.values()) variance -= t * (t - 1) * (2 * t + 5);
  }
  variance /= 18;
  if (!slopes.length || !variance) return null;
  const z = (s - Math.sign(s)) / Math.sqrt(variance);
  slopes.sort((a, b) => a - b);
  const middle = (slopes.length - 1) / 2;
  return {
    s,
    z,
    p: 2 * (1 - normalCdf(Math.abs(z))),
    tau: s / pairs,
    slope: (slopes[Math.floor(middle)] + slopes[Math.ceil(middle)]) / 2,
    n: points.length,
  };
}
