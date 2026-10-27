// `launch-video-kit init <dir>` - scaffold a fresh project without the GitHub "Use this
// template" button + a manual git clone. Every non-Claude-Code-native visitor who finds this
// kit via npm (not GitHub) has no reason to know it is even a template repo; this gives them
// the same starting point in one command.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_REPO = 'https://github.com/timscheuerai/launch-video-kit.git';

function usage() {
  console.error(`Usage: launch-video-kit init <dir> [--url <repo-url>]

Clones the kit into <dir> (shallow, history reset) so you have a working copy without
visiting GitHub first. --url overrides the source repo, e.g. your own fork.`);
}

function has(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error;
}

export async function run(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exitCode = argv.length === 0 ? 1 : 0;
    return;
  }

  const dir = argv[0];
  const urlIdx = argv.indexOf('--url');
  const url = urlIdx >= 0 && argv[urlIdx + 1] ? argv[urlIdx + 1] : DEFAULT_REPO;
  const dest = path.resolve(process.cwd(), dir);

  if (existsSync(dest) && readdirSync(dest).length > 0) {
    console.error(`launch-video-kit init: ${dest} already exists and is not empty`);
    process.exitCode = 1;
    return;
  }

  if (!has('git', ['--version'])) {
    console.error('launch-video-kit init: git is not on PATH. Download a zip instead:');
    console.error(`  ${url.replace(/\.git$/, '')}/archive/refs/heads/main.zip`);
    console.error('then unzip it into the directory you want and run `npm install` inside it.');
    process.exitCode = 1;
    return;
  }

  console.log(`init: cloning ${url} -> ${dest}`);
  mkdirSync(dest, { recursive: true });
  const clone = spawnSync('git', ['clone', '--depth', '1', url, dest], { stdio: 'inherit' });
  if (clone.status !== 0) {
    console.error('launch-video-kit init: git clone failed (see above)');
    process.exitCode = clone.status ?? 1;
    return;
  }

  // Detach from the source repo's history - this is a new project, not a fork mid-review.
  rmSync(path.join(dest, '.git'), { recursive: true, force: true });
  const reinit = spawnSync('git', ['init', '-q'], { cwd: dest, stdio: 'inherit' });
  if (reinit.status !== 0) {
    console.log('(skipped `git init` in the new project - initialise it yourself when ready)');
  }

  console.log(`
init: done -> ${dest}

Next:
  cd ${dir}
  npm install
  npx launch-video-kit doctor              # check ffmpeg/python/uv before you render anything
  npx launch-video-kit brand <your-url>    # pull colours/fonts/logo/copy from your own site
  npx launch-video-kit render type-only    # film/renders/type-only.mp4`);
}
