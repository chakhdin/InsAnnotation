# InsAnnotation

Version 1.1.0. A PixInsight script that puts a title, the imaging setup details and a copyright notice on an image, using the Annotation process, and optionally saves annotated copies.

```
NGC 1851                                              (top left)

                                        Takahashi FSQ-85EDX
                                        NEQ6 Pro
                                        ZWO ASI2600MM Pro
                                        LRGB
                                        Total exposure: 7h
© 2026 Your Name                        Example Site, Country      (bottom)
```

By default:

- **Title**: top left, upright bold.
- **Setup details**: bottom right, one line per filled field, upright bold, smaller than the title. The lines share a left edge, the widest line ends at the right margin, and the last line sits on the copyright baseline.
- **Copyright**: bottom left, italic bold.

The corner of each text, the alignment of the setup lines, the font and the colour can be changed (see *Layout and appearance*). Sizes and positions scale with the image height.

## Requirements

- A PixInsight version with the V8 script engine (the script starts with `#engine v8`).
- An internet connection only for the optional object lookup on SIMBAD.

## Installation

1. Clone or download this repository.
2. In PixInsight: **Script > Feature Scripts... > Add**, select the folder containing `InsAnnotation.js`, then **Done**. The script appears under **Script > Render > InsertAnnotation**.
   Or run it once with **Script > Execute Script File...**

`InsAnnotation.js` includes `InsAnnotationCore.jsh` from the same folder, so keep the two files together.

## Usage

1. Select the target image in the first view list.
2. Fill in or check the fields (below).
3. **Apply** annotates the image. With *Save annotated copies* checked, it also writes `<name>.annotated.<ext>` (same format as the original file) and `<name>.annotated.png` (16 bit) next to the original file. The copies are written without changing the file the window is bound to, and you are asked before an existing file is overwritten. An image that was never saved to disk is annotated but not saved.

The image itself is annotated in place (use Undo to take the text off). The new-instance icon stores the current values in a process instance.

### Fields

| Field | Notes |
|---|---|
| Title | Free text. Filled automatically when an object is found (see below), otherwise starts as ` on DD/MM/YYYY`, using `DATE-OBS` of the image when present, else today. |
| Telescope, Mount, Camera | Printed as typed. |
| Filters (if any) | Printed as typed. |
| Exposure per filter | Free text, for example `L 40x300 s, R 20x300 s`. |
| Total exposure | Printed as `Total exposure: <value>`. |
| Location(s) | A dropdown of your saved sites plus **Custom**. The edit box is enabled only for Custom. **Save as site** stores the typed name with the coordinates of the last header read; **Edit sites...** opens the site editor (see below). |
| Copyright | Defaults to `© <current year> <name>`. |

Empty fields are skipped. Every field has a tooltip. Setup details, copyright, layout and appearance, the AutoSTF choice and the save-files option are remembered between runs and between PixInsight launches (PixInsight settings, keys under `InsAnnotation/`). The title is per image and is not remembered.

### Layout and appearance

The **Layout and appearance** group sets the corner of the title, of the setup block and of the copyright, the alignment of the lines inside the setup block (left or right), the font (any installed font name) and the colour. A preview shows the target image with the texts where they will go, and updates as you change the settings (the font is applied when you finish editing the field). **Reset layout** restores the defaults.

The **AutoSTF** checkbox under the preview stretches the preview image automatically, which is needed for a linear image. Unchecked, the screen stretch of the image is used. It affects only the preview, never the image, and the choice is remembered. The preview is made from a copy reduced to 600 pixels (`PREVIEW_BITMAP_PX`).

- Texts that share a corner are stacked from the edge of the image inwards.
- When the texts on the left and right corners of the same edge are too wide to fit side by side, the widest one is made smaller, down to 8 pt. If they still do not fit, a warning is written to the Process Console.

### Filling the setup from FITS keywords

Final XISF images often have no equipment keywords. The buttons under the setup fields read them from another source:

- **Fill from view**: any image open in PixInsight, chosen in the list next to the button.
- **Fill from file...**: any FITS or XISF file, for example a light frame or a master.

Keywords used: `TELESCOP` (telescope), `INSTRUME` (camera), `FILTER` (filters) and the site coordinates `SITELAT`/`SITELONG` (also `LAT-OBS`/`LONG-OBS` and `OBSGEO-B`/`OBSGEO-L`), matched to the nearest saved site within its match radius. When a keyword is missing, the XISF properties `Instrument:Telescope:Name`, `Instrument:Camera:Name`, `Instrument:Filter:Name` and `Observation:Location:Latitude`/`Longitude` (degrees, north and east positive) are used instead; the coordinates are taken as a pair from the same source. Mount and exposure times are never filled automatically.

Only the fields found are overwritten. If a field already holds a different value you typed, you are asked: replace it, keep it and fill only the other fields, or change nothing.

#### Saved sites

Sites are not part of the source: they are stored in the PixInsight settings (key `InsAnnotation/locations`, a JSON list of `name`, `lat`, `lon`, `radiusKm`), so they stay private and survive script updates.

- **Save as site**: **Fill from view/file...** on an image whose header has `SITELAT`/`SITELONG`, choose **Custom**, type the site name, click **Save as site**. A site saved this way gets a 1 km match radius.
- **Edit sites...** opens the site editor: a list of the saved sites with name, latitude and longitude (decimal degrees, N and E positive) and match radius. Select a site to edit it and press **Update**, fill the fields and press **Add** for a new one, or **Remove**. **Use header position** copies the coordinates read by the last *Fill from view / file*. Names must be unique. Changes are stored when the editor is closed with **OK**.

### Object lookup

When the dialog opens and when the target view changes, only the `OBJECT` keyword of the image header is read (no network access). Click **Find object** to query SIMBAD:

1. The `OBJECT` keyword of the image header, if present, is the first candidate.
2. If the image is plate-solved, SIMBAD is queried for named objects inside the field. The solution is read from WCS keywords (`CRVAL`, `CRPIX`, `CD`/`CDELT`), or else from the XISF `AstrometricSolution:*` properties (reference point, reference pixel and linear transformation matrix). Only the sky position and radius are sent. Two queries are made:
   - Objects of 1 arcmin up to 120% of the field diameter from the NGC, IC, Messier, LDN, LBN, Sharpless, vdB, Barnard, Collinder, Melotte and Abell catalogues, plus objects with a common name, biggest first.
   - Objects of the same catalogues for which SIMBAD has no size (the first query cannot return them), most referenced first, at most 10. If SIMBAD refuses the ordering by number of references, the query is repeated without it.
3. The dropdown lists the `OBJECT` value first, then the SIMBAD names alphabetically.

The title is set to the `OBJECT` value, or else to the largest SIMBAD object. A title you have edited by hand is not replaced. An unsolved image, no network or no match leaves the title alone; a line under the title says what happened.

The interface is repainted while SIMBAD answers (input is ignored meanwhile). A server that does not accept the connection within 5 s is abandoned, and each request is aborted after 20 s. The result is remembered per image until the dialog closes; **Find object** asks again.

Two SIMBAD servers are used: the Harvard mirror (`simbad.cfa.harvard.edu`) and the main server in Strasbourg (`simbad.cds.unistra.fr`). If the first one cannot be reached, the other is tried. The server that answered is tried first from then on, also in the next runs (PixInsight setting `InsAnnotation/simbadServer`).

The Process Console shows a one-line summary of each lookup. To log every step, set `VERBOSE_LOOKUP` to `true` at the top of `InsAnnotation.js`.

## Customising

At the top of `InsAnnotation.js`: `DEFAULT_AUTHOR` (first-run copyright name), `LOOKUP_TIMEOUT_S`, `SIMBAD_URLS` (the servers, in the order they are tried), `PREVIEW_BITMAP_PX`, `VERBOSE_LOOKUP`.

In `InsAnnotationCore.jsh`: `SETUP_FIELDS` (the setup fields, in drawing order), `LAYOUT_DEFAULTS`, and the sizing constants of the layout (`REFERENCE_HEIGHT`, `LINE_PITCH`, `SETUP_SIZE_RATIO`, `MIN_FONT_SIZE`, ...).

## Tests

The logic that needs no PixInsight object (angles, sites, plate solution maths, SIMBAD queries, layout) is in `InsAnnotationCore.jsh` and is tested with node, outside PixInsight:

```
node --test tests/core.test.js
```

## Notes and limitations

- Text widths are measured with a pixel-sized font at 96 dpi (`ANNOTATION_PX_PER_POINT` in `InsAnnotationCore.jsh`), not with a point size, so they do not depend on the display scaling. The layout assumes the Annotation process takes the font size in points and the position as the text's top-left corner. If lines look misaligned on your system, adjust `ANNOTATION_PX_PER_POINT` and `BASELINE_SHIFT`.
- The Annotation process draws text wider than the font metrics of the script predict (about 30% on the machine where this was measured, for Palatino Linotype and Arial). To keep the texts inside the image, the script measures the real width of each font once per session: it renders a sample text with the Annotation process on a small hidden image (about 100 ms) and corrects all widths by the ratio. The Process Console shows a `[calibration]` line with the factor. The correction is also applied to the preview text. The text height is assumed to scale with the same factor; this has not been checked.
- The preview uses the same layout code as the annotation, with the installed font drawn at a reduced size; it is a guide, not a pixel-exact rendering.
- Nicknames such as "The Giraffe Nebula" are not in SIMBAD. The lookup returns catalogue names, for example `LDN 1295`.

## Licence

MIT, see `LICENSE`. Changes are listed in `CHANGELOG.md`.
