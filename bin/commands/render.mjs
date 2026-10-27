// `launch-video-kit render [hook...] [--format landscape|vertical|square|all]` - wraps
// film/render.sh (build.py -> HyperFrames render -> audio.py mix) so a fresh clone doesn't
// need to know the project's internal folder layout to produce film/renders/<hook>.mp4.
//
// Runs a doctor-lite preflight first: ffmpeg/ffprobe and a python3 that can run build.py/
// audio.py are both required for every render, and failing fast here with one clear message
// beats discovering it 40 seconds into a render, buried in film/renders/build-<hook>.log.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function has(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error;
}

function usage() {
  console.error(`Usage: launch-video-kit render [hook ...] [--format landscape|vertical|square|all]

Builds, renders and mixes a launch film (film/render.sh under the hood).
  (no args)                   every hook under film/hooks/, landscape only
  type-only                   just the type-only hook, landscape
  --format vertical type-only renders/type-only-vertical.mp4 (1080x1920, TikTok/Reels/Shorts)
  --format all type-only       all 3 formats from the same film.json and brand kit`);
}

export async function run(argv, { root }) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    return;
  }

  const ffmpegOk = has('ffmpeg', ['-version']);
  const ffprobeOk = has('ffprobe', ['-version']);
  const venvPy = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const pyOk = existsSync(venvPy) || has('python3', ['--version']);
  if (!ffmpegOk || !ffprobeOk || !pyOk) {
    console.error('launch-video-kit render: missing required tooling, run `launch-video-kit doctor` for exact fixes:');
    if (!ffmpegOk) console.error('  - ffmpeg not found on PATH');
    if (!ffprobeOk) console.error('  - ffprobe not found on PATH (ships with ffmpeg)');
    if (!pyOk) console.error('  - no .venv and no python3 on PATH (needed by build.py and audio.py)');
    process.exitCode = 1;
    return;
  }

  const renderSh = path.join(root, 'film', 'render.sh');
  if (!existsSync(renderSh)) {
    console.error(`launch-video-kit: expected ${renderSh} - is this running inside a clone of the kit?`);
    process.exitCode = 1;
    return;
  }

  console.log(`launch-video-kit render: film/render.sh ${argv.join(' ')}`.trim());
  await new Promise((resolve) => {
    const child = spawn('bash', [renderSh, ...argv], { stdio: 'inherit', cwd: path.join(root, 'film') });
    child.on('error', (err) => {
      console.error(`launch-video-kit: failed to start render.sh - ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
