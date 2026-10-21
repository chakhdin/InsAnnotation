#engine v8
#feature-id Render > InsertAnnotation
#feature-info This script inserts a title, the setup details and the copyright, and optionally saves XISF and PNG annotated files. The setup details and the copyright are remembered between runs and PixInsight launches.

#include <pjsr/DataType.jsh>
#include <pjsr/TextAlign.jsh>

#define SETTINGS_KEY_PREFIX "InsAnnotation/"

// name in the default copyright "© <year> <name>"; the copyright you enter is remembered between runs, so this is only the first-run default
#define DEFAULT_AUTHOR "Your Name"

// setup detail fields, in the order they are drawn (top to bottom)
var SETUP_FIELDS = [
   { key: "telescope", label: "Telescope" },
   { key: "mount",     label: "Mount" },
   { key: "camera",    label: "Camera" },
   { key: "filters",   label: "Filters (if any)", prefix: "Filters" },
   { key: "exposure",  label: "Exposure per filter", prefix: "Exposure" },
   { key: "total",     label: "Total exposure", linePrefix: "Total exposure: " },
   { key: "location",  label: "Location(s)", prefix: "Location" }
];

// known imaging sites, matched against the SITELAT/SITELONG header keywords (decimal degrees, N and E positive)
// radiusKm: a header position closer than this to the site is reported with its name
var LOCATIONS = [
   { name: "Il Pratone dei Milanesi (PV), Italy", lat: 44.7159036, lon: 9.2085517, radiusKm: 1 },
   { name: "Ca' del Monte (PV), Italy",           lat: 44.8168673, lon: 9.0742150, radiusKm: 1 },
   { name: "Saint Barthelemy (AO), Italy",        lat: 45.7898110, lon: 7.4781477, radiusKm: 1 },
   // approximate: centre of Brallo di Pregola, not the observatory itself
   { name: "Astrobrallo (PV), Italy",             lat: 44.7381861, lon: 9.2813700, radiusKm: 5 },
   { name: "San Giuliano (MI), Italy",            lat: 45.39,      lon: 9.30,      radiusKm: 3 }
];

// FITS keyword value as plain text (quotes and padding removed)
function headerValue(keywords, names) {
   for (let n of names) {
      for (let k of keywords) {
         if (k.name.toUpperCase() == n) {
            let v = k.strippedValue != undefined ? k.strippedValue : k.value;
            v = String(v).replace(/^'+|'+$/g, "").trim();
            if (v.length > 0) {
               return v;
            }
         }
      }
   }
   return "";
}

// keywords of a FITS/XISF file, read without loading the pixel data; null on failure
function readFileKeywords(path) {
   let kw = null;
   let fi = null;
   try {
      let format = new FileFormat(File.extractExtension(path), true/*toRead*/, false/*toWrite*/);
      fi = new FileFormatInstance(format);
      if (fi.open(path, "verbosity 0").length > 0) {
         kw = fi.keywords;
      }
   } catch (e) {
      Console.criticalln("Cannot read " + path + ": " + e.message);
   }
   if (fi) {
      fi.close();
   }
   return kw;
}

// decimal degrees, or "dd mm ss" / "dd:mm:ss" with optional N/S/E/W; NaN if not parsable
function parseAngle(s) {
   if (!s) {
      return NaN;
   }
   let t = s.toUpperCase();
   let sign = (t.indexOf("S") >= 0 || t.indexOf("W") >= 0 || t.trim().charAt(0) == "-") ? -1 : 1;
   let parts = t.replace(/[NSEW\-+]/g, " ").split(/[\s:°'"′″dms]+/).filter(p => p.length > 0).map(Number);
   if (parts.length == 0 || parts.some(isNaN)) {
      return NaN;
   }
   let deg = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
   return sign * deg;
}

function distanceKm(lat1, lon1, lat2, lon2) {
   let r = Math.PI / 180;
   let a = Math.pow(Math.sin((lat2 - lat1) * r / 2), 2) +
           Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lon2 - lon1) * r / 2), 2);
   return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// name of the nearest known site within its radius, or "" if none
function findLocation(lat, lon) {
   let best = "", bestDist = Infinity;
   for (let loc of LOCATIONS) {
      let d = distanceKm(lat, lon, loc.lat, loc.lon);
      if (d <= loc.radiusKm && d < bestDist) {
         best = loc.name;
         bestDist = d;
      }
   }
   return best;
}

// XISF stores the astrometric solution as view properties rather than FITS keywords
function solvedFieldFromProperties(view) {
   let ids = [];
   try {
      ids = view.properties.filter(id => /^(AstrometricSolution:(ReferenceCelestialCoordinates|LinearTransformationMatrix|ReferenceImageCoordinates)|Observation:Center)/.test(id));
   } catch (e) {
      Console.writeln("[lookup] cannot list view properties: " + e.message);
   }
   Console.writeln("[lookup] relevant properties: " + (ids.length ? ids.join(", ") : "none"));
   if (ids.length == 0) {
      return null;
   }
   let value = (id) => (ids.indexOf(id) >= 0) ? view.propertyValue(id) : undefined;
   for (let id of ids) {
      Console.writeln("[lookup]   " + id + " = " + view.propertyValue(id));
   }

   // centre: the observation centre if present, else the solution's reference point (the solvers put it at the image centre)
   let ra = value("Observation:Center:RA"), dec = value("Observation:Center:Dec");
   if (ra === undefined || dec === undefined) {
      let c = value("AstrometricSolution:ReferenceCelestialCoordinates");
      if (c === undefined) {
         return null;
      }
      ra = c.at(0);
      dec = c.at(1);
   }

   // scale in degrees per pixel from the linear transformation matrix (a CD matrix)
   let scale = NaN;
   let m = value("AstrometricSolution:LinearTransformationMatrix");
   if (m !== undefined) {
      scale = Math.sqrt(m.at(0, 0) * m.at(0, 0) + m.at(1, 0) * m.at(1, 0));
   }
   if (isNaN(scale) || scale <= 0) {
      Console.writeln("[lookup] no usable linear transformation matrix, cannot determine the field size");
      return null;
   }
   let w = view.image.width, h = view.image.height;
   let radius = 0.5 * scale * Math.sqrt(w * w + h * h);
   Console.writeln("[lookup] solution from properties: centre " + ra + ", " + dec + ", scale " + (scale * 3600).toFixed(3) + " arcsec/px, image " + w + "x" + h);
   return { ra: Number(ra), dec: Number(dec), radius: radius };
}

// centre (RA, Dec in degrees) and radius (degrees) of a plate-solved view, from its WCS keywords or XISF properties; null if not solved
function solvedField(view) {
   let kw = view.window.keywords;
   let num = (names) => parseFloat(headerValue(kw, names));
   let crval1 = num(["CRVAL1"]), crval2 = num(["CRVAL2"]);
   let crpix1 = num(["CRPIX1"]), crpix2 = num(["CRPIX2"]);
   let cd11 = num(["CD1_1"]), cd12 = num(["CD1_2"]), cd21 = num(["CD2_1"]), cd22 = num(["CD2_2"]);
   if (isNaN(cd11) && isNaN(cd22)) {
      // CDELT-only solutions
      cd11 = num(["CDELT1"]);
      cd22 = num(["CDELT2"]);
      cd12 = cd21 = 0;
   }
   let required = { CRVAL1: crval1, CRVAL2: crval2, CRPIX1: crpix1, CRPIX2: crpix2, "CD1_1/CDELT1": cd11, "CD2_2/CDELT2": cd22 };
   let missing = Object.keys(required).filter(k => isNaN(required[k]));
   if (missing.length > 0) {
      Console.writeln("[lookup] " + view.fullId + ": no WCS keywords (missing " + missing.join(", ") + "; " + kw.length + " keywords in header), trying the XISF solution properties");
      return solvedFieldFromProperties(view);
   }
   if (isNaN(cd12)) cd12 = 0;
   if (isNaN(cd21)) cd21 = 0;

   let w = view.image.width, h = view.image.height;
   // image centre in the tangent plane (FITS pixel coordinates are 1-based, centre at (w+1)/2)
   let dx = (w + 1) / 2 - crpix1, dy = (h + 1) / 2 - crpix2;
   let dec = crval2 + cd21 * dx + cd22 * dy;
   let ra = crval1 + (cd11 * dx + cd12 * dy) / Math.cos(dec * Math.PI / 180);
   ra = (ra % 360 + 360) % 360;

   let scaleX = Math.sqrt(cd11 * cd11 + cd21 * cd21);   // degrees per pixel
   let scaleY = Math.sqrt(cd12 * cd12 + cd22 * cd22);
   let radius = 0.5 * Math.sqrt(Math.pow(w * scaleX, 2) + Math.pow(h * scaleY, 2));
   Console.writeln("[lookup] solution: CRVAL=" + crval1.toFixed(4) + "," + crval2.toFixed(4) +
                   " CRPIX=" + crpix1.toFixed(1) + "," + crpix2.toFixed(1) +
                   " scale=" + (scaleX * 3600).toFixed(3) + " arcsec/px, image " + w + "x" + h);
   return { ra: ra, dec: dec, radius: radius };
}

// plain-text body of an HTTP GET, or null on failure
function httpGet(url) {
   let t = new NetworkTransfer;
   t.setURL(url);
   t.setConnectionTimeout(10);
   // PJSR has no total-time setter: abort from the data callback once the deadline passes
   let deadline = Date.now() + 30000;
   t.body = new ByteArray;
   t.onDownloadDataAvailable = function(data) {
      this.body.add(data);
      return Date.now() < deadline;
   };
   Console.writeln("[lookup] GET " + url);
   if (!t.download()) {
      Console.writeln("[lookup] download failed: " + t.errorInformation + " (HTTP " + t.responseCode + ")");
      return null;
   }
   Console.writeln("[lookup] HTTP " + t.responseCode + ", " + t.body.length + " bytes");
   return t.body.toString();
}

// names of the largest SIMBAD objects inside the plate-solved field of a view, biggest first; [] if none or on any failure
function lookupObjectNames(view) {
   try {
      Console.writeln("[lookup] checking " + view.fullId + " for a plate solution");
      let f = solvedField(view);
      if (!f) {
         Console.writeln("[lookup] image not solved, skipping the object lookup");
         return [];
      }
      // objects from 1 arcmin up to 120% of the field diameter (no sky-sized clouds), limited to the well-known catalogues and
      // named objects: in a wide field the biggest SIMBAD objects are otherwise obscure survey entries (PGCC, TGU, ...)
      let diameterArcmin = f.radius * 2 * 60;
      let maxSize = (diameterArcmin * 1.2).toFixed(2);
      let catalogues = ["NGC", "IC", "M", "LDN", "LBN", "Sh", "vdB", "B", "Cr", "Mel", "Abell", "NAME"];
      let adql = "SELECT TOP 25 main_id, galdim_majaxis FROM basic" +
                 " WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', " + f.ra.toFixed(5) + ", " + f.dec.toFixed(5) + ", " + f.radius.toFixed(4) + "))=1" +
                 " AND galdim_majaxis BETWEEN 1 AND " + maxSize +
                 " AND (" + catalogues.map(c => "main_id LIKE '" + c + " %'").join(" OR ") + ")" +
                 " ORDER BY galdim_majaxis DESC";
      Console.writeln("[lookup] field centre RA " + f.ra.toFixed(4) + " Dec " + f.dec.toFixed(4) + ", radius " + f.radius.toFixed(3) + " deg (" + diameterArcmin.toFixed(1) + " arcmin across)");
      Console.writeln("[lookup] ADQL: " + adql);
      let body = httpGet("https://simbad.cds.unistra.fr/simbad/sim-tap/sync?request=doQuery&lang=adql&format=tsv&query=" + encodeURIComponent(adql));
      if (!body) {
         Console.writeln("[lookup] SIMBAD lookup failed (no response)");
         return [];
      }
      Console.writeln("[lookup] response start: " + body.substring(0, 300).replace(/\s+/g, " "));
      let names = [];
      let rows = body.split("\n");
      Console.writeln("[lookup] " + rows.length + " response lines");
      for (let i = 1; i < rows.length; ++i) {   // row 0 is the header
         let cols = rows[i].split("\t");
         let name = (cols[0] || "").replace(/"/g, "").replace(/^(NAME|\*|V\*)\s+/, "").replace(/\s+/g, " ").trim();
         if (name && names.indexOf(name) < 0) {
            names.push(name);
         }
      }
      Console.writeln("[lookup] " + names.length + " object(s) found" + (names.length ? ": " + names.join(" | ") : ""));
      return names;
   } catch (e) {
      Console.writeln("[lookup] error: " + e.message);
      return [];
   }
}

var CopyRightParameters = {
   text: "",
   setup: {},
   copyrightText: "",
   targetView: undefined,
   saveFiles: undefined,

   // process instance (new instance icon / saved project)
   save: function() {
      Parameters.set("text", CopyRightParameters.text);
      for (let f of SETUP_FIELDS) {
         Parameters.set("setup_" + f.key, CopyRightParameters.setup[f.key] || "");
      }
      Parameters.set("copyrightText", CopyRightParameters.copyrightText);
      Parameters.set("saveFiles", CopyRightParameters.saveFiles);
   },
   load: function() {
      if (Parameters.has("text")) {
         CopyRightParameters.text = Parameters.get("text");
      }
      for (let f of SETUP_FIELDS) {
         if (Parameters.has("setup_" + f.key)) {
            CopyRightParameters.setup[f.key] = Parameters.get("setup_" + f.key);
         }
      }
      if (Parameters.has("copyrightText")) {
         CopyRightParameters.copyrightText = Parameters.get("copyrightText");
      }
      if (Parameters.has("saveFiles")) {
         CopyRightParameters.saveFiles = Parameters.get("saveFiles");
      }
   },

   // persistent settings (survive PixInsight restarts); the title is per-image and not stored
   saveSettings: function() {
      for (let f of SETUP_FIELDS) {
         Settings.write(SETTINGS_KEY_PREFIX + "setup_" + f.key, DataType_UCString, CopyRightParameters.setup[f.key] || "");
      }
      Settings.write(SETTINGS_KEY_PREFIX + "copyrightText", DataType_UCString, CopyRightParameters.copyrightText);
      Settings.write(SETTINGS_KEY_PREFIX + "saveFiles", DataType_Boolean, CopyRightParameters.saveFiles);
   },
   loadSettings: function() {
      for (let f of SETUP_FIELDS) {
         let v = Settings.read(SETTINGS_KEY_PREFIX + "setup_" + f.key, DataType_UCString);
         if (Settings.lastReadOK) {
            CopyRightParameters.setup[f.key] = v;
         }
      }
      let s = Settings.read(SETTINGS_KEY_PREFIX + "copyrightText", DataType_UCString);
      if (Settings.lastReadOK) {
         CopyRightParameters.copyrightText = s;
      }
      let b = Settings.read(SETTINGS_KEY_PREFIX + "saveFiles", DataType_Boolean);
      if (Settings.lastReadOK) {
         CopyRightParameters.saveFiles = b;
      }
   }
}

// one line per non-empty field, value only (no label unless the field has a linePrefix)
function buildSetupLines(setup) {
   let lines = [];
   for (let f of SETUP_FIELDS) {
      let v = (setup[f.key] || "").trim();
      if (v) {
         lines.push((f.linePrefix || "") + v);
      }
   }
   return lines;
}

function insertCopyright(view, text, setup, copyrightText) {

   var P = new Annotation;
   var D = new Date;
   var h = view.image.height;
   var w = view.image.width;
   var fontSize = FMath.max(h * 12/720 - 2, 14);
   var margin = h * 20/720;

   P.annotationFont = "Palatino Linotype";
   P.annotationFontSize = fontSize;
   P.annotationFontBold = true;
   P.annotationFontItalic = true;
   P.annotationFontUnderline = false;
   P.annotationFontShadow = true;
   P.annotationColor = 4290822336;
   P.annotationShowLeader = false;
   P.annotationLeaderPositionX = 0;
   P.annotationLeaderPositionY = 0;
   P.annotationOpacity = 255;

   // copyright, bottom left
   if (copyrightText) {
      P.annotationText = copyrightText;
   } else {
      P.annotationText = "© " + D.getFullYear() + " " + DEFAULT_AUTHOR;
   }
   P.annotationPositionX = margin;
   P.annotationPositionY = h * (1 - 40/720);

   Console.writeln("Text: ", P.annotationText);
   Console.writeln("View: ", view.id);

   P.executeOn(view);

   // setup details, bottom right, left-aligned block, one annotation per line
   let lines = buildSetupLines(setup);
   if (lines.length > 0) {
      // smaller than the title/copyright; the Annotation font size is in points, so a line is ~1.33 x size pixels tall
      let setupSize = FMath.max(Math.round(fontSize * 0.75), 12);
      let lineHeight = setupSize * 1.7;
      let font = new Font("Palatino Linotype");
      font.pointSize = setupSize;
      font.bold = true;
      font.italic = false;

      // common left edge: the block is flush left and its widest line ends at the right margin
      let maxWidth = 0;
      for (let l of lines) {
         maxWidth = FMath.max(maxWidth, font.width(l));
      }
      let blockX = FMath.max(margin, w - margin - maxWidth);
      // the smaller font has a higher baseline within its box: lower the block to level it with the copyright
      let baselineShift = (fontSize - setupSize) * 1.25;

      P.annotationFontSize = setupSize;
      P.annotationFontItalic = false;
      for (let i = 0; i < lines.length; ++i) {
         P.annotationText = lines[i];
         P.annotationPositionX = blockX;
         // last line on the copyright baseline, previous ones stacked above it
         P.annotationPositionY = h * (1 - 40/720) + baselineShift - (lines.length - 1 - i) * lineHeight;

         Console.writeln("Text: ", P.annotationText);
         P.executeOn(view);
      }
   }

   // title, top left
   if (text) {

      P.annotationFontSize = fontSize;
      P.annotationText = text;
      P.annotationFontItalic = false;
      P.annotationPositionX = margin;
      P.annotationPositionY = h * 12/720;

      Console.writeln("Text: ", P.annotationText);
      Console.writeln("View: ", view.id);

      P.executeOn(view);
   }
}


class CopyRightDialog extends Dialog {
   constructor () {

      super();

      this.minWidth = 640;

      let curDate = new Date;

      var day = ('0' + curDate.getDate()).slice(-2);
      var month = ('0' + (curDate.getMonth() + 1)).slice(-2);
      var year = curDate.getFullYear();
      var formattedDate = day + '/' + month + '/' + year;

      // script title and description
      this.title = new TextBox(this);
      this.title.text = "<b>Put a title, the setup details and a copyright notice on your image</b><br>Title: top left. Setup details: bottom right, one line per filled field, remembered between runs. Copyright: bottom left, remembered between runs.<br>Select the checkbox to save annotated XISF and PNG files";
      this.title.readOnly = true;
      this.title.minHeight = 80;
      this.title.minWidth = 80;

      // create my view list
      this.viewList = new ViewList(this);
      this.viewList.getMainViews();
      this.viewList.currentView = ImageWindow.activeWindow.currentView;
      CopyRightParameters.targetView = this.viewList.currentView;
      this.viewList.onViewSelected = (view) => {
         CopyRightParameters.targetView = view;
         this.lookupObject();
      }

      // title
      this.titleLabel = new Label(this);
      this.titleLabel.text = "Title:";
      this.editBox = new Edit(this);
      // an object name found by the lookup replaces the title only while the title has not been edited by hand
      this.titleEdited = !!CopyRightParameters.text;
      if (CopyRightParameters.text) {
         this.editBox.text = CopyRightParameters.text;
      } else {
         this.editBox.text = " on " + formattedDate;
      }

      CopyRightParameters.text = this.editBox.text;
      this.editBox.onTextUpdated = (value) => {
         CopyRightParameters.text = value;
         this.titleEdited = true;
      }

      // objects found in the header and in the plate-solved field (SIMBAD); picking one sets the title to the bare name
      this.objectCombo = new ComboBox(this);
      this.objectCombo.enabled = false;
      this.objectNames = [];
      this.setObjectTitle = (name) => {
         this.editBox.text = name;
         CopyRightParameters.text = this.editBox.text;
      }
      this.objectCombo.onItemSelected = (index) => {
         if (index >= 0 && index < this.objectNames.length) {
            this.setObjectTitle(this.objectNames[index]);
            this.titleEdited = false;
         }
      }

      this.lookupButton = new PushButton(this);
      this.lookupButton.text = "Find object";
      this.lookupButton.toolTip = "Looks up objects in the plate-solved field of the selected image on SIMBAD (needs an internet connection). Silently does nothing if the image is not solved.";
      this.lookupButton.onClick = () => {
         this.titleEdited = false;
         this.lookupObject();
      }

      this.lookupObject = () => {
         let view = CopyRightParameters.targetView;
         Console.show();
         if (!view || view.isNull) {
            Console.writeln("[lookup] no target view");
         }
         this.objectNames = [];
         let bestName = "";   // used for the automatic title: the OBJECT keyword, else the largest SIMBAD object
         if (view && !view.isNull) {
            // the OBJECT keyword written by the capture software comes first, then the SIMBAD candidates in alphabetical order
            let obj = headerValue(view.window.keywords, ["OBJECT"]).replace(/\s+/g, " ");
            if (obj) {
               Console.writeln("[lookup] OBJECT keyword in the header: " + obj);
               this.objectNames.push(obj);
               bestName = obj;
            } else {
               Console.writeln("[lookup] no OBJECT keyword in the header");
            }
            let found = lookupObjectNames(view);   // largest first
            if (!bestName && found.length > 0) {
               bestName = found[0];
            }
            found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
            for (let n of found) {
               if (this.objectNames.findIndex(o => o.toLowerCase() == n.toLowerCase()) < 0) {
                  this.objectNames.push(n);
               }
            }
         }
         this.objectCombo.clear();
         for (let n of this.objectNames) {
            this.objectCombo.addItem(n);
         }
         this.objectCombo.enabled = this.objectNames.length > 0;
         if (this.objectNames.length > 0) {
            if (this.titleEdited) {
               Console.writeln("[lookup] title edited by hand, not replaced (best match: " + bestName + ")");
            } else {
               Console.writeln("[lookup] title set to: " + bestName);
               this.setObjectTitle(bestName);
            }
         }
      }

      this.objectSizer = new HorizontalSizer;
      this.objectSizer.spacing = 8;
      this.objectSizer.add(this.objectCombo, 100);
      this.objectSizer.add(this.lookupButton);

      // setup details, one edit per field (empty fields are skipped)
      this.setupSizer = new VerticalSizer;
      this.setupSizer.spacing = 4;
      this.setupEdits = [];
      this.setupEditByKey = {};
      for (let f of SETUP_FIELDS) {
         let label = new Label(this);
         label.text = f.label + ":";
         label.minWidth = 140;
         label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
         let edit = new Edit(this);
         edit.text = CopyRightParameters.setup[f.key] || "";
         edit.onTextUpdated = function(value) {
            CopyRightParameters.setup[f.key] = value;
         }
         let row = new HorizontalSizer;
         row.spacing = 6;
         row.add(label);
         row.add(edit, 100);
         if (f.key == "location") {
            // known sites; the edit box stays free for any other place
            let combo = new ComboBox(this);
            combo.addItem("Custom");
            for (let loc of LOCATIONS) {
               combo.addItem(loc.name);
            }
            let syncCombo = () => {
               let idx = LOCATIONS.findIndex(loc => loc.name == edit.text);
               combo.currentItem = idx + 1;   // 0 = Custom
               edit.enabled = idx < 0;        // the edit box is only for custom text
            }
            combo.onItemSelected = (index) => {
               if (index > 0) {
                  edit.text = LOCATIONS[index - 1].name;
                  CopyRightParameters.setup[f.key] = edit.text;
                  edit.enabled = false;
               } else {
                  edit.text = "";
                  CopyRightParameters.setup[f.key] = "";
                  edit.enabled = true;
               }
            }
            edit.onTextUpdated = function(value) {
               CopyRightParameters.setup[f.key] = value;
            }
            syncCombo();
            this.syncLocationCombo = syncCombo;
            row.add(combo);
         }
         this.setupSizer.add(row);
         this.setupEdits.push(edit);
         this.setupEditByKey[f.key] = edit;
      }

      // fill telescope, camera, filters and location from FITS keywords (target view or another file)
      this.fillFromKeywords = (kw) => {
         let found = {
            telescope: headerValue(kw, ["TELESCOP"]),
            camera: headerValue(kw, ["INSTRUME"]),
            filters: headerValue(kw, ["FILTER"])
         };
         let lat = parseAngle(headerValue(kw, ["SITELAT", "LAT-OBS", "OBSGEO-B"]));
         let lon = parseAngle(headerValue(kw, ["SITELONG", "SITELON", "LONG-OBS", "OBSGEO-L"]));
         if (!isNaN(lat) && !isNaN(lon)) {
            found.location = findLocation(lat, lon);
            if (!found.location) {
               Console.writeln("No known site near " + lat.toFixed(5) + ", " + lon.toFixed(5));
            }
         } else {
            Console.writeln("No site coordinates in the header");
         }
         for (let key in found) {
            if (found[key]) {
               CopyRightParameters.setup[key] = found[key];
               this.setupEditByKey[key].text = found[key];
               if (key == "location") {
                  this.syncLocationCombo();
               }
               Console.writeln(key + " = " + found[key]);
            }
         }
      }

      // any image already open in PixInsight (e.g. a light frame or a master); defaults to the target view
      this.sourceViewList = new ViewList(this);
      this.sourceViewList.getMainViews();
      this.sourceViewList.currentView = CopyRightParameters.targetView;
      this.sourceView = CopyRightParameters.targetView;
      this.sourceViewList.onViewSelected = (view) => {
         this.sourceView = view;
      }

      this.headerButton = new PushButton(this);
      this.headerButton.text = "Fill from view";
      this.headerButton.toolTip = "Reads TELESCOP, INSTRUME, FILTER and SITELAT/SITELONG from the image selected on the left. Only fields found in the header are overwritten.";
      this.headerButton.onClick = () => {
         let view = this.sourceView;
         if (!view || view.isNull) {
            return;
         }
         Console.writeln("Keywords from view: " + view.fullId);
         this.fillFromKeywords(view.window.keywords);
      }

      // the final image usually has no equipment/site keywords: read them from another FITS/XISF file (e.g. a light frame or a master)
      this.fileButton = new PushButton(this);
      this.fileButton.text = "Fill from file...";
      this.fileButton.toolTip = "Reads the same keywords from another FITS or XISF file, such as a light frame or a master. Only fields found are overwritten.";
      this.fileButton.onClick = () => {
         let ofd = new OpenFileDialog;
         ofd.caption = "Select a FITS or XISF file with the equipment and site keywords";
         ofd.loadImageFilters();
         if (!ofd.execute()) {
            return;
         }
         let kw = readFileKeywords(ofd.fileName);
         if (kw) {
            Console.writeln("Keywords from: " + ofd.fileName);
            this.fillFromKeywords(kw);
         }
      }

      this.headerSizer = new HorizontalSizer;
      this.headerSizer.spacing = 8;
      this.headerSizer.add(this.sourceViewList, 100);
      this.headerSizer.add(this.headerButton);
      this.headerSizer.add(this.fileButton);

      // copyright
      this.copyrightLabel = new Label(this);
      this.copyrightLabel.text = "Copyright:";
      this.editBox2 = new Edit(this);
      if (CopyRightParameters.copyrightText) {
         this.editBox2.text = CopyRightParameters.copyrightText;
      } else {
         this.editBox2.text = "© " + curDate.getFullYear() + " " + DEFAULT_AUTHOR;
      }

      CopyRightParameters.copyrightText = this.editBox2.text;
      this.editBox2.onTextUpdated = function(value) {
         CopyRightParameters.copyrightText = value;
      }

      // create my check box
      this.checkBox = new CheckBox(this);
      if (CopyRightParameters.saveFiles !== undefined) {
         this.checkBox.checked = CopyRightParameters.saveFiles;
      } else {
         this.checkBox.checked = true;
         CopyRightParameters.saveFiles = this.checkBox.checked;
      }
      this.checkBox.text = "Save XISF and PNG annotated files";
      this.checkBox.onCheck = function(value) {
         CopyRightParameters.saveFiles = value;
      }

      this.execButton = new PushButton(this);
      this.execButton.text = "Apply";
      this.execButton.width = 40;
      this.execButton.defaultButton = true;
      this.execButton.onClick = () => {
         this.ok();
      }

      this.closeButton = new PushButton(this);
      this.closeButton.text = "Close";
      this.closeButton.width = 40;
      this.closeButton.onClick = () => {
         this.cancel();
      }

      this.newInstanceButton = new ToolButton (this);
      this.newInstanceButton.icon = this.scaledResource("://process-interface/new-instance.png");
      this.newInstanceButton.setScaledFixedSize(24,24);
      this.newInstanceButton.onMousePress = () => {
         CopyRightParameters.save();
         this.newInstance();
      }

      this.bottomSizer = new HorizontalSizer;
      this.bottomSizer.margin = 10;
      this.bottomSizer.add(this.newInstanceButton);
      this.bottomSizer.addStretch();
      this.bottomSizer.add(this.execButton);
      this.bottomSizer.addSpacing(10);
      this.bottomSizer.add(this.closeButton);

      this.sizer = new VerticalSizer;
      this.sizer.margin = 20;
      this.sizer.add(this.title);
      this.sizer.addSpacing(10);
      this.sizer.add(this.viewList);
      this.sizer.addSpacing(10);
      this.sizer.add(this.titleLabel);
      this.sizer.add(this.editBox);
      this.sizer.addSpacing(4);
      this.sizer.add(this.objectSizer);
      this.sizer.addSpacing(10);
      this.sizer.add(this.setupSizer);
      this.sizer.addSpacing(4);
      this.sizer.add(this.headerSizer);
      this.sizer.addSpacing(10);
      this.sizer.add(this.copyrightLabel);
      this.sizer.add(this.editBox2);
      this.sizer.addSpacing(10);
      this.sizer.add(this.checkBox);
      this.sizer.addSpacing(10);
      this.sizer.add(this.bottomSizer);

      // fills the title with the object name if the image is plate-solved
      this.lookupObject();
   }
}

function showDialog() {
   let dialog = new CopyRightDialog;
   return dialog.execute();
}

function main() {

   if (Parameters.isViewTarget) {
      Console.writeln("ViewTarget context");
      Console.writeln("Targeting: ", Parameters.targetView.id);
      CopyRightParameters.load();
      insertCopyright(Parameters.targetView, CopyRightParameters.text, CopyRightParameters.setup, CopyRightParameters.copyrightText);
      return;
   }

   // persistent settings first, then a process instance (if any) overrides them
   CopyRightParameters.loadSettings();
   if (Parameters.isGlobalTarget) {
      CopyRightParameters.load();
   }

   let retVal = showDialog();
   Console.writeln("Returned value: ", retVal);
   if (retVal == 1) {
      Console.writeln("Text: ", CopyRightParameters.text);
      Console.writeln("Setup: ", buildSetupLines(CopyRightParameters.setup).join(" | "));
      Console.writeln("CopyrightText: ", CopyRightParameters.copyrightText);
      Console.writeln("TargetView: ", CopyRightParameters.targetView.id);
      insertCopyright(CopyRightParameters.targetView, CopyRightParameters.text, CopyRightParameters.setup, CopyRightParameters.copyrightText);
      CopyRightParameters.targetView.image.render();

      if (CopyRightParameters.saveFiles) {
         let fp = File.appendToName(CopyRightParameters.targetView.window.filePath, ".annotated");
         Console.writeln("Saving file " + fp);
         CopyRightParameters.targetView.window.saveAs(fp,false, false);
         fp = File.changeExtension(fp, ".png");
         Console.writeln("Saving file " + fp);
         CopyRightParameters.targetView.window.saveAs(fp,false, false);
      }
      CopyRightParameters.save();
      CopyRightParameters.saveSettings();
   }
}

main();
