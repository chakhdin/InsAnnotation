# InsAnnotation

A PixInsight script that puts a title, the imaging setup details and a copyright notice on an image, using the Annotation process, and optionally saves annotated XISF and PNG copies.

```
NGC 1851                                              (top left)

                                        Takahashi FSQ-85EDX
                                        NEQ6 Pro
                                        ZWO ASI2600MM Pro
                                        LRGB
                                        Total exposure: 7h
© 2026 Your Name                        San Giuliano (MI), Italy   (bottom)
```

- **Title**: top left, upright bold.
- **Setup details**: bottom right, one line per filled field, upright bold, smaller than the title. The lines share a left edge, the widest line ends at the right margin, and the last line sits on the copyright baseline.
- **Copyright**: bottom left, italic bold.

Sizes and positions scale with the image height.

## Requirements

- A PixInsight version with the V8 script engine (the script starts with `#engine v8`).
- An internet connection only for the optional object lookup on SIMBAD.

## Installation

1. Clone or download this repository.
2. In PixInsight: **Script > Feature Scripts... > Add**, select the folder containing `InsAnnotation.js`, then **Done**. The script appears under **Script > Render > InsertAnnotation**.
   Or run it once with **Script > Execute Script File...**

## Usage

1. Select the target image in the first view list.
2. Fill in or check the fields (below).
3. **Apply** annotates the image. With *Save XISF and PNG annotated files* checked, it also saves `<name>.annotated.xisf` and `<name>.annotated.png` next to the original file.

The new-instance icon stores the current values in a process instance.

### Fields

| Field | Notes |
|---|---|
| Title | Free text. Filled automatically when an object is found (see below), otherwise starts as ` on DD/MM/YYYY`. |
| Telescope, Mount, Camera | Printed as typed. |
| Filters (if any) | Printed as typed. |
| Exposure per filter | Free text, for example `L 40x300 s, R 20x300 s`. |
| Total exposure | Printed as `Total exposure: <value>`. |
| Location(s) | A dropdown of known sites plus **Custom**. The edit box is enabled only for Custom. |
| Copyright | Defaults to `© <current year> <name>`. |

Empty fields are skipped. Setup details, copyright and the save-files option are remembered between runs and between PixInsight launches (PixInsight settings, keys under `InsAnnotation/`). The title is per image and is not remembered.

### Filling the setup from FITS keywords

Final XISF images often have no equipment keywords. The buttons under the setup fields read them from another source:

- **Fill from view**: any image open in PixInsight, chosen in the list next to the button.
- **Fill from file...**: any FITS or XISF file, for example a light frame or a master.

Keywords used: `TELESCOP` (telescope), `INSTRUME` (camera), `FILTER` (filters) and the site coordinates `SITELAT`/`SITELONG` (also `LAT-OBS`/`LONG-OBS` and `OBSGEO-B`/`OBSGEO-L`), matched to the nearest site in the `LOCATIONS` table. Only the fields found are overwritten. Mount and exposure times are never filled automatically.

### Object lookup

When the dialog opens, when the target view changes and when you click **Find object**:

1. The `OBJECT` keyword of the image header, if present, is the first candidate.
2. If the image is plate-solved, SIMBAD is queried for named objects inside the field. The solution is read from the XISF `AstrometricSolution:*` properties, or from WCS keywords (`CRVAL`, `CRPIX`, `CD`/`CDELT`). Only the sky position and radius are sent. Candidates are limited to objects of 1 arcmin up to 120% of the field diameter from the NGC, IC, Messier, LDN, LBN, Sharpless, vdB, Barnard, Collinder, Melotte and Abell catalogues, plus objects with a common name.
3. The dropdown lists the `OBJECT` value first, then the SIMBAD names alphabetically.

The title is set to the `OBJECT` value, or else to the largest SIMBAD object. A title you have edited by hand is not replaced. An unsolved image, no network or no match simply leaves the title alone.

Each step is logged to the Process Console with the prefix `[lookup]`.

## Customising

All at the top of `InsAnnotation.js`:

- `LOCATIONS`: known sites (name, latitude, longitude in decimal degrees, match radius in km). They feed both the dropdown and the coordinate matching.
- `SETUP_FIELDS`: the setup fields, in drawing order.

The default copyright name, the font (`Palatino Linotype`) and the sizes are in `insertCopyright` and in the dialog constructor.

## Notes and limitations

- Text placement assumes the Annotation process takes the font size in points and the position as the text's top-left corner. If lines look misaligned on your system, adjust the width and baseline calculations in `insertCopyright`.
- Nicknames such as "The Giraffe Nebula" are not in SIMBAD. The lookup returns catalogue names, for example `LDN 1295`.
- The lookup is blocking: the dialog waits for SIMBAD (up to about 30 s) before it appears.
