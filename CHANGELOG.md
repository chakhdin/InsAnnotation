# Changelog

## 1.1.0 (unreleased)

### Added
- The title is remembered per image (file of the image, else the view name) every time it changes, also when the dialog is closed with *Close* or the annotation fails; it is restored when the image is selected (last 200 images).
- A shareable copy, `<name>.annotated.resample.png` written with *Save annotated copies* when the full-size PNG is larger than a size limit (default 15 MiB, editable and remembered; e.g. for WhatsApp, which accepts 16 MB). A copy of the image is reduced, with the annotation already on it, until the file fits; the original image is never changed. It is not written when the full-size PNG already fits, and it is deleted with a warning if the limit cannot be met at 25% of each side.
- The preview shows the target image, with an *AutoSTF* checkbox (remembered) to stretch it automatically, only when the median of the image is below 0.2.
- The font is chosen from a drop-down list of the installed Latin text fonts, without symbol fonts such as OpenSymbol, whose glyphs and metrics break the layout (it was a free text field).
- The copyright is printed upright when the font has no real italic face: the Annotation process clips a synthesized italic at about half of its width (seen with Mongolian Baiti).
- A `[layout]` report in the Process Console before each annotation (font, exact match, display pixel ratio, size, width, ascent, descent and position of every text).
- A *Reset* button in the colour dialog restores the default text colour.
- The title now starts empty (it was ` on DD/MM/YYYY`).
- The texts are measured (width, ascent, descent) with a font created from the same point size as the Annotation process, which follows the PixInsight UI scaling and font resolution settings, so the texts no longer run off the image edge at any setting. The line distance and the common baseline at the bottom come from the real font height. The preview uses the same measurements.
- A second SIMBAD server (Harvard mirror) is tried when the first cannot be reached; the server that answered is remembered between runs.
- Layout options: corner of the title, the setup block and the copyright, alignment of the setup lines, font and colour, with a preview on the shape of the target image and a *Reset layout* button. Texts in the same corner are stacked; texts too wide for an edge are shrunk.
- Site editor (*Edit sites...*) and *Save as site* button. The imaging sites are stored in the PixInsight settings instead of the source.
- Equipment and site are also read from the XISF properties `Instrument:*` and `Observation:Location:*` when the FITS keywords are missing.
- *Fill from view / file* asks before replacing a value you typed.
- The object lookup also lists catalogue objects that SIMBAD has no size for, and shows a status line.
- Default title date from `DATE-OBS`. Tooltips on the fields. Version, licence, changelog, unit tests.

### Changed
- The PNG copy is saved with 8 bits per sample instead of 16 (about 4 times smaller and faster to write; no visible difference on screen or on the web). The copy in the original format keeps the full precision.
- Annotated copies are written without rebinding the window to the saved file, and you are asked before overwriting. An image without a file on disk is not saved.
- Settings are saved before the image is annotated; errors are reported in a message box.
- The SIMBAD lookup no longer runs when the dialog opens or the view changes (the title uses the `OBJECT` keyword); it runs when *Find object* is clicked. It keeps the interface repainted, gives up on a server after 5 s without a connection, is aborted after 20 s, is remembered per image, and logs only a summary unless `VERBOSE_LOOKUP` is set.
- Text widths are measured independently of the display scaling.
- A plate solution given as XISF properties uses its reference pixel and both axis scales.
- The dialog sizes are scaled for high-DPI displays.
- The logic that needs no PixInsight object moved to `InsAnnotationCore.jsh`.

### Fixed
- Dropping the script on a view ignored the saved settings.
- No image open, or no target selected, raised an error.
- Angles such as `12d34m56s` and exponents were not parsed.
- An error page returned by SIMBAD with HTTP 200 was read as object names.
- A useless render of the whole image after annotating.

## 1.0.0

- Title, setup details and copyright on an image with the Annotation process; XISF and PNG copies; fill from FITS keywords; object name lookup on SIMBAD; settings remembered between runs.
