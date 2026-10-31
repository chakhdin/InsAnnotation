#engine v8
#feature-id Render > InsertAnnotation
#feature-info Version 1.1.0. This script inserts a title, the setup details and the copyright, and optionally saves annotated copies (original format and PNG). The setup details, the copyright, the layout and the imaging sites are remembered between runs and PixInsight launches.

#include <pjsr/DataType.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/controls/SimpleColorDialog.js>

// the logic that needs no PixInsight object (layout, angles, plate solution maths, SIMBAD queries) is in this file
#include "InsAnnotationCore.jsh"

#define SCRIPT_VERSION "1.1.0"
#define SCRIPT_TITLE "InsAnnotation"
#define SETTINGS_KEY_PREFIX "InsAnnotation/"

// name in the default copyright "© <year> <name>"; the copyright you enter is remembered between runs, so this is only the first-run default
#define DEFAULT_AUTHOR "Your Name"

// longest side of the reduced copy of the image used for the dialog preview, in pixels
#define PREVIEW_BITMAP_PX 600

// AutoSTF is applied to the preview only when the median of the image is below this value (0..1); a brighter image is considered already stretched
#define AUTOSTF_MAX_MEDIAN 0.2

// true if a screen transfer function (array of [m, c0, c1, ...] per channel) leaves the image unchanged
function isIdentityStf(stf) {
   if (!stf) {
      return true;
   }
   for (let i = 0; i < stf.length; ++i) {
      if (stf[i][0] != 0.5 || stf[i][1] != 0 || stf[i][2] != 1) {
         return false;
      }
   }
   return true;
}

// total time allowed to one SIMBAD request, in seconds
#define LOOKUP_TIMEOUT_S 20
// SIMBAD TAP servers, tried in this order: the Harvard mirror first, then the main server in Strasbourg
var SIMBAD_URLS = [
   "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=tsv&query=",
   "https://simbad.cds.unistra.fr/simbad/sim-tap/sync?request=doQuery&lang=adql&format=tsv&query="
];

// set to true to log every step of the object lookup to the Process Console (the lookup then also shows the console)
var VERBOSE_LOOKUP = false;

function lookupLog(message) {
   if (VERBOSE_LOOKUP) {
      Console.writeln("[lookup] " + message);
   }
}

// known imaging sites, matched against the SITELAT/SITELONG header keywords (decimal degrees, N and E positive)
// radiusKm: a header position closer than this to the site is reported with its name
// The list is not kept in the source: it lives in the PixInsight settings (JSON, key InsAnnotation/locations),
// is read by loadLocations() and edited with the "Edit sites..." and "Save as site" buttons of the dialog.
var LOCATIONS = [];

function loadLocations() {
   let s = Settings.read(SETTINGS_KEY_PREFIX + "locations", DataType_UCString);
   if (!Settings.lastReadOK) {
      return;
   }
   try {
      LOCATIONS = JSON.parse(s).filter(l => typeof l.name == "string" && isFinite(l.lat) && isFinite(l.lon) && l.radiusKm > 0);
   } catch (e) {
      Console.warningln("Cannot read the saved sites: " + e.message);
   }
}

function saveLocations() {
   Settings.write(SETTINGS_KEY_PREFIX + "locations", DataType_UCString, JSON.stringify(LOCATIONS));
}

function showMessage(text, icon) {
   (new MessageBox(text, SCRIPT_TITLE, icon || StdIcon_Information, StdButton_Ok)).execute();
}

// XISF properties that carry the equipment and the site, used when the FITS keywords are missing
var EQUIPMENT_PROPERTY_IDS = {
   telescope: "Instrument:Telescope:Name",
   camera:    "Instrument:Camera:Name",
   filters:   "Instrument:Filter:Name",
   latitude:  "Observation:Location:Latitude",    // geodetic, degrees, north positive
   longitude: "Observation:Location:Longitude"    // geodetic, degrees, east positive
};

// equipment/site properties of a view, as { telescope, camera, filters, latitude, longitude } (only those present)
function viewEquipmentProperties(view) {
   let found = {};
   let ids = [];
   try {
      ids = view.properties;
   } catch (e) {
      Console.writeln("Cannot list the view properties: " + e.message);
   }
   for (let key in EQUIPMENT_PROPERTY_IDS) {
      let id = EQUIPMENT_PROPERTY_IDS[key];
      if (ids.indexOf(id) >= 0) {
         found[key] = view.propertyValue(id);
      }
   }
   return found;
}

// the same for the current image of an open file
function fileEquipmentProperties(fi) {
   let found = {};
   for (let key in EQUIPMENT_PROPERTY_IDS) {
      try {
         let v = fi.readImageProperty(EQUIPMENT_PROPERTY_IDS[key]);
         if (v !== null && v !== undefined) {
            found[key] = v;
         }
      } catch (e) {
         // the format cannot store properties
      }
   }
   return found;
}

// keywords and equipment properties of a FITS/XISF file, read without loading the pixel data;
// null on failure, otherwise { keywords, properties }
function readFileMetadata(path) {
   let result = null;
   let fi = null;
   try {
      let format = new FileFormat(File.extractExtension(path), true/*toRead*/, false/*toWrite*/);
      fi = new FileFormatInstance(format);
      if (fi.open(path, "verbosity 0").length > 0) {
         result = { keywords: fi.keywords, properties: fileEquipmentProperties(fi) };
      }
   } catch (e) {
      Console.criticalln("Cannot read " + path + ": " + e.message);
   }
   if (fi) {
      fi.close();
   }
   return result;
}

// XISF astrometric solution of a view as plain values for wcsFieldFromProperties(); null if the view has none
function viewAstrometricProperties(view) {
   let ids = [];
   try {
      ids = view.properties.filter(id => /^(AstrometricSolution:(ReferenceCelestialCoordinates|LinearTransformationMatrix|ReferenceImageCoordinates)|Observation:Center)/.test(id));
   } catch (e) {
      lookupLog("cannot list view properties: " + e.message);
   }
   lookupLog("relevant properties: " + (ids.length ? ids.join(", ") : "none"));
   if (ids.length == 0) {
      return null;
   }
   let value = (id) => (ids.indexOf(id) >= 0) ? view.propertyValue(id) : undefined;
   for (let id of ids) {
      lookupLog("  " + id + " = " + view.propertyValue(id));
   }
   let p = { center: null, refCelestial: null, refImage: null, matrix: null };
   // the observation centre if present, else the solution's reference point
   let ra = value("Observation:Center:RA"), dec = value("Observation:Center:Dec");
   if (ra !== undefined && dec !== undefined) {
      p.center = { ra: Number(ra), dec: Number(dec) };
   }
   let c = value("AstrometricSolution:ReferenceCelestialCoordinates");
   if (c !== undefined) {
      p.refCelestial = [c.at(0), c.at(1)];
   }
   let r = value("AstrometricSolution:ReferenceImageCoordinates");
   if (r !== undefined) {
      p.refImage = [r.at(0), r.at(1)];
   }
   let m = value("AstrometricSolution:LinearTransformationMatrix");
   if (m !== undefined) {
      p.matrix = [[m.at(0, 0), m.at(0, 1)], [m.at(1, 0), m.at(1, 1)]];
   }
   return p;
}

// centre (RA, Dec in degrees) and radius (degrees) of a plate-solved view, from its WCS keywords or XISF properties; null if not solved
function solvedField(view) {
   let w = view.image.width, h = view.image.height;
   let fromKeywords = wcsFieldFromKeywords(view.window.keywords, w, h);
   if (fromKeywords.field) {
      let f = fromKeywords.field;
      lookupLog("solution: CRVAL=" + f.crval1.toFixed(4) + "," + f.crval2.toFixed(4) +
                " CRPIX=" + f.crpix1.toFixed(1) + "," + f.crpix2.toFixed(1) +
                " scale=" + (f.scaleX * 3600).toFixed(3) + " arcsec/px, image " + w + "x" + h);
      return f;
   }
   lookupLog(view.fullId + ": no WCS keywords (missing " + fromKeywords.missing.join(", ") + "), trying the XISF solution properties");
   let p = viewAstrometricProperties(view);
   let f = p ? wcsFieldFromProperties(p, w, h) : null;
   if (f) {
      lookupLog("solution from properties: centre " + f.ra.toFixed(4) + ", " + f.dec.toFixed(4) + ", scale " + (f.scaleX * 3600).toFixed(3) + " arcsec/px, image " + w + "x" + h);
   } else if (p) {
      lookupLog("no usable linear transformation matrix, cannot determine the field size");
   }
   return f;
}

// plain-text body of an HTTP GET, or null on failure; the interface stays repainted, and the request is aborted after LOOKUP_TIMEOUT_S
function httpGet(url) {
   let t = new NetworkTransfer;
   t.setURL(url);
   t.setConnectionTimeout(5);
   let deadline = Date.now() + LOOKUP_TIMEOUT_S * 1000;
   t.body = new ByteArray;
   t.onDownloadDataAvailable = function(data) {
      this.body.add(data);
      return Date.now() < deadline;
   };
   // called at regular intervals even when the server sends nothing, so the deadline holds for a stalled connection too
   t.onTransferProgress = function() {
      CoreApplication.processEvents(true/*excludeUserInputEvents*/);
      return Date.now() < deadline;
   };
   lookupLog("GET " + url);
   if (!t.download()) {
      Console.writeln("[lookup] download failed: " + t.errorInformation + " (HTTP " + t.responseCode + ")");
      return null;
   }
   lookupLog("HTTP " + t.responseCode + ", " + t.body.length + " bytes");
   return t.body.toString();
}

// puts the server that answered last time (saved in the settings) first; done once per run
var simbadOrderLoaded = false;
function loadSimbadOrder() {
   if (simbadOrderLoaded) {
      return;
   }
   simbadOrderLoaded = true;
   let saved = Settings.read(SETTINGS_KEY_PREFIX + "simbadServer", DataType_UCString);
   let i = Settings.lastReadOK ? SIMBAD_URLS.indexOf(saved) : -1;
   if (i > 0) {
      SIMBAD_URLS.unshift(SIMBAD_URLS.splice(i, 1)[0]);
   }
}

// object names of one SIMBAD query, or null on any failure
function simbadQuery(adql) {
   lookupLog("ADQL: " + adql);
   loadSimbadOrder();
   for (let url of SIMBAD_URLS) {
      let body = httpGet(url + encodeURIComponent(adql));
      if (body === null) {
         continue;   // server unreachable: try the next one
      }
      lookupLog("response start: " + body.substring(0, 300).replace(/\s+/g, " "));
      let names = parseSimbadNames(body);
      if (names === null) {
         Console.writeln("[lookup] unexpected SIMBAD response (no main_id header), ignored");
         continue;
      }
      // the server that answered goes first from now on, also in the next runs, so that a dead one is not waited for again
      if (url !== SIMBAD_URLS[0]) {
         SIMBAD_URLS.splice(SIMBAD_URLS.indexOf(url), 1);
         SIMBAD_URLS.unshift(url);
         Settings.write(SETTINGS_KEY_PREFIX + "simbadServer", DataType_UCString, url);
         Console.writeln("[lookup] SIMBAD server switched to " + url.split("/")[2]);
      }
      return names;
   }
   return null;
}

// SIMBAD objects inside the plate-solved field of a view: { ok, names, status }; names are the biggest objects first, then the
// catalogue objects without a size (most referenced first); ok is false when the lookup failed and should be retried later
function lookupObjectNames(view) {
   try {
      lookupLog("checking " + view.fullId + " for a plate solution");
      let f = solvedField(view);
      if (!f) {
         return { ok: true, names: [], status: "The image is not plate-solved: no object lookup." };
      }
      lookupLog("field centre RA " + f.ra.toFixed(4) + " Dec " + f.dec.toFixed(4) + ", radius " + f.radius.toFixed(3) + " deg");
      let names = simbadQuery(buildSizedAdql(f));
      if (names === null) {
         return { ok: false, names: [], status: "SIMBAD lookup failed (no network, or no valid answer)." };
      }
      // objects SIMBAD has no size for; if ordering by number of references is refused, ask again without it
      let unsized = simbadQuery(buildUnsizedAdql(f, true));
      if (unsized === null) {
         unsized = simbadQuery(buildUnsizedAdql(f, false));
      }
      for (let n of (unsized || [])) {
         if (names.indexOf(n) < 0) {
            names.push(n);
         }
      }
      Console.writeln("[lookup] " + names.length + " object(s) found" + (names.length ? ": " + names.join(" | ") : ""));
      return { ok: true, names: names, status: names.length + " object(s) found on SIMBAD." };
   } catch (e) {
      Console.writeln("[lookup] error: " + e.message);
      return { ok: false, names: [], status: "Object lookup error: " + e.message };
   }
}

// writes a copy of the view to a file without rebinding the window to it (ImageWindow.saveAs would)
function writeImageCopy(view, path, asPng) {
   let window = view.window;
   let format = new FileFormat(File.extractExtension(path), false/*toRead*/, true/*toWrite*/);
   let fi = new FileFormatInstance(format);
   if (fi.isNull) {
      throw new Error("Cannot instantiate the file format " + format.name);
   }
   try {
      if (!fi.create(path, "non-interactive")) {
         throw new Error("Cannot create " + path);
      }
      let d = new ImageDescription;
      d.bitsPerSample = asPng ? 16 : window.bitsPerSample;
      d.ieeefpSampleFormat = asPng ? false : window.isFloatSample;
      if (!fi.setOptions(d)) {
         throw new Error("Cannot set the output options of " + path);
      }
      if (format.canStoreKeywords) {
         fi.keywords = window.keywords;
      }
      if (format.canStoreImageProperties) {
         window.mainView.exportProperties(fi);
      }
      if (!fi.writeImage(view.image)) {
         throw new Error("Cannot write " + path);
      }
   } finally {
      fi.close();
   }
}

// "<name>.annotated.<ext>" and "<name>.annotated.png" next to the file of the view; asks before overwriting
function saveAnnotatedCopies(view) {
   let filePath = view.window.filePath;
   if (!filePath) {
      showMessage("The image has no file on disk, so the annotated copies were not saved. Save the image first.", StdIcon_Warning);
      return;
   }
   let fp = File.appendToName(filePath, ".annotated");
   for (let target of [{ path: fp, png: false }, { path: File.changeExtension(fp, ".png"), png: true }]) {
      if (File.exists(target.path)) {
         let answer = (new MessageBox("The file already exists:\n" + target.path + "\n\nOverwrite it?", SCRIPT_TITLE,
                                      StdIcon_Question, StdButton_Yes, StdButton_No)).execute();
         if (answer != StdButton_Yes) {
            Console.writeln("Skipped " + target.path);
            continue;
         }
      }
      Console.writeln("Saving file " + target.path);
      writeImageCopy(view, target.path, target.png);
   }
}

// layout options kept in the settings and in process instances: name -> PixInsight data type
var LAYOUT_DATA_TYPES = {
   fontName: DataType_UCString,
   color: DataType_UInt32,
   titleCorner: DataType_UCString,
   setupCorner: DataType_UCString,
   copyrightCorner: DataType_UCString,
   setupAlign: DataType_UCString
};

var Params = {
   text: "",
   setup: {},
   copyrightText: "",
   layout: sanitizeLayout(LAYOUT_DEFAULTS),
   targetView: undefined,
   saveFiles: undefined,
   autoStf: true,   // AutoSTF checkbox of the preview (dialog setting only, not a process instance parameter)

   // process instance (new instance icon / saved project); the parameter ids are kept from the first versions
   save: function() {
      Parameters.set("text", Params.text);
      for (let f of SETUP_FIELDS) {
         Parameters.set("setup_" + f.key, Params.setup[f.key] || "");
      }
      Parameters.set("copyrightText", Params.copyrightText);
      Parameters.set("saveFiles", Params.saveFiles);
      for (let key in LAYOUT_DATA_TYPES) {
         Parameters.set("layout_" + key, Params.layout[key]);
      }
   },
   load: function() {
      if (Parameters.has("text")) {
         Params.text = Parameters.get("text");
      }
      for (let f of SETUP_FIELDS) {
         if (Parameters.has("setup_" + f.key)) {
            Params.setup[f.key] = Parameters.get("setup_" + f.key);
         }
      }
      if (Parameters.has("copyrightText")) {
         Params.copyrightText = Parameters.get("copyrightText");
      }
      if (Parameters.has("saveFiles")) {
         Params.saveFiles = Parameters.get("saveFiles");
      }
      for (let key in LAYOUT_DATA_TYPES) {
         if (Parameters.has("layout_" + key)) {
            Params.layout[key] = Parameters.get("layout_" + key);
         }
      }
      Params.layout = sanitizeLayout(Params.layout);
   },

   // persistent settings (survive PixInsight restarts); the title is per-image and not stored
   saveSettings: function() {
      for (let f of SETUP_FIELDS) {
         Settings.write(SETTINGS_KEY_PREFIX + "setup_" + f.key, DataType_UCString, Params.setup[f.key] || "");
      }
      Settings.write(SETTINGS_KEY_PREFIX + "copyrightText", DataType_UCString, Params.copyrightText);
      Settings.write(SETTINGS_KEY_PREFIX + "saveFiles", DataType_Boolean, Params.saveFiles);
      Settings.write(SETTINGS_KEY_PREFIX + "autoStf", DataType_Boolean, Params.autoStf);
      for (let key in LAYOUT_DATA_TYPES) {
         Settings.write(SETTINGS_KEY_PREFIX + "layout_" + key, LAYOUT_DATA_TYPES[key], Params.layout[key]);
      }
   },
   loadSettings: function() {
      for (let f of SETUP_FIELDS) {
         let v = Settings.read(SETTINGS_KEY_PREFIX + "setup_" + f.key, DataType_UCString);
         if (Settings.lastReadOK) {
            Params.setup[f.key] = v;
         }
      }
      let s = Settings.read(SETTINGS_KEY_PREFIX + "copyrightText", DataType_UCString);
      if (Settings.lastReadOK) {
         Params.copyrightText = s;
      }
      let b = Settings.read(SETTINGS_KEY_PREFIX + "saveFiles", DataType_Boolean);
      if (Settings.lastReadOK) {
         Params.saveFiles = b;
      }
      let a = Settings.read(SETTINGS_KEY_PREFIX + "autoStf", DataType_Boolean);
      if (Settings.lastReadOK) {
         Params.autoStf = a;
      }
      for (let key in LAYOUT_DATA_TYPES) {
         let v = Settings.read(SETTINGS_KEY_PREFIX + "layout_" + key, LAYOUT_DATA_TYPES[key]);
         if (Settings.lastReadOK) {
            Params.layout[key] = v;
         }
      }
      Params.layout = sanitizeLayout(Params.layout);
   }
}

// The Annotation process draws a font size given in points through the PixInsight display settings (UI scaling factor and font
// resolution). A Font created with the same point size follows the same settings, so its measurements are the ones of the rendered text.
function makeFont(fontName, size, bold, italic) {
   let font = new Font(fontName);
   font.pointSize = size;
   font.bold = bold;
   font.italic = italic;
   return font;
}

// Installed scalable fonts usable for the texts: Latin fonts that define every character of the annotations. Symbol fonts
// (e.g. OpenSymbol) are left out: they draw wrong glyphs and have no usable metrics. Falls back to all the fonts if none passes.
function textFontFamilies() {
   let required = [0x00A9, 0x00B0];   // copyright sign, degree sign
   for (let c = 0x20; c <= 0x7E; ++c) {
      required.push(c);
   }
   let families = Font.scalableFamilies(WritingSystem.Latin).filter(function(family) {
      let font = new Font(family);
      return required.every(function(c) { return font.isCharDefined(c); });
   });
   return families.length > 0 ? families : Font.scalableFamilies();
}

// A font without a real italic face (e.g. Mongolian Baiti) is drawn by the Annotation process as a synthesized italic that is clipped
// at about half of its width, so the copyright is printed upright with such fonts.
function hasItalicFace(fontName) {
   return makeFont(fontName, 12, true, true).isExactMatch;
}

// width in image pixels of a text rendered by the Annotation process (the given size in points)
function makeMeasure(fontName) {
   return function(text, size, bold, italic) {
      return makeFont(fontName, size, bold, italic).width(text);
   };
}

// ascent and descent in image pixels of the font drawn by the Annotation process (bold, the given size in points)
function makeMetrics(fontName) {
   return function(size, italic) {
      let font = makeFont(fontName, size, true, italic);
      return { ascent: font.ascent, descent: font.descent };
   };
}

// input of computeLayout() for a view and the current texts
function buildLayoutSpec(view, text, setup, copyrightText, layout) {
   layout = sanitizeLayout(layout);
   return {
      width: view.image.width,
      height: view.image.height,
      title: text,
      copyright: copyrightText || ("© " + (new Date).getFullYear() + " " + DEFAULT_AUTHOR),
      setupLines: buildSetupLines(setup),
      layout: layout,
      hasItalic: hasItalicFace(layout.fontName),
      measure: makeMeasure(layout.fontName),
      metrics: makeMetrics(layout.fontName)
   };
}

// console report of the font, the display scaling and what the layout assumes for every text (to diagnose clipped or misplaced texts)
function logTextMetrics(spec, result) {
   try {
      let probe = makeFont(spec.layout.fontName, 12, true, false);
      Console.writeln("[layout] font \"" + spec.layout.fontName + "\" (exact match: " + String(probe.isExactMatch) +
         "), display pixel ratio " + (new Dialog).displayPixelRatio.toFixed(3) + ", image " + spec.width + " x " + spec.height +
         " px, base size " + result.fontSize.toFixed(1) + " pt");
      for (let item of result.items) {
         let font = makeFont(spec.layout.fontName, item.size, true, item.italic);
         Console.writeln("[layout] \"" + item.text + "\": " + item.size.toFixed(1) + " pt = " + font.pixelSize + " px" +
            (item.italic ? " italic" : "") + ", width " + font.width(item.text) + ", ascent " + font.ascent + ", descent " +
            font.descent + ", x " + Math.round(item.x) + ", y " + Math.round(item.y));
      }
   } catch (e) {
      Console.warningln("[layout] log failed: " + (e && e.message ? e.message : String(e)));
   }
}

function insertAnnotation(view, text, setup, copyrightText, layout) {
   let spec = buildLayoutSpec(view, text, setup, copyrightText, layout);
   let result = computeLayout(spec);
   for (let warning of result.warnings) {
      Console.warningln(warning);
   }

   let P = new Annotation;
   P.annotationFont = spec.layout.fontName;
   P.annotationFontBold = true;
   P.annotationFontUnderline = false;
   P.annotationFontShadow = true;
   P.annotationColor = spec.layout.color;
   P.annotationShowLeader = false;
   P.annotationLeaderPositionX = 0;
   P.annotationLeaderPositionY = 0;
   P.annotationOpacity = 255;

   logTextMetrics(spec, result);
   Console.writeln("View: ", view.id);
   for (let item of result.items) {
      P.annotationText = item.text;
      P.annotationFontSize = item.size;
      P.annotationFontItalic = item.italic;
      P.annotationPositionX = item.x;
      P.annotationPositionY = item.y;
      Console.writeln("Text: ", item.text);
      P.executeOn(view);
   }
}

// editor for the saved imaging sites: works on a copy, the caller keeps it only if the dialog is accepted
class SitesDialog extends Dialog {
   // headerSite: optional {lat, lon} read from an image header, offered by the "Use header position" button
   constructor(sites, headerSite) {
      super();
      this.windowTitle = SCRIPT_TITLE + " - imaging sites";
      this.scaledMinWidth = 640;
      this.sites = sites.map(s => Object.assign({}, s));
      this.selected = -1;

      this.tree = new TreeBox(this);
      this.tree.numberOfColumns = 4;
      this.tree.headerVisible = true;
      this.tree.rootDecoration = false;
      this.tree.scaledMinHeight = 160;
      ["Name", "Latitude", "Longitude", "Radius (km)"].forEach((t, i) => this.tree.setHeaderText(i, t));
      this.tree.setColumnWidth(0, this.logicalPixelsToPhysical(300));

      this.nameEdit = new Edit(this);
      let nameLabel = new Label(this);
      nameLabel.text = "Name:";
      nameLabel.scaledMinWidth = 140;
      nameLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      let nameRow = new HorizontalSizer;
      nameRow.spacing = 6;
      nameRow.add(nameLabel);
      nameRow.add(this.nameEdit, 100);

      let numeric = (label, lo, hi, precision, value) => {
         let ne = new NumericEdit(this);
         ne.label.text = label;
         ne.label.scaledMinWidth = 140;
         ne.setReal(true);
         ne.setRange(lo, hi);
         ne.setPrecision(precision);
         ne.setValue(value);
         return ne;
      };
      this.latEdit = numeric("Latitude (deg, N +):", -90, 90, 7, 0);
      this.lonEdit = numeric("Longitude (deg, E +):", -180, 180, 7, 0);
      this.radiusEdit = numeric("Match radius (km):", 0.1, 100, 1, 1);
      this.latEdit.toolTip = "Decimal degrees, north positive.";
      this.lonEdit.toolTip = "Decimal degrees, east positive.";
      this.radiusEdit.toolTip = "A header position closer than this to the site is reported with its name.";

      this.headerButton = new PushButton(this);
      this.headerButton.text = "Use header position";
      this.headerButton.toolTip = "Copies the position read by the last Fill from view / file.";
      this.headerButton.enabled = !!headerSite;
      this.headerButton.onClick = () => {
         this.latEdit.setValue(headerSite.lat);
         this.lonEdit.setValue(headerSite.lon);
      }

      // the form as a site, or null (with a message) if it is not valid
      this.readForm = () => {
         this.latEdit.evaluate();
         this.lonEdit.evaluate();
         this.radiusEdit.evaluate();
         let name = this.nameEdit.text.trim();
         if (!name) {
            showMessage("The site needs a name.", StdIcon_Warning);
            return null;
         }
         return { name: name, lat: this.latEdit.value, lon: this.lonEdit.value, radiusKm: this.radiusEdit.value };
      }
      // true if another site (not the one at skipIndex) already has this name
      this.nameTaken = (name, skipIndex) => {
         let taken = this.sites.findIndex((s, i) => i != skipIndex && s.name.toLowerCase() == name.toLowerCase()) >= 0;
         if (taken) {
            showMessage("A site called \"" + name + "\" already exists.", StdIcon_Warning);
         }
         return taken;
      }

      this.refresh = (selectIndex) => {
         this.tree.clear();
         this.selected = -1;
         for (let s of this.sites) {
            let node = new TreeBoxNode(this.tree);
            node.setText(0, s.name);
            node.setText(1, s.lat.toFixed(6));
            node.setText(2, s.lon.toFixed(6));
            node.setText(3, String(s.radiusKm));
         }
         if (selectIndex >= 0 && selectIndex < this.sites.length) {
            this.tree.currentNode = this.tree.child(selectIndex);
         }
      }
      this.tree.onCurrentNodeUpdated = (node) => {
         this.selected = node ? this.tree.childIndex(node) : -1;
         if (this.selected >= 0 && this.selected < this.sites.length) {
            let s = this.sites[this.selected];
            this.nameEdit.text = s.name;
            this.latEdit.setValue(s.lat);
            this.lonEdit.setValue(s.lon);
            this.radiusEdit.setValue(s.radiusKm);
         }
      }

      this.addButton = new PushButton(this);
      this.addButton.text = "Add";
      this.addButton.toolTip = "Adds the site described by the fields below.";
      this.addButton.onClick = () => {
         let site = this.readForm();
         if (site && !this.nameTaken(site.name, -1)) {
            this.sites.push(site);
            this.refresh(this.sites.length - 1);
         }
      }

      this.updateButton = new PushButton(this);
      this.updateButton.text = "Update";
      this.updateButton.toolTip = "Replaces the selected site with the fields below.";
      this.updateButton.onClick = () => {
         if (this.selected < 0) {
            showMessage("Select a site in the list first.", StdIcon_Warning);
            return;
         }
         let site = this.readForm();
         if (site && !this.nameTaken(site.name, this.selected)) {
            this.sites[this.selected] = site;
            this.refresh(this.selected);
         }
      }

      this.removeButton = new PushButton(this);
      this.removeButton.text = "Remove";
      this.removeButton.toolTip = "Removes the selected site.";
      this.removeButton.onClick = () => {
         if (this.selected < 0) {
            showMessage("Select a site in the list first.", StdIcon_Warning);
            return;
         }
         let name = this.sites[this.selected].name;
         let answer = (new MessageBox("Remove \"" + name + "\"?", SCRIPT_TITLE, StdIcon_Question, StdButton_Yes, StdButton_No)).execute();
         if (answer == StdButton_Yes) {
            this.sites.splice(this.selected, 1);
            this.refresh(-1);
         }
      }

      this.okButton = new PushButton(this);
      this.okButton.text = "OK";
      this.okButton.defaultButton = true;
      this.okButton.onClick = () => this.ok();
      this.cancelButton = new PushButton(this);
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = () => this.cancel();

      let editButtons = new HorizontalSizer;
      editButtons.spacing = 8;
      editButtons.add(this.headerButton);
      editButtons.addStretch();
      editButtons.add(this.addButton);
      editButtons.add(this.updateButton);
      editButtons.add(this.removeButton);

      let bottom = new HorizontalSizer;
      bottom.spacing = 8;
      bottom.addStretch();
      bottom.add(this.okButton);
      bottom.add(this.cancelButton);

      this.sizer = new VerticalSizer;
      this.sizer.margin = 20;
      this.sizer.spacing = 6;
      this.sizer.add(this.tree, 100);
      this.sizer.add(nameRow);
      this.sizer.add(this.latEdit);
      this.sizer.add(this.lonEdit);
      this.sizer.add(this.radiusEdit);
      this.sizer.add(editButtons);
      this.sizer.addSpacing(10);
      this.sizer.add(bottom);

      this.refresh(-1);
   }
}

class AnnotationDialog extends Dialog {
   constructor () {

      super();

      this.scaledMinWidth = 640;
      this.windowTitle = SCRIPT_TITLE + " " + SCRIPT_VERSION;

      // script title and description
      this.description = new TextBox(this);
      this.description.text = "<b>Put a title, the setup details and a copyright notice on your image</b><br>Title, setup details and copyright go in the corners chosen under Layout and appearance. Setup details: one line per filled field, remembered between runs. Copyright: remembered between runs.<br>Select the checkbox to save annotated copies (original format and PNG)";
      this.description.readOnly = true;
      this.description.scaledMinHeight = 80;
      this.description.scaledMinWidth = 80;

      // create my view list
      this.viewList = new ViewList(this);
      this.viewList.getMainViews();
      this.viewList.currentView = ImageWindow.activeWindow.currentView;
      Params.targetView = this.viewList.currentView;
      this.viewList.onViewSelected = (view) => {
         Params.targetView = view;
         this.updatePreviewSize();
         this.lookupObject(false, true);
      }

      // title
      this.titleLabel = new Label(this);
      this.titleLabel.text = "Title:";
      this.titleEdit = new Edit(this);
      this.titleEdit.toolTip = "Printed as typed. Replaced by the object name found for the image until you edit it by hand.";
      // an object name found by the lookup replaces the title only while the title has not been edited by hand
      this.titleEdited = !!Params.text;
      if (Params.text) {
         this.titleEdit.text = Params.text;
      } else {
         this.titleEdit.text = "";
      }

      Params.text = this.titleEdit.text;
      this.titleEdit.onTextUpdated = (value) => {
         Params.text = value;
         this.titleEdited = true;
         this.refreshPreview();
      }

      // objects found in the header and in the plate-solved field (SIMBAD); picking one sets the title to the bare name
      this.objectCombo = new ComboBox(this);
      this.objectCombo.enabled = false;
      this.objectCombo.toolTip = "Objects found for the image: the OBJECT keyword first, then the SIMBAD names alphabetically.";
      this.objectNames = [];
      this.lookupCache = {};   // lookup results by image, so that going back to an image does not query SIMBAD again
      this.setObjectTitle = (name) => {
         this.titleEdit.text = name;
         Params.text = this.titleEdit.text;
         this.refreshPreview();
      }
      this.objectCombo.onItemSelected = (index) => {
         if (index >= 0 && index < this.objectNames.length) {
            this.setObjectTitle(this.objectNames[index]);
            this.titleEdited = false;
         }
      }

      this.lookupButton = new PushButton(this);
      this.lookupButton.text = "Find object";
      this.lookupButton.toolTip = "Looks up objects in the plate-solved field of the selected image on SIMBAD (needs an internet connection), ignoring the results remembered for this image.";
      this.lookupButton.onClick = () => {
         this.titleEdited = false;
         this.lookupObject(true);
      }

      this.statusLabel = new Label(this);
      this.statusLabel.text = "";
      this.setStatus = (text) => {
         this.statusLabel.text = text;
         CoreApplication.processEvents(true/*excludeUserInputEvents*/);
      }

      // offline: header only (plus any cached SIMBAD result), no network request
      this.lookupObject = (force, offline) => {
         let view = Params.targetView;
         if (VERBOSE_LOOKUP) {
            Console.show();
         }
         this.objectNames = [];
         let bestName = "";   // used for the automatic title: the OBJECT keyword, else the largest SIMBAD object
         let status = "No image selected.";
         if (view && !view.isNull) {
            // the OBJECT keyword written by the capture software comes first, then the SIMBAD candidates in alphabetical order
            let obj = headerValue(view.window.keywords, ["OBJECT"]).replace(/\s+/g, " ");
            if (obj) {
               lookupLog("OBJECT keyword in the header: " + obj);
               this.objectNames.push(obj);
               bestName = obj;
            } else {
               lookupLog("no OBJECT keyword in the header");
            }
            let key = view.fullId + "|" + view.image.width + "x" + view.image.height;
            let result = force ? null : this.lookupCache[key];
            if (!result && offline) {
               result = { ok: false, names: [], status: "Press Lookup to find the objects on SIMBAD." };
            }
            if (!result) {
               this.setStatus("Looking up objects on SIMBAD...");
               result = lookupObjectNames(view);   // largest first
               if (result.ok) {
                  this.lookupCache[key] = result;
               }
            }
            status = result.status;
            let found = result.names.slice();
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
               lookupLog("title edited by hand, not replaced (best match: " + bestName + ")");
            } else {
               lookupLog("title set to: " + bestName);
               this.setObjectTitle(bestName);
            }
         }
         this.setStatus(status);
         this.refreshPreview();
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
         label.scaledMinWidth = 140;
         label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
         let edit = new Edit(this);
         edit.text = Params.setup[f.key] || "";
         label.toolTip = f.tip;
         edit.toolTip = f.tip;
         edit.onTextUpdated = (value) => {
            Params.setup[f.key] = value;
            this.refreshPreview();
         }
         let row = new HorizontalSizer;
         row.spacing = 6;
         row.add(label);
         row.add(edit, 100);
         if (f.key == "location") {
            // known sites; the edit box stays free for any other place
            let combo = new ComboBox(this);
            this.locationCombo = combo;
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
                  Params.setup[f.key] = edit.text;
                  edit.enabled = false;
               } else {
                  edit.text = "";
                  Params.setup[f.key] = "";
                  edit.enabled = true;
               }
               this.refreshPreview();
            }
            syncCombo();
            this.syncLocationCombo = syncCombo;
            row.add(combo);

            // remembers the typed name with the coordinates last read from a header, so the next run recognises the site
            let saveSiteButton = new PushButton(this);
            saveSiteButton.text = "Save as site";
            saveSiteButton.toolTip = "Stores the name typed here with the SITELAT/SITELONG read by the last Fill from view / file, so the site is recognised automatically next time.";
            saveSiteButton.onClick = () => {
               let name = edit.text.trim();
               if (!name || !this.lastSite) {
                  showMessage("Type the site name, after filling the setup from a view or file whose header has the site coordinates.", StdIcon_Warning);
                  return;
               }
               let site = { name: name, lat: this.lastSite.lat, lon: this.lastSite.lon, radiusKm: 1 };
               let idx = LOCATIONS.findIndex(loc => loc.name == name);
               if (idx >= 0) {
                  LOCATIONS[idx] = site;
               } else {
                  LOCATIONS.push(site);
                  combo.addItem(name);
               }
               saveLocations();
               syncCombo();
               Console.writeln("Site saved: " + name + " (" + site.lat.toFixed(5) + ", " + site.lon.toFixed(5) + ")");
            }
            row.add(saveSiteButton);

            // add, edit or remove saved sites
            let editSitesButton = new PushButton(this);
            editSitesButton.text = "Edit sites...";
            editSitesButton.toolTip = "Add, change or remove the saved imaging sites.";
            editSitesButton.onClick = () => {
               let sitesDialog = new SitesDialog(LOCATIONS, this.lastSite);
               if (!sitesDialog.execute()) {
                  return;
               }
               LOCATIONS = sitesDialog.sites;
               saveLocations();
               combo.clear();
               combo.addItem("Custom");
               for (let loc of LOCATIONS) {
                  combo.addItem(loc.name);
               }
               syncCombo();
            }
            row.add(editSitesButton);
         }
         this.setupSizer.add(row);
         this.setupEdits.push(edit);
         this.setupEditByKey[f.key] = edit;
      }

      // fill telescope, camera, filters and location from FITS keywords, falling back to the XISF properties
      // (target view or another file); props: { telescope, camera, filters, latitude, longitude }, may be empty
      this.fillFromKeywords = (kw, props) => {
         props = props || {};
         let text = (v) => (v === undefined || v === null) ? "" : String(v).trim();
         let found = {
            telescope: headerValue(kw, ["TELESCOP"]) || text(props.telescope),
            camera: headerValue(kw, ["INSTRUME"]) || text(props.camera),
            filters: headerValue(kw, ["FILTER"]) || text(props.filters)
         };
         // latitude and longitude come as a pair from the same source
         let lat = parseAngle(headerValue(kw, ["SITELAT", "LAT-OBS", "OBSGEO-B"]));
         let lon = parseAngle(headerValue(kw, ["SITELONG", "SITELON", "LONG-OBS", "OBSGEO-L"]));
         if (isNaN(lat) || isNaN(lon)) {
            lat = parseAngle(text(props.latitude));
            lon = parseAngle(text(props.longitude));
         }
         if (!isNaN(lat) && !isNaN(lon)) {
            this.lastSite = { lat: lat, lon: lon };
            found.location = findLocation(LOCATIONS, lat, lon);
            if (!found.location) {
               Console.writeln("No known site near " + lat.toFixed(5) + ", " + lon.toFixed(5));
            }
         } else {
            Console.writeln("No site coordinates in the header or in the properties");
         }

         // fields the user already filled in with something else are replaced only after asking
         let keys = Object.keys(found).filter(key => found[key]);
         let conflicts = keys.filter(key => (Params.setup[key] || "").trim() && (Params.setup[key] || "").trim() != found[key]);
         if (conflicts.length > 0) {
            let labelOf = (key) => SETUP_FIELDS.find(f => f.key == key).label;
            let answer = (new MessageBox(
               "These fields already have a different value:\n\n" +
               conflicts.map(key => labelOf(key) + ": " + Params.setup[key].trim() + "  ->  " + found[key]).join("\n") +
               "\n\nYes: replace them.\nNo: keep them and fill only the other fields.\nCancel: change nothing.",
               SCRIPT_TITLE, StdIcon_Question, StdButton_Yes, StdButton_No, StdButton_Cancel)).execute();
            if (answer == StdButton_Cancel) {
               return;
            }
            if (answer == StdButton_No) {
               keys = keys.filter(key => conflicts.indexOf(key) < 0);
            }
         }
         for (let key of keys) {
            Params.setup[key] = found[key];
            this.setupEditByKey[key].text = found[key];
            if (key == "location") {
               this.syncLocationCombo();
            }
            Console.writeln(key + " = " + found[key]);
         }
         this.refreshPreview();
      }

      // any image already open in PixInsight (e.g. a light frame or a master); defaults to the target view
      this.sourceViewList = new ViewList(this);
      this.sourceViewList.getMainViews();
      this.sourceViewList.currentView = Params.targetView;
      this.sourceView = Params.targetView;
      this.sourceViewList.onViewSelected = (view) => {
         this.sourceView = view;
      }

      this.headerButton = new PushButton(this);
      this.headerButton.text = "Fill from view";
      this.headerButton.toolTip = "Reads TELESCOP, INSTRUME, FILTER and SITELAT/SITELONG (or the XISF equipment and location properties) from the image selected on the left. Only fields found are overwritten; you are asked before a value you typed is replaced.";
      this.headerButton.onClick = () => {
         let view = this.sourceView;
         if (!view || view.isNull) {
            return;
         }
         Console.writeln("Keywords from view: " + view.fullId);
         this.fillFromKeywords(view.window.keywords, viewEquipmentProperties(view));
      }

      // the final image usually has no equipment/site keywords: read them from another FITS/XISF file (e.g. a light frame or a master)
      this.fileButton = new PushButton(this);
      this.fileButton.text = "Fill from file...";
      this.fileButton.toolTip = "Reads the same keywords from another FITS or XISF file, such as a light frame or a master. Only fields found are overwritten; you are asked before a value you typed is replaced.";
      this.fileButton.onClick = () => {
         let ofd = new OpenFileDialog;
         ofd.caption = "Select a FITS or XISF file with the equipment and site keywords";
         ofd.loadImageFilters();
         if (!ofd.execute()) {
            return;
         }
         let md = readFileMetadata(ofd.fileName);
         if (md) {
            Console.writeln("Keywords from: " + ofd.fileName);
            this.fillFromKeywords(md.keywords, md.properties);
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
      this.copyrightEdit = new Edit(this);
      this.copyrightEdit.toolTip = "Printed as typed. Remembered between runs.";
      if (Params.copyrightText) {
         this.copyrightEdit.text = Params.copyrightText;
      } else {
         this.copyrightEdit.text = "© " + curDate.getFullYear() + " " + DEFAULT_AUTHOR;
      }

      Params.copyrightText = this.copyrightEdit.text;
      this.copyrightEdit.onTextUpdated = (value) => {
         Params.copyrightText = value;
         this.refreshPreview();
      }

      // layout and appearance
      let makeCombo = (list, tip, onSelect) => {
         let combo = new ComboBox(this);
         for (let e of list) {
            combo.addItem(e.label);
         }
         combo.toolTip = tip;
         combo.onItemSelected = (index) => {
            onSelect(list[index].id);
            this.refreshPreview();
         }
         return combo;
      };
      let labelled = (text, control, tip) => {
         let label = new Label(this);
         label.text = text;
         label.scaledMinWidth = 140;
         label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
         label.toolTip = tip;
         let row = new HorizontalSizer;
         row.spacing = 6;
         row.add(label);
         row.add(control, 100);
         return row;
      };
      this.titleCornerCombo = makeCombo(CORNERS, "Corner of the image where the title is printed.", id => { Params.layout.titleCorner = id; });
      this.setupCornerCombo = makeCombo(CORNERS, "Corner of the image where the setup block is printed.", id => { Params.layout.setupCorner = id; });
      this.copyrightCornerCombo = makeCombo(CORNERS, "Corner of the image where the copyright is printed.", id => { Params.layout.copyrightCorner = id; });
      this.setupAlignCombo = makeCombo(SETUP_ALIGNMENTS, "Alignment of the lines inside the setup block. Texts that share a corner are stacked.", id => { Params.layout.setupAlign = id; });

      this.fontCombo = new ComboBox(this);
      this.fontCombo.toolTip = "Installed font used for all the texts.";
      for (let family of textFontFamilies().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
         this.fontCombo.addItem(family);
      }
      this.fontCombo.onItemSelected = (index) => {
         Params.layout.fontName = this.fontCombo.itemText(index);
         this.refreshPreview();
      }

      this.colorButton = new PushButton(this);
      this.colorButton.toolTip = "Colour of all the texts.";
      this.colorButton.onClick = () => {
         let colorDialog = new SimpleColorDialog(Params.layout.color);
         colorDialog.windowTitle = "Text colour";
         colorDialog.alphaEnabled = false;
         // Reset button on the left of the OK / Cancel row of the colour dialog
         let resetButton = new PushButton(colorDialog);
         resetButton.text = "Reset";
         resetButton.toolTip = "Puts the colour back to the default (192, 192, 192).";
         resetButton.onClick = () => {
            colorDialog.color = LAYOUT_DEFAULTS.color;
            colorDialog.V0.setValue(Color.red(colorDialog.color));
            colorDialog.V1.setValue(Color.green(colorDialog.color));
            colorDialog.V2.setValue(Color.blue(colorDialog.color));
            colorDialog.sample_Control.update();
         }
         colorDialog.buttons_Sizer.insert(0, resetButton);
         if (colorDialog.execute()) {
            Params.layout.color = colorDialog.color >>> 0;
            this.layoutToControls();
            this.refreshPreview();
         }
      }

      this.resetLayoutButton = new PushButton(this);
      this.resetLayoutButton.text = "Reset layout";
      this.resetLayoutButton.toolTip = "Puts the corners, the alignment, the font and the colour back to their defaults. The texts are not touched.";
      this.resetLayoutButton.onClick = () => {
         Params.layout = sanitizeLayout(LAYOUT_DEFAULTS);
         this.layoutToControls();
         this.refreshPreview();
      }

      // shows the current layout settings in the controls
      this.layoutToControls = () => {
         let index = (list, id) => Math.max(0, list.findIndex(e => e.id == id));
         this.titleCornerCombo.currentItem = index(CORNERS, Params.layout.titleCorner);
         this.setupCornerCombo.currentItem = index(CORNERS, Params.layout.setupCorner);
         this.copyrightCornerCombo.currentItem = index(CORNERS, Params.layout.copyrightCorner);
         this.setupAlignCombo.currentItem = index(SETUP_ALIGNMENTS, Params.layout.setupAlign);
         // a saved font that is no longer installed is kept in the list, so that the setting is not changed silently
         let fontIndex = this.fontCombo.findItem(Params.layout.fontName, 0, true);
         if (fontIndex < 0) {
            this.fontCombo.insertItem(0, Params.layout.fontName);
            fontIndex = 0;
         }
         this.fontCombo.currentItem = fontIndex;
         this.colorButton.text = "#" + (Params.layout.color & 0xFFFFFF).toString(16).toUpperCase().padStart(6, "0");
      }

      // preview of the layout on the shape of the target image
      this.preview = new Frame(this);
      this.preview.frameStyle = FrameStyle_Sunken;
      this.preview.backgroundColor = 0xFF101010;
      this.preview.toolTip = "Where the texts will be printed on the target image.";
      this.updatePreviewSize = () => {
         let view = Params.targetView;
         let ratio = (view && !view.isNull) ? view.image.height / view.image.width : 0.67;
         let width = 300, height = 300 * ratio;
         if (height > 240) {
            height = 240;
            width = 240 / ratio;
         }
         this.preview.setScaledFixedSize(Math.max(80, Math.round(width)), Math.max(60, Math.round(height)));
      }
      this.refreshPreview = () => {
         this.preview.repaint();
      }

      this.autoStfCheckBox = new CheckBox(this);
      this.autoStfCheckBox.text = "AutoSTF";
      this.autoStfCheckBox.checked = Params.autoStf;
      this.autoStfCheckBox.toolTip = "Stretches the preview image automatically when its median is below " + AUTOSTF_MAX_MEDIAN + " (an already stretched image is left as it is). Unchecked: the screen stretch of the image is used. " +
         "Only the preview is affected, never the image.";
      this.autoStfCheckBox.onCheck = (value) => {
         Params.autoStf = value;
         Settings.write(SETTINGS_KEY_PREFIX + "autoStf", DataType_Boolean, value);   // written at once, so closing the dialog keeps it
         this.refreshPreview();
      }

      // bitmap of the image for the preview, made from a reduced copy and kept by image and stretch mode; null on any failure
      this.previewBitmaps = {};
      this.getPreviewBitmap = (view, autoStf) => {
         let key = view.fullId + "|" + view.image.width + "x" + view.image.height + "|" + (autoStf ? "auto" : "screen");
         if (key in this.previewBitmaps) {
            return this.previewBitmaps[key];
         }
         let bitmap = null;
         try {
            let img = new Image;
            img.assign(view.image);
            let scale = Math.min(1, PREVIEW_BITMAP_PX / Math.max(img.width, img.height));
            if (scale < 1) {
               img.resample(scale);
            }
            let useAutoStf = false;
            if (autoStf) {
               // mean of the channel medians, measured before any stretch
               let sum = 0;
               for (let c = 0; c < img.numberOfChannels; ++c) {
                  img.selectedChannel = c;
                  sum += img.median();
               }
               img.resetSelections();
               let median = sum / img.numberOfChannels;
               useAutoStf = median < AUTOSTF_MAX_MEDIAN;
               Console.writeln("[preview] median " + median.toFixed(4) + (useAutoStf ? ": AutoSTF applied" : ": already stretched, AutoSTF skipped"));
            }
            let stf = useAutoStf ? img.computeAutoStretch() : view.stf;
            if (!isIdentityStf(stf)) {
               img.applyDisplayFunction(stf);
            }
            bitmap = img.render();
         } catch (e) {
            Console.warningln("Cannot render the preview image: " + e.message);
         }
         this.previewBitmaps[key] = bitmap;
         return bitmap;
      }
      this.preview.onPaint = () => {
         let g = new Graphics(this.preview);
         try {
            let rect = this.preview.clientRect;
            g.fillRect(0, 0, rect.width, rect.height, new Brush(0xFF101010));
            let view = Params.targetView;
            if (!view || view.isNull) {
               return;
            }
            let iw = view.image.width, ih = view.image.height;
            let s = Math.min(rect.width / iw, rect.height / ih);
            g.fillRect(0, 0, iw * s, ih * s, new Brush(0xFF303030));
            let bitmap = this.getPreviewBitmap(view, this.autoStfCheckBox.checked);
            if (bitmap) {
               g.drawScaledBitmap(new Rect(0, 0, Math.round(iw * s), Math.round(ih * s)), bitmap);
            }
            let layout = computeLayout(buildLayoutSpec(view, Params.text, Params.setup, Params.copyrightText, Params.layout));
            g.textAntialiasing = true;
            g.pen = new Pen(Params.layout.color);
            for (let item of layout.items) {
               // the pixel size of the text on the image, reduced to the preview scale
               let font = makeFont(Params.layout.fontName, item.size, true, item.italic);
               font.pixelSize = Math.max(1, Math.round(font.pixelSize * s));
               g.font = font;
               g.drawText(item.x * s, item.y * s + font.ascent, item.text);
            }
         } finally {
            g.end();
         }
      }

      let layoutControls = new VerticalSizer;
      layoutControls.spacing = 4;
      layoutControls.add(labelled("Title corner:", this.titleCornerCombo, "Corner of the image where the title is printed."));
      layoutControls.add(labelled("Setup corner:", this.setupCornerCombo, "Corner of the image where the setup block is printed."));
      layoutControls.add(labelled("Setup alignment:", this.setupAlignCombo, "Alignment of the lines inside the setup block."));
      layoutControls.add(labelled("Copyright corner:", this.copyrightCornerCombo, "Corner of the image where the copyright is printed."));
      layoutControls.add(labelled("Font:", this.fontCombo, "Installed font used for all the texts."));
      layoutControls.add(labelled("Colour:", this.colorButton, "Colour of all the texts."));
      let resetRow = new HorizontalSizer;
      resetRow.addStretch();
      resetRow.add(this.resetLayoutButton);
      layoutControls.add(resetRow);

      this.layoutGroup = new GroupBox(this);
      this.layoutGroup.title = "Layout and appearance";
      this.layoutGroup.sizer = new HorizontalSizer;
      this.layoutGroup.sizer.margin = 8;
      this.layoutGroup.sizer.spacing = 12;
      this.layoutGroup.sizer.add(layoutControls, 100);
      let previewSizer = new VerticalSizer;
      previewSizer.spacing = 4;
      previewSizer.add(this.preview);
      previewSizer.add(this.autoStfCheckBox);
      this.layoutGroup.sizer.add(previewSizer);

      // create my check box
      this.checkBox = new CheckBox(this);
      if (Params.saveFiles !== undefined) {
         this.checkBox.checked = Params.saveFiles;
      } else {
         this.checkBox.checked = true;
         Params.saveFiles = this.checkBox.checked;
      }
      this.checkBox.text = "Save annotated copies (original format and PNG)";
      this.checkBox.toolTip = "Writes <name>.annotated.<ext> and <name>.annotated.png next to the file of the image.";
      this.checkBox.onCheck = function(value) {
         Params.saveFiles = value;
      }

      this.execButton = new PushButton(this);
      this.execButton.text = "Apply";
      this.execButton.setScaledFixedWidth(60);
      this.execButton.defaultButton = true;
      this.execButton.onClick = () => {
         this.ok();
      }

      this.closeButton = new PushButton(this);
      this.closeButton.text = "Close";
      this.closeButton.setScaledFixedWidth(60);
      this.closeButton.onClick = () => {
         this.cancel();
      }

      this.newInstanceButton = new ToolButton (this);
      this.newInstanceButton.icon = this.scaledResource("://process-interface/new-instance.png");
      this.newInstanceButton.setScaledFixedSize(24,24);
      this.newInstanceButton.onMousePress = () => {
         Params.save();
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
      this.sizer.add(this.description);
      this.sizer.addSpacing(10);
      this.sizer.add(this.viewList);
      this.sizer.addSpacing(10);
      this.sizer.add(this.titleLabel);
      this.sizer.add(this.titleEdit);
      this.sizer.addSpacing(4);
      this.sizer.add(this.objectSizer);
      this.sizer.add(this.statusLabel);
      this.sizer.addSpacing(10);
      this.sizer.add(this.setupSizer);
      this.sizer.addSpacing(4);
      this.sizer.add(this.headerSizer);
      this.sizer.addSpacing(10);
      this.sizer.add(this.copyrightLabel);
      this.sizer.add(this.copyrightEdit);
      this.sizer.addSpacing(10);
      this.sizer.add(this.layoutGroup);
      this.sizer.addSpacing(10);
      this.sizer.add(this.checkBox);
      this.sizer.addSpacing(10);
      this.sizer.add(this.bottomSizer);

      this.layoutToControls();
      this.updatePreviewSize();

      // fills the title from the OBJECT keyword only; SIMBAD is queried when the Lookup button is pressed
      this.lookupObject(false, true);
   }
}

function showDialog() {
   let dialog = new AnnotationDialog;
   return dialog.execute();
}

function main() {

   if (Parameters.isViewTarget) {
      Console.writeln("ViewTarget context");
      Console.writeln("Targeting: ", Parameters.targetView.id);
      // saved settings first (copyright, setup, layout), then the process instance parameters override them
      Params.loadSettings();
      Params.load();
      insertAnnotation(Parameters.targetView, Params.text, Params.setup, Params.copyrightText, Params.layout);
      return;
   }

   // persistent settings first, then a process instance (if any) overrides them
   if (ImageWindow.activeWindow.isNull) {
      showMessage("Open an image first.", StdIcon_Warning);
      return;
   }
   loadLocations();
   Params.loadSettings();
   if (Parameters.isGlobalTarget) {
      Params.load();
   }

   let retVal = showDialog();
   Console.writeln("Returned value: ", retVal);
   if (retVal == 1) {
      let view = Params.targetView;
      if (!view || view.isNull) {
         showMessage("No target image selected.", StdIcon_Warning);
         return;
      }
      // remember what was typed before anything can fail
      Params.save();
      Params.saveSettings();

      try {
         Console.writeln("Text: ", Params.text);
         Console.writeln("Setup: ", buildSetupLines(Params.setup).join(" | "));
         Console.writeln("CopyrightText: ", Params.copyrightText);
         Console.writeln("TargetView: ", view.id);
         insertAnnotation(view, Params.text, Params.setup, Params.copyrightText, Params.layout);

         if (Params.saveFiles) {
            saveAnnotatedCopies(view);
         }
      } catch (e) {
         Console.criticalln("InsAnnotation failed: " + e.message);
         showMessage("InsAnnotation failed:\n" + e.message, StdIcon_Error);
      }
   }
}

main();
