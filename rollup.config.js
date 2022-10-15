import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { base64 } from 'rollup-plugin-base64'
import typescript from '@rollup/plugin-typescript'
import svelte from 'rollup-plugin-svelte'
import autoPreprocess from 'svelte-preprocess'
import copy from 'rollup-plugin-copy'
import { terser } from 'rollup-plugin-terser'
import webWorkerLoader from 'rollup-plugin-web-worker-loader'

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ROLLUP
if you want to view the source visit the plugins github repository
*/
`

const production = !process.env.ROLLUP_WATCH

export default {
  input: './src/main.ts',
  output: {
    file: './dist/main.js',
    sourcemap: !production && 'inline',
    format: 'cjs',
    exports: 'default',
    banner,
  },
  external: ['obsidian'],
  plugins: [
    nodeResolve({ browser: true }),
    svelte({
      preprocess: autoPreprocess(),
    }),
    typescript(),
    commonjs(),
    base64({ include: '**/*.wasm' }),
    copy({
      targets: [
        { src: 'manifest.json', dest: 'dist' },
        { src: 'assets/styles.css', dest: 'dist' },
        { src: 'assets/.gitignore', dest: 'dist' },
      ],
    }),
    webWorkerLoader({ inline: true, forceInline: true, targetPlatform: "browser" }),
    production && terser(),
  ],
}