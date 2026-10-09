# Tooling kept with the code

Everything needed to rebuild the two shareable artifacts lives here, so any future session (or
colleague) can carry on without the original working files.

## The demo (single HTML file, runs the whole CRM in the browser)

Published at https://claude.ai/artifact/FAjibmLQWB38bvWBegGiEd. To rebuild:

```bash
mkdir -p /tmp/demo-site/ocr
node tools/demo/build-demo.mjs . tools/demo/sqljs /tmp/demo-site/index.html
```

`tools/demo/sqljs` holds the two sql.js files the build needs (`sql-wasm.js`, `sql-wasm.wasm`, from the
`sql.js` npm package, version 1.13). The scanner's OCR files (`tesseract.min.js`, `worker.min.js`, the two
`tesseract-core-*.wasm.js` builds and `eng-model.wasm`) are fetched by `npm run setup:ocr` into
`public/vendor`; copy them to `/tmp/demo-site/ocr` next to the page. Publish `index.html` as the page and the
`ocr/*` files alongside it (the Artifact tool's `files` map). The demo bar's sample accounts all use the password
`password123`; bump `DB_KEY` in the build script whenever the seed changes so browsers reload the sample data.

The build mirrors every API route by hand in `build-demo.mjs` (search for `pathname ===`); a new server route
needs a matching line there, and every module function that goes into the bundle must have a globally unique
name (the modules are concatenated into one script).

## The CEO briefing deck

Published at https://claude.ai/artifact/SK3vPw9nffnJU7rAfX8xKN (an Artifact of the Slides type). The slides
are `tools/deck/project/slides/*.html`, in the order given by `tools/deck/project/deck.json`. Each slide's
footer reads `Sourcing CRM · N`; renumber after inserting a slide. Screenshots are uploaded to the deck as
assets and referenced as `/_blob/<id>`; `tools/deck/blobmap.json` maps each id to the screenshot file used
for the PDF. To regenerate `docs/Sourcing-CRM-CEO-Briefing.pdf`:

```bash
# from a scratch folder that contains tools/deck as "ceo" and the screenshots listed in blobmap.json
node tools/deck/deck-pdf.cjs docs/Sourcing-CRM-CEO-Briefing.pdf ceo blobmap.json
```

(The script takes the deck folder name relative to the folder it is run from, and needs Playwright with
the pre-installed Chromium.) The screenshots themselves are not kept in the repo (about 13 MB); they can be
taken again from the demo at 1500×820, or the ids can be read back from the deck's asset store.

The second deck, the product overview, is at https://claude.ai/artifact/Xb7XiJHSYA25TGiAwjJMCk.
