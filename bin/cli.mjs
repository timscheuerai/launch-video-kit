#!/usr/bin/env node
// `npx launch-video-kit <command> [...args]` - the installable CLI for this kit.
//
// Subcommands:
//   init <dir> [--url <repo>]     scaffold a fresh project (no "Use this template" + git clone)
//   brand <url> [...flags]        extract a brand kit from a website (tools/brand-from-url.mjs)
//   demo <url> [...flags]         alias of `brand`, kept for the free-path-before-install demo
//   render [hook] [...flags]      build + render + mix a film (film/render.sh)
//   doctor                        check node/ffmpeg/uv/whisper-cpp and print install commands
//
// Every subcommand that touches the local toolchain (render) runs a doctor-style preflight
// first and prints the exact missing-tool fix instead of failing silently mid-render - that
// silent mid-render failure on a missing ffmpeg/uv/whisper-cpp is the #2 friction point this
// CLI exists to remove (the #1 is the install wall `brand`/`demo` already route around).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const COMMANDS = {
  init: () => import('./commands/init.mjs'),
  brand: () => import('./commands/brand.mjs'),
  demo: () => import('./commands/brand.mjs'),
  render: () => import('./commands/render.mjs'),
  doctor: () => import('./commands/doctor.mjs'),
};

function usage() {
  console.error(`launch-video-kit <command> [...args]

Commands:
  init <dir> [--url <repo>]   scaffold a fresh project into <dir> (git clone, history reset)
  brand <url> [...flags]      extract a brand kit from a website (colours, fonts, logo, copy)
  render [hook] [...flags]    build + render + mix a launch film (film/render.sh under the hood)
  doctor                      check node/ffmpeg/python/uv/whisper-cpp, print fixes for anything missing

Run "launch-video-kit <command> --help" for a command's own flags.`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '-h' || cmd === '--help') {
  usage();
  process.exit(cmd ? 0 : 1);
}

const load = COMMANDS[cmd];
if (!load) {
  console.error(`launch-video-kit: unknown command "${cmd}"\n`);
  usage();
  process.exit(1);
}

const mod = await load();
await mod.run(argv.slice(1), { root: ROOT });
