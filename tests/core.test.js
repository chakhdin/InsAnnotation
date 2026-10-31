// Unit tests of InsAnnotationCore.jsh, run outside PixInsight:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// the .jsh declares only vars and functions, which become properties of the context object
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "InsAnnotationCore.jsh"), "utf8"), ctx);
const core = ctx;

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);
const kw = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value, strippedValue: value }));

test("headerValue strips quotes and padding, honours the name priority", () => {
   const k = kw({ TELESCOP: "'FSQ-85  '", OTHER: "x" });
   assert.equal(core.headerValue(k, ["TELESCOP"]), "FSQ-85");
   assert.equal(core.headerValue(k, ["MISSING", "OTHER"]), "x");
   assert.equal(core.headerValue(k, ["MISSING"]), "");
});

test("observationDate", () => {
   assert.equal(core.observationDate(kw({ "DATE-OBS": "2026-03-07T21:15:00" })), "07/03/2026");
   assert.equal(core.observationDate(kw({})), "");
});

test("parseAngle accepts the usual notations", () => {
   const cases = {
      "7.3456": 7.3456, "-9.2": -9.2, "1.5E1": 15, "12d34m56s": 12.582222222222223, "12:34:56": 12.582222222222223,
      "N 12 34 56": 12.582222222222223, "12 34 56 S": -12.582222222222223, "W 5 10 30": -5.175000000000001,
      "-0 30 00": -0.5, "12 30 W": -12.5
   };
   for (const [input, expected] of Object.entries(cases)) {
      near(core.parseAngle(input), expected, 1e-9);
   }
   assert.ok(isNaN(core.parseAngle("abc")));
   assert.ok(isNaN(core.parseAngle("")));
});

test("findLocation returns the nearest site within its radius", () => {
   const sites = [
      { name: "A", lat: 45.0, lon: 9.0, radiusKm: 1 },
      { name: "B", lat: 45.0, lon: 9.05, radiusKm: 10 }
   ];
   assert.equal(core.findLocation(sites, 45.0, 9.001), "A");
   assert.equal(core.findLocation(sites, 45.0, 9.04), "B");
   assert.equal(core.findLocation(sites, 50, 10), "");
   assert.equal(core.findLocation([], 45, 9), "");
   near(core.distanceKm(0, 0, 0, 1), 111.19, 0.05);
});

test("buildSetupLines skips empty fields and applies the line prefix", () => {
   const lines = core.buildSetupLines({ telescope: " FSQ ", mount: "", total: "7h", location: "Somewhere" });
   assert.deepEqual(Array.from(lines), ["FSQ", "Total exposure: 7h", "Somewhere"]);
});

test("sanitizeLayout falls back to the defaults", () => {
   const l = core.sanitizeLayout({ fontName: "  ", color: "red", titleCorner: "XX", setupCorner: "TR", setupAlign: "right" });
   assert.equal(l.fontName, core.LAYOUT_DEFAULTS.fontName);
   assert.equal(l.color, core.LAYOUT_DEFAULTS.color);
   assert.equal(l.titleCorner, "TL");
   assert.equal(l.setupCorner, "TR");
   assert.equal(l.copyrightCorner, "BL");
   assert.equal(l.setupAlign, "right");
});

test("wcsFieldFromKeywords: centred solution", () => {
   // 1000 x 800 px, 1 arcsec/px, reference pixel at the centre, north up, east left
   const s = 1 / 3600;
   const k = kw({ CRVAL1: 100, CRVAL2: 0, CRPIX1: 500.5, CRPIX2: 400.5, CD1_1: -s, CD1_2: 0, CD2_1: 0, CD2_2: s });
   const { field, missing } = core.wcsFieldFromKeywords(k, 1000, 800);
   assert.deepEqual(Array.from(missing), []);
   near(field.ra, 100);
   near(field.dec, 0);
   near(field.radius, 0.5 * Math.sqrt(1000 * 1000 + 800 * 800) * s);
});

test("wcsFieldFromKeywords: off-centre reference pixel and missing keywords", () => {
   const s = 1 / 3600;
   const k = kw({ CRVAL1: 100, CRVAL2: 10, CRPIX1: 1, CRPIX2: 1, CDELT1: -s, CDELT2: s });
   const { field } = core.wcsFieldFromKeywords(k, 1001, 1001);
   near(field.dec, 10 + 500 * s, 1e-9);                                  // 500 px north of the reference pixel
   near(field.ra, 100 - 500 * s / Math.cos(field.dec * Math.PI / 180), 1e-9);
   const none = core.wcsFieldFromKeywords(kw({ CRVAL1: 1 }), 100, 100);
   assert.equal(none.field, null);
   assert.ok(none.missing.length > 0);
});

test("wcsFieldFromProperties: reference pixel, observation centre and unusable input", () => {
   const s = 1 / 3600;
   const matrix = [[-s, 0], [0, s]];
   const centred = core.wcsFieldFromProperties({ refCelestial: [50, 20], refImage: [500, 400], matrix }, 1000, 800);
   near(centred.ra, 50);
   near(centred.dec, 20);
   const shifted = core.wcsFieldFromProperties({ refCelestial: [50, 20], refImage: [0, 0], matrix }, 1000, 800);
   near(shifted.dec, 20 + 400 * s, 1e-9);
   const noRef = core.wcsFieldFromProperties({ refCelestial: [50, 20], matrix }, 1000, 800);
   near(noRef.ra, 50);
   const obs = core.wcsFieldFromProperties({ center: { ra: 51, dec: 21 }, refCelestial: [50, 20], matrix }, 1000, 800);
   near(obs.ra, 51);
   near(obs.dec, 21);
   assert.equal(core.wcsFieldFromProperties({ refCelestial: [50, 20] }, 1000, 800), null);
   assert.equal(core.wcsFieldFromProperties({ refCelestial: [50, 20], matrix: [[0, 0], [0, 0]] }, 1000, 800), null);
   assert.equal(core.wcsFieldFromProperties({ matrix }, 1000, 800), null);
});

test("ADQL builders", () => {
   const field = { ra: 83.82, dec: -5.39, radius: 1.5 };
   const sized = core.buildSizedAdql(field);
   assert.match(sized, /CIRCLE\('ICRS', 83\.82000, -5\.39000, 1\.5000\)/);
   assert.match(sized, /galdim_majaxis BETWEEN 1 AND 216\.00/);
   assert.match(sized, /main_id LIKE 'NAME %'/);
   const unsized = core.buildUnsizedAdql(field, true);
   assert.match(unsized, /galdim_majaxis IS NULL/);
   assert.match(unsized, /ORDER BY nbref DESC/);
   assert.doesNotMatch(unsized, /NAME/);
   assert.doesNotMatch(core.buildUnsizedAdql(field, false), /nbref/);
});

test("parseSimbadNames", () => {
   const body = 'main_id\tgaldim_majaxis\r\n"NAME Orion Nebula"\t90.0\r\n"M  43"\t20.0\r\n"M  43"\t20.0\r\n';
   assert.deepEqual(Array.from(core.parseSimbadNames(body)), ["Orion Nebula", "M 43"]);
   assert.deepEqual(Array.from(core.parseSimbadNames("main_id\n")), []);
   assert.equal(core.parseSimbadNames("<html>error</html>"), null);
});

// ---- layout ----------------------------------------------------------------------------------------------------------------

// a fake font: every character is 0.6 em wide, the ascent is 0.9 em and the descent 0.3 em, an em being the size in points times 4/3 pixels
const em = (size) => size * 4 / 3;
const measure = (text, size) => text.length * 0.6 * em(size);
const metrics = (size) => ({ ascent: 0.9 * em(size), descent: 0.3 * em(size) });
const base = (extra) => Object.assign({
   width: 1440, height: 720, title: "NGC 1851", copyright: "(c) 2026 Me", setupLines: ["Scope", "Camera", "Total exposure: 7h"],
   layout: core.LAYOUT_DEFAULTS, measure, metrics
}, extra);
const byText = (layout, text) => layout.items.find((i) => i.text == text);

test("default layout reproduces the original placement", () => {
   const l = core.computeLayout(base());
   const fontSize = 14, setupSize = 12, margin = 20, h = 720;
   const title = byText(l, "NGC 1851");
   assert.equal(title.x, margin);
   assert.equal(title.y, 12);
   const copy = byText(l, "(c) 2026 Me");
   assert.equal(copy.x, margin);
   assert.equal(copy.y, h - 40);
   assert.equal(copy.italic, true);
   // the setup block shares the baseline of the copyright: it is lowered by the difference of the ascents
   const shift = metrics(fontSize).ascent - metrics(setupSize).ascent;
   const last = byText(l, "Total exposure: 7h"), first = byText(l, "Scope");
   near(last.y, h - 40 + shift);
   assert.ok(shift > 0);
   // the lines are one font height (ascent + descent) apart
   const pitch = (metrics(setupSize).ascent + metrics(setupSize).descent) * core.LINE_SPACING;
   near(first.y, h - 40 + shift - 2 * pitch);
   // flush-left block whose widest line ends at the right margin
   near(last.x + measure("Total exposure: 7h", setupSize), 1440 - margin);
   assert.equal(first.x, last.x);
   assert.deepEqual(Array.from(l.warnings), []);
});

test("right alignment of the setup lines", () => {
   const l = core.computeLayout(base({ layout: Object.assign({}, core.LAYOUT_DEFAULTS, { setupAlign: "right" }) }));
   for (const text of ["Scope", "Camera", "Total exposure: 7h"]) {
      near(byText(l, text).x + measure(text, 12), 1440 - 20);
   }
});

test("elements in the same corner are stacked and keep their order", () => {
   const layout = Object.assign({}, core.LAYOUT_DEFAULTS, { titleCorner: "BL", setupCorner: "BL", copyrightCorner: "BL" });
   const l = core.computeLayout(base({ layout }));
   const copy = byText(l, "(c) 2026 Me"), title = byText(l, "NGC 1851"), setupLast = byText(l, "Total exposure: 7h");
   assert.ok(copy.y > setupLast.y && setupLast.y > title.y, "copyright lowest, then the setup block, then the title");
   assert.ok(l.items.every((i) => i.x == 20));
});

test("top corners stack downwards", () => {
   const layout = Object.assign({}, core.LAYOUT_DEFAULTS, { titleCorner: "TR", setupCorner: "TR", copyrightCorner: "TR" });
   const l = core.computeLayout(base({ layout }));
   assert.ok(byText(l, "NGC 1851").y < byText(l, "Scope").y && byText(l, "Scope").y < byText(l, "(c) 2026 Me").y);
});

test("texts too wide for one edge are shrunk, never below the minimum", () => {
   const long = "A very long telescope and camera description line";
   const roomy = core.computeLayout(base({ width: 1000, setupLines: [long, "Total exposure: 7h"] }));
   assert.equal(byText(roomy, long).size, 12, "fits without shrinking");

   const tight = core.computeLayout(base({ width: 500, setupLines: [long, "Total exposure: 7h"] }));
   const setupItem = byText(tight, long), copy = byText(tight, "(c) 2026 Me");
   assert.ok(setupItem.size < 12 || copy.size < 14, "something was shrunk");
   assert.ok(setupItem.x >= copy.x + measure("(c) 2026 Me", copy.size), "no overlap on the bottom edge");
   assert.deepEqual(Array.from(tight.warnings), []);

   const hopeless = core.computeLayout(base({ width: 100 }));
   assert.ok(hopeless.warnings.length > 0);
   assert.ok(hopeless.items.every((i) => i.size >= core.MIN_FONT_SIZE - 1e-9));
});

test("empty texts produce no items", () => {
   const l = core.computeLayout(base({ title: "", copyright: "", setupLines: [] }));
   assert.equal(l.items.length, 0);
});
