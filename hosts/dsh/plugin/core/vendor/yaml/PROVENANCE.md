# Vendored: yaml

- **Package**: [`yaml`](https://www.npmjs.com/package/yaml)
- **Version**: 2.9.1
- **Upstream**: https://github.com/eemeli/yaml
- **License**: ISC (see [LICENSE](LICENSE) — copied verbatim from the npm tarball)
- **Vendored content**: `dist/**/*.js` (CommonJS build only), `package.json`, `LICENSE`.
  Type declarations (`.d.ts`), the ESM build (`.mjs`), `browser/`, and `README.md` are
  intentionally **not** copied — the engine only parses/stringifies YAML through the CJS
  entry point, and the vendored `package.json` (`"type": "commonjs"`) makes Node resolve
  `dist/*.js` as CommonJS.

## Why vendored

The schflow engine is distributed inside the host plugins (`hosts/*`) so a plugin install
is immediately runnable: `node <pkg>/core/programs/<verb>.mjs` must work with no
`npm install`. `yaml` is the engine's only runtime dependency, hence the in-tree copy.
`core/lib/yamlfile.mjs` imports it by relative path (`../vendor/yaml/dist/index.js`).

## How to regenerate (yaml upgrade)

The root `package.json` intentionally declares no dependencies, so fetch the exact
version explicitly (`--no-save`: node_modules only, manifest untouched) from the
repository root:

```bash
npm install --no-save --no-audit --no-fund yaml@2.9.1
rm -rf core/vendor/yaml
mkdir -p core/vendor/yaml
cp -a node_modules/yaml/dist core/vendor/yaml/dist
find core/vendor/yaml/dist -type f ! -name '*.js' -delete
find core/vendor/yaml/dist -type d -empty -delete
cp node_modules/yaml/package.json node_modules/yaml/LICENSE core/vendor/yaml/
```

Then run `bash scripts/sync-plugins.sh` to refresh the host plugin mirrors and
`npm test` (the zero-dep and plugin-sync guards verify the result).
