// Answers Luminite's data requests in the browser, with no server.
//
// DuckDB-WASM reads the Parquet products written by tools/build_web_data.py
// straight from static hosting, fetching only the byte ranges a query needs.
// Each function returns the same JSON shape as the matching FastAPI route in
// firms_pipeline/api.py, so the rest of the app does not know the difference.
//
// Two results differ slightly from the server. Area edges snap to the grid the
// query reads (0.1° for the calendar, the map's own cells for the map), so a
// box that cuts through a cell includes the whole cell when its center is
// inside. And a detection at exactly 180° east is not drawn at street-level zoom.

const DUCKDB = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";
const BITS = { terra: 1, aqua: 2, snpp: 4, noaa20: 8 };
const PLATFORMS = { modis: ["terra", "aqua"], viirs_snpp: ["snpp"], viirs_noaa20: ["noaa20"] };
const MAP_CELL_SIZES = Array.from({ length: 10 }, (_, index) => 2 ** (index - 8));
const GLOBAL_REGION = -999;
const DATASET_SQL = "CASE platform WHEN 'snpp' THEN 'viirs_snpp' WHEN 'noaa20' THEN 'viirs_noaa20' ELSE 'modis' END";

const fail = (message) => { throw new Error(message); };
const pad = (value) => String(value).padStart(2, "0");
const list = (values) => values.join(", ");

function day(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "") || Number.isNaN(Date.parse(value))) fail(`${name} must be a date`);
  return value;
}

function number(value, name, low, high) {
  const parsed = Number(value);
  if (value == null || value === "" || !Number.isFinite(parsed) || parsed < low || parsed > high) fail(`${name} is out of range`);
  return parsed;
}

function dataset(value, required) {
  if (value == null || value === "") return required ? fail("dataset is required") : null;
  return value in PLATFORMS ? value : fail("Unknown dataset");
}

function span(params, maximumDays) {
  const start = day(params.start_date, "start_date");
  const end = day(params.end_date, "end_date");
  if (end < start) fail("end_date must be on or after start_date");
  if ((Date.parse(end) - Date.parse(start)) / 864e5 + 1 > maximumDays) fail(`Date range may not exceed ${maximumDays} days`);
  return { start, end };
}

function box(params) {
  const bounds = {
    south: number(params.min_lat, "min_lat", -90, 90), north: number(params.max_lat, "max_lat", -90, 90),
    west: number(params.min_lon, "min_lon", -180, 180), east: number(params.max_lon, "max_lon", -180, 180),
  };
  if (bounds.north < bounds.south) fail("Invalid latitude bounds");
  return bounds;
}

// Months from start to end as [year, month] pairs.
function monthsBetween(start, end) {
  const months = [];
  let [year, month] = start.split("-").map(Number);
  const [lastYear, lastMonth] = end.split("-").map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push([year, month]);
    if (++month > 12) { month = 1; year++; }
  }
  return months;
}

const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const wholeMonths = (start, end) => start.endsWith("-01")
  && Number(end.slice(8)) === lastDay(Number(end.slice(0, 4)), Number(end.slice(5, 7)));

// Cells of a grid with `resolution` cells per degree whose centers lie in [low, high).
function cellRange(low, high, resolution) {
  const edge = (value) => Math.ceil(Math.round(value * resolution * 1e6) / 1e6 - .5);
  return [edge(low), edge(high) - 1];
}

function between(column, [low, high], wraps) {
  return wraps ? `(${column} >= ${low} OR ${column} <= ${high})` : `${column} BETWEEN ${low} AND ${high}`;
}

export function createData(baseUrl) {
  const root = new URL(baseUrl.replace(/\/*$/, "/"), location.href).href;
  let meta;
  let engine;
  let queue = Promise.resolve();
  const results = new Map();

  function loadMeta() {
    meta ??= fetch(root + "meta.json").then((response) => {
      if (!response.ok) throw new Error(`The data archive could not be reached (${response.status})`);
      return response.json();
    }).then((value) => ({
      ...value,
      months: new Set(value.months),
      years: new Set(value.months.map((month) => Number(month.slice(0, 4)))),
    })).catch((error) => { meta = undefined; throw error; });
    return meta;
  }

  function connect() {
    engine ??= (async () => {
      const duckdb = await import(DUCKDB);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      // A worker must be same-origin, so wrap the CDN script in a local one.
      const script = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
      const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(script));
      await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(script);
      return database.connect();
    })().catch((error) => { engine = undefined; throw error; });
    return engine;
  }

  // One query at a time; requests that were cancelled while waiting are skipped.
  function rows(sql, signal) {
    const run = queue.then(async () => {
      if (signal?.aborted) return [];
      const connection = await connect();
      if (signal?.aborted) return [];
      const table = await connection.query(sql);
      return table.toArray().map((row) => row.toJSON());
    });
    queue = run.catch(() => {});
    return run;
  }

  const files = (folder, names) => "read_parquet([" + list(names.map((name) => `'${root}${folder}/${name}.parquet'`)) + "])";
  const monthFiles = (available, folder, months) => {
    const names = months.filter(([year, month]) => available.has(`${year}-${pad(month)}`)).map(([year, month]) => `${year}/${pad(month)}`);
    return names.length ? files(folder, names) : null;
  };

  async function calendar(params, signal) {
    const { years, coverage_monthly: coverage, calibration } = await loadMeta();
    const month = params.month == null ? null : number(params.month, "month", 1, 12);
    const { start, end } = span(params, month == null ? 366 : 366 * 6);
    const bounds = box(params);
    const selected = dataset(params.dataset);
    const interval = params.interval === "month" ? "month" : "day";
    const range = monthsBetween(start, end).filter(([, value]) => month == null || value === month);
    const fileYears = [...new Set(range.map(([year]) => year))].filter((year) => years.has(year));
    if (!fileYears.length) return { data: [], count: 0, truncated: false };

    // The platforms that observed every day of a month, as a bitmask.
    const complete = new Map();
    for (const row of coverage) {
      if (!row.is_complete_month || !row.platform_complete || (selected && row.dataset !== selected)) continue;
      complete.set(row.month_start, (complete.get(row.month_start) ?? 0) | BITS[row.platform]);
    }
    const covered = range.map(([year, value]) => `${year}-${pad(value)}-01`).filter((key) => complete.has(key));
    const coverageSql = covered.length
      ? `VALUES ${list(covered.map((key) => `(DATE '${key}', ${complete.get(key)})`))}`
      : "SELECT NULL::DATE, NULL::INTEGER WHERE false";

    const keep = selected ? PLATFORMS[selected].reduce((mask, platform) => mask | BITS[platform], 0) : 15;
    const counts = Object.keys(PLATFORMS).map((key) => (selected && key !== selected ? `0 AS ${key}` : key));
    const wraps = bounds.west > bounds.east;
    const whole = Object.values(bounds).every(Number.isInteger);
    const monthFilter = month == null ? "" : ` AND month(d) = ${month}`;
    let base;
    if (whole) {
      // Whole-degree areas are answered from the per-region totals.
      const monthly = interval === "month" && wholeMonths(start, end);
      const column = monthly ? "month_start" : "acq_date";
      base = `
        SELECT d, ry, rx, m, n, ${list(counts)} FROM (
          SELECT ${column} AS d, ry, rx, (mask & ${keep}) AS m, n, modis, viirs_snpp, viirs_noaa20
          FROM ${files(monthly ? "cal/region_month" : "cal/region_day", fileYears)}
          WHERE ${column} BETWEEN DATE '${start}' AND DATE '${end}'
            AND ${between("ry", [bounds.south, bounds.north - 1])}
            AND ${between("rx", [bounds.west, bounds.east - 1], wraps)}
            AND (mask & ${keep}) != 0
        ) WHERE true${monthFilter}`;
    } else {
      base = `
        SELECT d, floor(y / 10)::INTEGER AS ry, floor(x / 10)::INTEGER AS rx, m, count(*) AS n,
          ${list(Object.keys(PLATFORMS).map((key) => (selected && key !== selected ? `0 AS ${key}` : `sum(${key}) AS ${key}`)))}
        FROM (
          SELECT acq_date AS d, y, x, (mask & ${keep}) AS m, modis, viirs_snpp, viirs_noaa20
          FROM ${files("cal/cells", fileYears)}
          WHERE acq_date BETWEEN DATE '${start}' AND DATE '${end}'
            AND ${between("y", cellRange(bounds.south, bounds.north, 10))}
            AND ${between("x", cellRange(bounds.west, bounds.east, 10), wraps)}
            AND (mask & ${keep}) != 0
        ) WHERE true${monthFilter}
        GROUP BY ALL`;
    }

    // harmonized_cell_days restates each month in the cell-days the full
    // constellation would have reported; see firms_pipeline/api.py.
    const target = calibration.available ? calibration.targets[selected ?? "all"] : null;
    let harmonized = "NULL::DOUBLE";
    let factors = "";
    let joins = "";
    if (target != null) {
      const factorMonths = [...new Set(range.map(([, value]) => value))];
      const factor = `CASE WHEN r.source = ${target} THEN 1 ELSE coalesce(f.factor, g.factor) END`;
      harmonized = `CASE WHEN bool_or(r.source IS NULL OR (r.usable > 0 AND ${factor} IS NULL)) THEN NULL
        ELSE round(sum(r.usable * ${factor})::DOUBLE, 1) END`;
      factors = `, factors AS MATERIALIZED (
        SELECT ry, rx, month, source, factor FROM ${files("cal", ["factors"])}
        WHERE target = ${target} AND month IN (${list(factorMonths)})
      )`;
      joins = `
        LEFT JOIN factors f ON f.ry = r.ry AND f.rx = r.rx AND f.month = month(r.d) AND f.source = r.source
        LEFT JOIN factors g ON g.ry = ${GLOBAL_REGION} AND g.month = month(r.d) AND g.source = r.source`;
    }
    const data = await rows(`
      WITH coverage(month_start, source) AS (${coverageSql}),
      base AS (${base}),
      regional AS (
        SELECT b.d, b.ry, b.rx, v.source,
          sum(b.n) AS cell_days,
          sum(CASE WHEN (b.m & v.source) != 0 THEN b.n ELSE 0 END) AS usable,
          sum(b.modis) AS modis, sum(b.viirs_snpp) AS viirs_snpp, sum(b.viirs_noaa20) AS viirs_noaa20,
          sum(CASE WHEN (b.m & 3) != 0 AND (b.m & 12) != 0 THEN b.n ELSE 0 END) AS shared
        FROM base b LEFT JOIN coverage v ON v.month_start = date_trunc('month', b.d)::DATE
        GROUP BY ALL
      )${factors}
      SELECT strftime(date_trunc('${interval}', r.d), '%Y-%m-%d') AS date,
        sum(r.cell_days)::DOUBLE AS active_cell_days,
        sum(r.modis)::DOUBLE AS modis,
        sum(r.viirs_snpp)::DOUBLE AS viirs_snpp,
        sum(r.viirs_noaa20)::DOUBLE AS viirs_noaa20,
        sum(r.shared)::DOUBLE AS shared_cell_days,
        ${harmonized} AS harmonized_cell_days
      FROM regional r${joins}
      GROUP BY 1 ORDER BY 1
    `, signal);
    return { data, count: data.length, truncated: false };
  }

  async function grid(params, signal) {
    const { months: available } = await loadMeta();
    const { start, end } = span(params, 31);
    const bounds = box(params);
    const selected = dataset(params.dataset);
    const days = (params.days ?? []).map((value) => day(value, "days"));
    if (days.some((value) => value < start || value > end)) fail("Selected days must be within the date range");
    const viewport = params.viewport?.length ? params.viewport.map(Number) : null;
    const [south, north, west, east] = viewport ?? [bounds.south, bounds.north, bounds.west, bounds.east];
    if (!(south >= -90 && south <= north && north <= 90 && west >= -180 && west <= 180 && east >= -180 && east <= 180)) {
      fail("Invalid map viewport bounds");
    }
    const latitudeSpan = north - south;
    const longitudeSpan = east - west + (east < west ? 360 : 0);
    let size = params.cell_size == null || params.cell_size === "" ? null : Number(params.cell_size);
    if (size == null) {
      const widest = Math.max(latitudeSpan, longitudeSpan);
      size = [[12, .25], [60, .5], [100, 1], [360, 2]].find(([threshold]) => widest <= threshold)[1];
    } else if (!MAP_CELL_SIZES.includes(size)) fail("Unsupported map cell size");
    if ((latitudeSpan / size + 1) * (longitudeSpan / size + 1) > 70_000) fail("Map viewport is too large for this cell size");
    if (viewport?.some((bound) => bound % size)) fail("Map viewport must align to grid cells");

    const range = monthsBetween(start, end);
    const wraps = bounds.west > bounds.east;
    const platforms = selected ? `platform IN (${list(PLATFORMS[selected].map((name) => `'${name}'`))})` : null;
    const top = 90 / size - 1;
    let source;
    let observations;
    let observedDays = "count(DISTINCT acq_date)";
    let center = ["avg(latitude)", "avg(longitude)"];
    if (size <= 1 / 32) {
      // Street-level cells are counted from the individual detections.
      source = monthFiles(available, "points", range);
      const conditions = [
        `acq_date BETWEEN DATE '${start}' AND DATE '${end}'`,
        `lat_e5 BETWEEN ${Math.round(bounds.south * 1e5)} AND ${Math.round(bounds.north * 1e5)}`,
        between("lon_e5", [Math.round(bounds.west * 1e5), Math.round(bounds.east * 1e5)], wraps),
      ];
      if (viewport) {
        conditions.push(`lat_e5 >= ${Math.round(south * 1e5)}`, `lat_e5 ${north === 90 ? "<=" : "<"} ${Math.round(north * 1e5)}`,
          `(lon_e5 >= ${Math.round(west * 1e5)} ${west <= east ? "AND" : "OR"} lon_e5 < ${Math.round(east * 1e5)})`);
      }
      if (platforms) conditions.push(platforms);
      if (days.length) conditions.push(`acq_date IN (${list(days.map((value) => `DATE '${value}'`))})`);
      observations = `
        SELECT floor(longitude / ${size}) AS gx, least(${top}, floor(latitude / ${size})) AS gy,
          latitude, longitude, acq_date, platform, 1 AS n, frp_c / 100.0 AS frp
        FROM (
          SELECT lat_e5 / 1e5 AS latitude, (CASE WHEN lon_e5 = 18000000 THEN -18000000 ELSE lon_e5 END) / 1e5 AS longitude,
            acq_date, platform, frp_c
          FROM ${source} WHERE ${conditions.join(" AND ")}
        )`;
    } else {
      const resolution = size >= .25 ? 4 : 16;
      const monthly = resolution === 4 && !days.length && range.length === 1 && wholeMonths(start, end);
      const scale = size * resolution;
      source = monthFiles(available, resolution === 16 ? "map/d16" : monthly ? "map/m4" : "map/d4", range);
      const conditions = [
        between("y", cellRange(bounds.south, bounds.north, resolution)),
        between("x", cellRange(bounds.west, bounds.east, resolution), wraps),
      ];
      if (!monthly) conditions.push(`acq_date BETWEEN DATE '${start}' AND DATE '${end}'`);
      if (viewport) {
        conditions.push(`y >= ${south * resolution}`);
        if (north < 90) conditions.push(`y < ${north * resolution}`);
        conditions.push(`(x >= ${west * resolution} ${west <= east ? "AND" : "OR"} x < ${east * resolution})`);
      }
      if (platforms) conditions.push(platforms);
      if (days.length) conditions.push(`acq_date IN (${list(days.map((value) => `DATE '${value}'`))})`);
      const sums = resolution === 4 ? "sum_lat, sum_lon" : "NULL AS sum_lat, NULL AS sum_lon";
      observations = `
        SELECT floor(x / ${scale}) AS gx, least(${top}, floor(y / ${scale})) AS gy, platform, n, frp, ${sums},
          ${monthly ? "days" : "acq_date"}
        FROM ${source} WHERE ${conditions.join(" AND ")}`;
      if (monthly) observedDays = "bit_count(bit_or(days))";
      center = resolution === 4
        ? ["sum(sum_lat) / sum(n)", "sum(sum_lon) / sum(n)"]
        : [`gy * ${size} + ${size / 2}`, `gx * ${size} + ${size / 2}`];
    }
    if (!source) return { data: [], cell_size: size };
    const data = await rows(`
      WITH observations AS (${observations})
      SELECT (gx * ${size})::DOUBLE AS west, (gy * ${size})::DOUBLE AS south,
        (${center[0]})::DOUBLE AS mean_latitude, (${center[1]})::DOUBLE AS mean_longitude,
        sum(n)::DOUBLE AS detection_count, (${observedDays})::INTEGER AS observed_days,
        string_agg(DISTINCT platform, ',' ORDER BY platform) AS platforms, sum(frp)::DOUBLE AS frp_sum_mw
      FROM observations
      GROUP BY gx, gy ORDER BY gy, gx
    `, signal);
    for (const row of data) row.platforms = row.platforms.split(",");
    return { data, cell_size: size };
  }

  async function hotspots(params, signal) {
    const { months: available } = await loadMeta();
    const selected = dataset(params.dataset, true);
    const { start, end } = span(params, 31);
    const bounds = box(params);
    const limit = params.limit == null ? 1000 : number(params.limit, "limit", 1, 5000);
    const source = monthFiles(available, "points", monthsBetween(start, end));
    if (!source) return { data: [], count: 0, truncated: false };
    const conditions = [
      `platform IN (${list(PLATFORMS[selected].map((name) => `'${name}'`))})`,
      `acq_date BETWEEN DATE '${start}' AND DATE '${end}'`,
      `lat_e5 BETWEEN ${Math.round(bounds.south * 1e5)} AND ${Math.round(bounds.north * 1e5)}`,
      between("lon_e5", [Math.round(bounds.west * 1e5), Math.round(bounds.east * 1e5)], bounds.west > bounds.east),
    ];
    if (params.platform != null) conditions.push(`platform = '${params.platform in BITS ? params.platform : fail("Unknown platform")}'`);
    if (params.confidence_class != null) {
      conditions.push(`confidence_class = '${["low", "nominal", "high"].includes(params.confidence_class) ? params.confidence_class : fail("Unknown confidence class")}'`);
    }
    if (params.min_frp_mw != null) conditions.push(`frp_c >= ${Math.round(number(params.min_frp_mw, "min_frp_mw", 0, Infinity) * 100)}`);
    if (params.daynight != null) conditions.push(`daynight = '${["D", "N"].includes(params.daynight) ? params.daynight : fail("Unknown daynight")}'`);
    const data = await rows(`
      SELECT strftime(acq_date, '%Y-%m-%d') || 'T' || lpad((minute // 60)::VARCHAR, 2, '0') || ':' || lpad((minute % 60)::VARCHAR, 2, '0') || ':00' AS observation_time_utc,
        lat_e5 / 1e5 AS latitude, lon_e5 / 1e5 AS longitude, ${DATASET_SQL} AS dataset, platform,
        frp_c / 100.0 AS frp_mw, confidence_class, confidence_raw, daynight, hotspot_type::INTEGER AS hotspot_type, source_stage
      FROM ${source}
      WHERE ${conditions.join(" AND ")}
      ORDER BY acq_date, minute, lat_e5, lon_e5
      LIMIT ${limit + 1}
    `, signal);
    return { data: data.slice(0, limit), count: Math.min(data.length, limit), truncated: data.length > limit };
  }

  const routes = {
    "/health": async () => (await loadMeta()).health,
    "/v1/calibration": async () => (await loadMeta()).calibration,
    "/v1/coverage": async () => { const data = (await loadMeta()).coverage; return { data, count: data.length, truncated: false }; },
    "/v1/coverage/monthly": async () => { const data = (await loadMeta()).coverage_monthly; return { data, count: data.length, truncated: false }; },
    "/v1/calendar": calendar,
    "/v1/spatial/grid": grid,
    "/v1/hotspots": hotspots,
  };

  // `params` is a plain object or URLSearchParams; repeated keys become arrays.
  return async function request(path, params, signal) {
    const route = routes[path] ?? fail(`Luminite cannot answer ${path} without a server`);
    const search = new URLSearchParams(params ?? {});
    const key = `${path}?${search}`;
    if (results.has(key)) return results.get(key);
    const values = {};
    for (const key of new Set(search.keys())) {
      values[key] = key === "days" || key === "viewport" ? search.getAll(key) : search.get(key);
    }
    // A cancelled in-flight query must never supply an empty result to a newer request.
    const result = await route(values, signal);
    if (!signal?.aborted) {
      results.set(key, result);
      if (results.size > 80) results.delete(results.keys().next().value);
    }
    return result;
  };
}
