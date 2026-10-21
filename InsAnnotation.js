#engine v8
#feature-id Render > InsertAnnotation
#feature-info This script inserts a title, the setup details and the copyright, and optionally saves XISF and PNG annotated files. The setup details and the copyright are remembered between runs and PixInsight launches.

#include <pjsr/DataType.jsh>
#include <pjsr/TextAlign.jsh>

#define SETTINGS_KEY_PREFIX "InsAnnotation/"

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
      P.annotationText = "© " + D.getFullYear() + " Your Name";
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
      this.viewList.onViewSelected = function (view) {
         CopyRightParameters.targetView = view;
      }

      // title
      this.titleLabel = new Label(this);
      this.titleLabel.text = "Title:";
      this.editBox = new Edit(this);
      if (CopyRightParameters.text) {
         this.editBox.text = CopyRightParameters.text;
      } else {
         this.editBox.text = " on " + formattedDate;
      }

      CopyRightParameters.text = this.editBox.text;
      this.editBox.onTextUpdated = function(value) {
         CopyRightParameters.text = value;
      }

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
         this.editBox2.text = "© " + curDate.getFullYear() + " Your Name";
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
