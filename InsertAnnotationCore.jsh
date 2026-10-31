// InsertAnnotationCore.jsh - the logic of Insert Annotation that needs no PixInsight object (no view, no dialog, no Console).
// It is included by InsertAnnotation.js and loaded as is by the unit tests in tests/ (node --test tests/).
// Keep it to top-level `var` and `function` declarations: the tests read them from a node vm context.

// ---------------------------------------------------------------------------------------------------------------------
// Setup fields and layout options
// ---------------------------------------------------------------------------------------------------------------------

// setup detail fields, in the order they are drawn
// linePrefix: text printed before the value; tip: tooltip of the edit box
var SETUP_FIELDS = [
   { key: "telescope", label: "Telescope",           tip: "Printed as typed. Filled from TELESCOP or Instrument:Telescope:Name." },
   { key: "mount",     label: "Mount",               tip: "Printed as typed. Never filled automatically." },
   { key: "camera",    label: "Camera",              tip: "Printed as typed. Filled from INSTRUME or Instrument:Camera:Name." },
   { key: "filters",   label: "Filters (if any)",    tip: "Printed as typed. Filled from FILTER or Instrument:Filter:Name." },
   { key: "exposure",  label: "Exposure per filter", tip: "Printed as typed, for example L 40x300 s, R 20x300 s. Never filled automatically." },
   { key: "total",     label: "Total exposure",      tip: "Printed as \"Total exposure: <value>\". Never filled automatically.", linePrefix: "Total exposure: " },
   { key: "location",  label: "Location(s)",         tip: "Printed as typed, or pick a saved site on the right." }
];

var CORNERS = [
   { id: "TL", label: "Top left" },
   { id: "TR", label: "Top right" },
   { id: "BL", label: "Bottom left" },
   { id: "BR", label: "Bottom right" }
];

var SETUP_ALIGNMENTS = [
   { id: "left",  label: "Left" },
   { id: "right", label: "Right" }
];

// defaults of the layout and appearance options (what the script did before they became options)
var LAYOUT_DEFAULTS = {
   fontName: "Palatino Linotype",
   color: 0xFFC0C0C0,            // AARRGGBB
   titleCorner: "TL",
   setupCorner: "BR",
   copyrightCorner: "BL",
   setupAlign: "left"            // alignment of the lines inside the setup block
};

// layout options with every value checked: anything invalid falls back to the default
function sanitizeLayout(layout) {
   var out = {};
   var l = layout || {};
   var validId = function(list, id) { return list.some(function(e) { return e.id == id; }); };
   out.fontName = (typeof l.fontName == "string" && l.fontName.trim().length > 0) ? l.fontName.trim() : LAYOUT_DEFAULTS.fontName;
   out.color = (typeof l.color == "number" && isFinite(l.color)) ? (l.color >>> 0) : LAYOUT_DEFAULTS.color;
   out.titleCorner = validId(CORNERS, l.titleCorner) ? l.titleCorner : LAYOUT_DEFAULTS.titleCorner;
   out.setupCorner = validId(CORNERS, l.setupCorner) ? l.setupCorner : LAYOUT_DEFAULTS.setupCorner;
   out.copyrightCorner = validId(CORNERS, l.copyrightCorner) ? l.copyrightCorner : LAYOUT_DEFAULTS.copyrightCorner;
   out.setupAlign = validId(SETUP_ALIGNMENTS, l.setupAlign) ? l.setupAlign : LAYOUT_DEFAULTS.setupAlign;
   return out;
}

// one line per non-empty field, value only (no label unless the field has a linePrefix)
function buildSetupLines(setup) {
   var lines = [];
   for (var i = 0; i < SETUP_FIELDS.length; ++i) {
      var f = SETUP_FIELDS[i];
      var v = (setup[f.key] || "").trim();
      if (v) {
         lines.push((f.linePrefix || "") + v);
      }
   }
   return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Header values, angles, sites
// ---------------------------------------------------------------------------------------------------------------------

// FITS keyword value as plain text (quotes and padding removed)
function headerValue(keywords, names) {
   for (var i = 0; i < names.length; ++i) {
      for (var j = 0; j < keywords.length; ++j) {
         var k = keywords[j];
         if (k.name.toUpperCase() == names[i]) {
            var v = k.strippedValue != undefined ? k.strippedValue : k.value;
            v = String(v).replace(/^'+|'+$/g, "").trim();
            if (v.length > 0) {
               return v;
            }
         }
      }
   }
   return "";
}

// observation date DD/MM/YYYY from DATE-OBS, or "" if absent
function observationDate(keywords) {
   var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(headerValue(keywords, ["DATE-OBS"]));
   return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
}

// decimal degrees, or "dd mm ss" / "dd:mm:ss" with optional N/S/E/W; NaN if not parsable
function parseAngle(s) {
   if (!s) {
      return NaN;
   }
   var t = s.trim();
   // plain number, including an exponent
   if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
      return Number(t);
   }
   // d/m/s markers glued to a digit ("12d34m56s") are separators; a hemisphere letter is a separate leading/trailing letter
   t = t.toUpperCase().replace(/[°′″'"]/g, " ").replace(/(\d)[DMS]/g, "$1 ").trim();
   var sign = (/^[SW]/.test(t) || /[SW]$/.test(t) || t.charAt(0) == "-") ? -1 : 1;
   var parts = t.replace(/[NSEW\-+]/g, " ").split(/[\s:]+/).filter(function(p) { return p.length > 0; }).map(Number);
   if (parts.length == 0 || parts.some(isNaN)) {
      return NaN;
   }
   var deg = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
   return sign * deg;
}

function distanceKm(lat1, lon1, lat2, lon2) {
   var r = Math.PI / 180;
   var a = Math.pow(Math.sin((lat2 - lat1) * r / 2), 2) +
           Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lon2 - lon1) * r / 2), 2);
   return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// name of the nearest site of the list within its radius, or "" if none
function findLocation(locations, lat, lon) {
   var best = "", bestDist = Infinity;
   for (var i = 0; i < locations.length; ++i) {
      var loc = locations[i];
      var d = distanceKm(lat, lon, loc.lat, loc.lon);
      if (d <= loc.radiusKm && d < bestDist) {
         best = loc.name;
         bestDist = d;
      }
   }
   return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plate solution -> field of view
// ---------------------------------------------------------------------------------------------------------------------

// centre (RA, Dec) and radius, all in degrees, of an image from a linear WCS: the reference point crval, the offset (dx, dy) in
// pixels from the reference pixel to the image centre, and the CD matrix in degrees per pixel
function wcsField(crval1, crval2, dx, dy, cd11, cd12, cd21, cd22, w, h) {
   var dec = crval2 + cd21 * dx + cd22 * dy;
   var ra = crval1 + (cd11 * dx + cd12 * dy) / Math.cos(dec * Math.PI / 180);
   ra = (ra % 360 + 360) % 360;
   var scaleX = Math.sqrt(cd11 * cd11 + cd21 * cd21);   // degrees per pixel
   var scaleY = Math.sqrt(cd12 * cd12 + cd22 * cd22);
   var radius = 0.5 * Math.sqrt(Math.pow(w * scaleX, 2) + Math.pow(h * scaleY, 2));
   return { ra: ra, dec: dec, radius: radius, scaleX: scaleX, scaleY: scaleY };
}

// field from FITS WCS keywords: { field, missing }; field is null (and missing lists the keywords) if there is no usable solution
function wcsFieldFromKeywords(keywords, w, h) {
   var num = function(names) { return parseFloat(headerValue(keywords, names)); };
   var crval1 = num(["CRVAL1"]), crval2 = num(["CRVAL2"]);
   var crpix1 = num(["CRPIX1"]), crpix2 = num(["CRPIX2"]);
   var cd11 = num(["CD1_1"]), cd12 = num(["CD1_2"]), cd21 = num(["CD2_1"]), cd22 = num(["CD2_2"]);
   if (isNaN(cd11) && isNaN(cd22)) {
      // CDELT-only solutions
      cd11 = num(["CDELT1"]);
      cd22 = num(["CDELT2"]);
      cd12 = cd21 = 0;
   }
   var required = { CRVAL1: crval1, CRVAL2: crval2, CRPIX1: crpix1, CRPIX2: crpix2, "CD1_1/CDELT1": cd11, "CD2_2/CDELT2": cd22 };
   var missing = Object.keys(required).filter(function(k) { return isNaN(required[k]); });
   if (missing.length > 0) {
      return { field: null, missing: missing };
   }
   if (isNaN(cd12)) cd12 = 0;
   if (isNaN(cd21)) cd21 = 0;
   // FITS pixel coordinates are 1-based, the image centre is at ((w + 1) / 2, (h + 1) / 2)
   var f = wcsField(crval1, crval2, (w + 1) / 2 - crpix1, (h + 1) / 2 - crpix2, cd11, cd12, cd21, cd22, w, h);
   f.crval1 = crval1; f.crval2 = crval2; f.crpix1 = crpix1; f.crpix2 = crpix2;
   return { field: f, missing: [] };
}

// field from the XISF astrometric solution properties, given as plain values:
//   center: {ra, dec} (Observation:Center) or null
//   refCelestial: [ra, dec] and refImage: [x, y] (AstrometricSolution:Reference*Coordinates) or null
//   matrix: [[a, b], [c, d]] (AstrometricSolution:LinearTransformationMatrix, degrees per pixel) or null
// image coordinates are continuous with the origin at the top left corner, so the image centre is (w / 2, h / 2);
// null if the field cannot be determined
function wcsFieldFromProperties(p, w, h) {
   if (!p.matrix) {
      return null;
   }
   var cd11 = p.matrix[0][0], cd12 = p.matrix[0][1], cd21 = p.matrix[1][0], cd22 = p.matrix[1][1];
   if (!(Math.sqrt(cd11 * cd11 + cd21 * cd21) > 0)) {
      return null;
   }
   if (p.center) {
      var f0 = wcsField(p.center.ra, p.center.dec, 0, 0, cd11, cd12, cd21, cd22, w, h);
      f0.ra = Number(p.center.ra);
      f0.dec = Number(p.center.dec);
      return f0;
   }
   if (!p.refCelestial) {
      return null;
   }
   // without the reference pixel the solvers' convention applies: the reference point is the image centre
   var dx = p.refImage ? w / 2 - p.refImage[0] : 0;
   var dy = p.refImage ? h / 2 - p.refImage[1] : 0;
   return wcsField(p.refCelestial[0], p.refCelestial[1], dx, dy, cd11, cd12, cd21, cd22, w, h);
}

// ---------------------------------------------------------------------------------------------------------------------
// SIMBAD queries
// ---------------------------------------------------------------------------------------------------------------------

// well-known catalogues (main_id prefixes): in a wide field the biggest SIMBAD objects are otherwise obscure survey entries
var SIMBAD_CATALOGUES = ["NGC", "IC", "M", "LDN", "LBN", "Sh", "vdB", "B", "Cr", "Mel", "Abell"];

function simbadWhere(field, catalogues) {
   return "CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', " + field.ra.toFixed(5) + ", " + field.dec.toFixed(5) + ", " + field.radius.toFixed(4) + "))=1" +
          " AND (" + catalogues.map(function(c) { return "main_id LIKE '" + c + " %'"; }).join(" OR ") + ")";
}

// objects from 1 arcmin up to 120% of the field diameter (no sky-sized clouds), biggest first; NAME entries (common names) included
function buildSizedAdql(field) {
   var maxSize = (field.radius * 2 * 60 * 1.2).toFixed(2);
   return "SELECT TOP 25 main_id, galdim_majaxis FROM basic" +
          " WHERE " + simbadWhere(field, SIMBAD_CATALOGUES.concat(["NAME"])) +
          " AND galdim_majaxis BETWEEN 1 AND " + maxSize +
          " ORDER BY galdim_majaxis DESC";
}

// catalogue objects that SIMBAD has no size for (so the query above never returns them), most referenced first.
// NAME entries are left out: without a size they are mostly stars.
function buildUnsizedAdql(field, orderByReferences) {
   return "SELECT TOP 10 main_id" + (orderByReferences ? ", nbref" : "") + " FROM basic" +
          " WHERE " + simbadWhere(field, SIMBAD_CATALOGUES) +
          " AND galdim_majaxis IS NULL" +
          (orderByReferences ? " ORDER BY nbref DESC" : "");
}

// "NAME Orion Nebula" -> "Orion Nebula"
function cleanSimbadName(raw) {
   return (raw || "").replace(/"/g, "").replace(/^(NAME|\*|V\*)\s+/, "").replace(/\s+/g, " ").trim();
}

// object names, in response order, from a SIMBAD TSV response; null if the response is not a TSV that starts with main_id
// (an error page can come back with HTTP 200)
function parseSimbadNames(body) {
   var rows = body.split(/\r?\n/);
   if (!/^"?main_id"?(\t|$)/i.test(rows[0])) {
      return null;
   }
   var names = [];
   for (var i = 1; i < rows.length; ++i) {
      var name = cleanSimbadName(rows[i].split("\t")[0]);
      if (name && names.indexOf(name) < 0) {
         names.push(name);
      }
   }
   return names;
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout of the annotations
// ---------------------------------------------------------------------------------------------------------------------

var REFERENCE_HEIGHT = 720;     // sizes and margins are defined for an image 720 px tall and scale with the height
var MIN_FONT_SIZE = 8;          // the layout never shrinks a text below this (points)
var LINE_SPACING = 1.0;         // distance between lines, in font heights (ascent + descent)
var SETUP_SIZE_RATIO = 0.75;    // the setup block is smaller than the title and the copyright

// Positions of the title, the setup block and the copyright in the corners of an image.
// The Annotation process draws a font size given in points through the PixInsight display settings (UI scaling factor and
// font resolution), so widths and heights come from a Font created with that point size, never from a fixed pixel ratio.
//   spec: { width, height, title, copyright, setupLines, layout (see LAYOUT_DEFAULTS),
//           hasItalic (optional, default true): false when the font has no real italic face, the copyright is then upright,
//           measure(text, size, bold, italic) -> width in image pixels,
//           metrics(size, italic) -> { ascent, descent } of the font in image pixels, ascent being the distance
//           from the top of the text to its baseline }
// Returns { items: [{ text, x, y, size, italic }], warnings: [string], fontSize }, x and y being the top left corner of the text.
// Elements in the same corner are stacked from the image edge inwards (top corners: title, setup, copyright; bottom corners:
// copyright, setup, title); when the elements of the left and right corners of an edge are too wide to fit side by side, the
// widest one is shrunk.
function computeLayout(spec) {
   var w = spec.width, h = spec.height;
   var scale = h / REFERENCE_HEIGHT;
   var fontSize = Math.max(scale * 12 - 2, 14);
   var margin = scale * 20;
   var topY = scale * 12;
   var bottomY = h - scale * 40;
   var gap = margin;
   var layout = sanitizeLayout(spec.layout);
   var warnings = [];

   var els = [];
   if (spec.title) {
      els.push({ id: "title", lines: [spec.title], size: fontSize, italic: false, corner: layout.titleCorner, align: "left" });
   }
   if (spec.setupLines && spec.setupLines.length > 0) {
      els.push({ id: "setup", lines: spec.setupLines, size: Math.max(Math.round(fontSize * SETUP_SIZE_RATIO), 12), italic: false,
                 corner: layout.setupCorner, align: layout.setupAlign });
   }
   if (spec.copyright) {
      els.push({ id: "copyright", lines: [spec.copyright], size: fontSize, italic: spec.hasItalic !== false, corner: layout.copyrightCorner, align: "left" });
   }

   var lineWidth = function(el, line) { return spec.measure(line, el.size, true, el.italic); };
   var blockWidth = function(el) {
      return el.lines.reduce(function(m, line) { return Math.max(m, lineWidth(el, line)); }, 0);
   };
   var isTop = function(el) { return el.corner.charAt(0) == "T"; };
   var isLeft = function(el) { return el.corner.charAt(1) == "L"; };

   // fit the elements of each edge into the image width
   var available = w - 2 * margin;
   [true, false].forEach(function(top) {
      var onEdge = els.filter(function(e) { return isTop(e) == top; });
      for (var guard = 0; guard < 300; ++guard) {
         var left = onEdge.filter(isLeft).reduce(function(m, e) { return Math.max(m, blockWidth(e)); }, 0);
         var right = onEdge.filter(function(e) { return !isLeft(e); }).reduce(function(m, e) { return Math.max(m, blockWidth(e)); }, 0);
         var needed = (left > 0 && right > 0) ? left + right + gap : Math.max(left, right);
         if (needed <= available) {
            return;
         }
         var shrinkable = onEdge.filter(function(e) { return e.size * 0.95 >= MIN_FONT_SIZE; });
         if (shrinkable.length == 0) {
            warnings.push("The texts on the " + (top ? "top" : "bottom") + " edge are wider than the image and may overlap or be cut.");
            return;
         }
         var widest = shrinkable.reduce(function(a, b) { return blockWidth(b) > blockWidth(a) ? b : a; });
         widest.size *= 0.95;
      }
   });

   // place the elements, stacking those that share a corner
   var items = [];
   var order = ["title", "setup", "copyright"];
   CORNERS.forEach(function(corner) {
      var inCorner = order.map(function(id) { return els.filter(function(e) { return e.id == id; })[0]; })
                          .filter(function(e) { return e && e.corner == corner.id; });
      var top = corner.id.charAt(0) == "T";
      var left = corner.id.charAt(1) == "L";
      var cursor = top ? topY : bottomY;
      (top ? inCorner : inCorner.slice().reverse()).forEach(function(el) {
         var n = el.lines.length;
         var m = spec.metrics(el.size, el.italic);
         var pitch = (m.ascent + m.descent) * LINE_SPACING;
         var maxW = blockWidth(el);
         var blockLeft = left ? margin : Math.max(margin, w - margin - maxW);
         // texts at the bottom share the baseline of the reference font: a smaller font is lowered by the difference of the ascents
         var shift = top ? 0 : spec.metrics(fontSize, false).ascent - m.ascent;
         el.lines.forEach(function(line, i) {
            var x = el.align == "right" ? blockLeft + maxW - lineWidth(el, line) : blockLeft;
            var y = top ? cursor + i * pitch : cursor + shift - (n - 1 - i) * pitch;
            items.push({ text: line, x: x, y: y, size: el.size, italic: el.italic });
         });
         cursor += (top ? 1 : -1) * n * pitch;
      });
   });
   return { items: items, warnings: warnings, fontSize: fontSize };
}

// ---- Shareable (resampled) PNG: size-limited copy -------------------------------------------------------------------------

// factor below which the search for a file under the size limit is abandoned (each side of the image)
var SHARE_MIN_FACTOR = 0.25;

// true if the shareable copy is needed: the full-size PNG is not already under the limit
function shareCopyNeeded(fullPngBytes, limitBytes) {
   return !(fullPngBytes > 0 && fullPngBytes <= limitBytes);
}

// scale factor (both dimensions) of the next attempt; null = give up.
// previous = factor of the file measured (1 for the full-size PNG), bytes = its size. PNG size grows about with the pixel count, hence the square root;
// the 0.95 margin guarantees progress (each step is at most 0.95 of the previous factor) even when the estimate is optimistic.
function nextShareFactor(previous, bytes, limitBytes) {
   if (!(bytes > limitBytes)) {
      return null;
   }
   var next = previous * Math.sqrt(limitBytes / bytes) * 0.95;
   return next < SHARE_MIN_FACTOR ? null : next;
}

// ---- Titles remembered per image --------------------------------------------------------------------------------------------

// maximum number of images whose title is remembered; the oldest ones are forgotten first
var TITLES_MAX = 200;

// returns a copy of the map { imageKey: title } with the title of imageKey set (most recent last), or removed if the title is empty
function updateTitleMap(map, key, title, max) {
   var out = {};
   var keys = Object.keys(map || {}).filter(function(k) { return k != key && typeof map[k] == "string"; });
   if (title) {
      keys.push(key);
   }
   keys = keys.slice(Math.max(0, keys.length - (max || TITLES_MAX)));
   keys.forEach(function(k) { out[k] = k == key ? title : map[k]; });
   return out;
}
