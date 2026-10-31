# Changelog

## 1.1.0 (unreleased)

### Added
- Layout options: corner of the title, the setup block and the copyright, alignment of the setup lines, font and colour, with a preview on the shape of the target image and a *Reset layout* button. Texts in the same corner are stacked; texts too wide for an edge are shrunk.
- Site editor (*Edit sites...*) and *Save as site* button. The imaging sites are stored in the PixInsight settings instead of the source.
- Equipment and site are also read from the XISF properties `Instrument:*` and `Observation:Location:*` when the FITS keywords are missing.
- *Fill from view / file* asks before replacing a value you typed.
- The object lookup also lists catalogue objects that SIMBAD has no size for, and shows a status line.
- Default title date from `DATE-OBS`. Tooltips on the fields. Version, licence, changelog, unit tests.

### Changed
- Annotated copies are written without rebinding the window to the saved file, and you are asked before overwriting. An image without a file on disk is not saved.
- Settings are saved before the image is annotated; errors are reported in a message box.
- The object lookup starts after the dialog is shown, keeps the interface repainted, is aborted after 20 s, is remembered per image, and logs only a summary unless `VERBOSE_LOOKUP` is set.
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
