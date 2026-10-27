// `launch-video-kit brand <url>` (alias: `demo`) - the fast path before the full toolchain
// install. Runs only tools/brand-from-url.mjs (pure Node + Puppeteer, already a dependency of
// this package): no ffmpeg, no uv/whisper-cpp, no torch, no Python venv. This moves the first
// value moment (seeing your own colours/fonts/logo/copy pulled out of your own site) before
// the ~10-minute local toolchain install, per STRATEGY-2026-10-23.md move 1.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: launch-video-kit brand <url> [--out brand] [--no-fonts] [--max-images 8] [--open]');
  console.error('');
  console.error("Extracts a brand kit from <url> (colours, fonts, logo, copy, screenshots) and");
  console.error("writes a one-sheet preview. Needs only Node + this package's own Puppeteer");
  console.error('dependency - no ffmpeg, whisper-cpp, uv or torch required for this step.');
  console.error('--open launches the preview in the default browser once it is written.');
}

export async function run(argv, { root }) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exitCode = argv.length === 0 ? 1 : 0;
    return;
  }
  if (argv[0].startsWith('-')) {
    usage();
    process.exitCode = 1;
    return;
  }

  const openIdx = argv.indexOf('--open');
  const shouldOpen = openIdx >= 0;
  const toolArgs = shouldOpen ? [...argv.slice(0, openIdx), ...argv.slice(openIdx + 1)] : argv;

  const outIdx = toolArgs.indexOf('--out');
  const outDir = outIdx >= 0 && toolArgs[outIdx + 1] ? toolArgs[outIdx + 1] : 'brand';

  const brandTool = path.join(root, 'tools', 'brand-from-url.mjs');
  if (!existsSync(brandTool)) {
    console.error(`launch-video-kit: expected ${brandTool} - is this running inside a clone of the kit?`);
    process.exitCode = 1;
    return;
  }

  const t0 = Date.now();
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [brandTool, ...toolArgs], { stdio: 'inherit', cwd: root });
    child.on('error', (err) => {
      console.error(`launch-video-kit: failed to start brand extraction - ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
    child.on('exit', (code, signal) => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (signal) {
        console.error(`launch-video-kit: brand extraction killed by signal ${signal}`);
        process.exitCode = 1;
        return resolve();
      }
      if (code === 0) {
        const previewAbs = path.join(root, outDir, 'preview.html');
        const previewRel = path.relative(process.cwd(), previewAbs);
        console.log(`\nbrand: extracted in ${secs}s -> ${previewRel}`);
        if (existsSync(previewAbs)) {
          if (shouldOpen) {
            const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            const opener = spawn(openCmd, [previewAbs], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
            opener.on('error', () => console.log(`Could not auto-open - run manually: ${openCmd} "${previewRel}"`));
            opener.unref();
          } else {
            console.log('Open the preview:');
            console.log(`  open "${previewRel}"       # macOS`);
            console.log(`  xdg-open "${previewRel}"   # Linux`);
          }
          console.log('\nNext: launch-video-kit render <hook>   (or `launch-video-kit doctor` first if unsure)');
        }
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
