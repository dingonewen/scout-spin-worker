// build.mjs
//
// Bundles src/ with esbuild and componentizes the result into a Spin HTTP
// trigger WASM via `@spinframework/build-tools` (SpinEsbuildPlugin + jco).
// Mirrors the output of `spin new http-ts` (SDK 4.x) so `spin build` / `spin up`
// work against the same dist layout. Run directly with `node build.mjs`, or
// through `spin build` (see the [component.*.build] step in spin.toml).
import { build } from 'esbuild';
import { SpinEsbuildPlugin } from "@spinframework/build-tools/plugins/esbuild";

const debug = process.argv.includes('--debug');

await build({
    entryPoints: ['./src/index.ts'],
    outfile: './build/bundle.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    sourcemap: true,
    minify: false,
    loader: {
        '.ts': 'ts',
        '.tsx': 'tsx',
    },
    resolveExtensions: ['.ts', '.tsx', '.js'],
    plugins: [await SpinEsbuildPlugin({
        componentize: {
            debug,
            output: './dist/scout-spin-worker.wasm',
            initLocation: 'http://test-deps.localhost',
        }
    })],
});
