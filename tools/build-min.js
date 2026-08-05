// Regenerates the two minified artefacts the deployed index.html loads.
//
// app.min.js and styles.min.css are what ships; app.js and styles.css are the
// sources. Editing the minified files by hand is how a build drifts from its
// source, so this reproduces them instead. Both tools run on their default
// settings, which is what the deployed v229 bundle was built with: running this
// against that source reproduces both files byte for byte.
//
// Dev-only. Nothing here is uploaded, and neither dependency is loaded by the
// app at runtime.
//
//   npm run build
const fs = require("fs");
const path = require("path");
const { minify } = require("terser");
const CleanCSS = require("clean-css");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const source = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const result = await minify(source);
  if (!result.code) throw new Error("terser produced no output");
  fs.writeFileSync(path.join(ROOT, "app.min.js"), result.code);
  console.log(`app.min.js      ${source.length} -> ${result.code.length} bytes`);

  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const minified = new CleanCSS().minify(css);
  if (minified.errors.length) throw new Error(minified.errors.join("; "));
  minified.warnings.forEach((warning) => console.warn("  clean-css:", warning));
  fs.writeFileSync(path.join(ROOT, "styles.min.css"), minified.styles);
  console.log(`styles.min.css  ${css.length} -> ${minified.styles.length} bytes`);
})();
