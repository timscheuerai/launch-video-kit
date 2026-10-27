// `launch-video-kit doctor` - checks every tool `render` needs and prints the exact per-OS
// install command for anything missing, instead of letting a render die halfway through with
// a buried "ffmpeg: command not found" three logs deep in film/renders/*.log.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

function has(cmd, args = ['--version']) {
  // A tool "has" PATH if the spawn itself succeeded (no ENOENT) - the exit code doesn't
  // matter here (e.g. `whisper-cli --help` can exit non-zero and still prove it exists).
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error;
}

function installHint(tool) {
  const HINTS = {
    ffmpeg: {
      darwin: 'brew install ffmpeg',
      linux: 'sudo apt-get install -y ffmpeg   # Debian/Ubuntu; use your distro\'s package manager otherwise',
      win32: 'winget install Gyan.FFmpeg   # or choco install ffmpeg',
    },
    python3: {
      darwin: 'brew install python3',
      linux: 'sudo apt-get install -y python3 python3-venv',
      win32: 'winget install Python.Python.3.12',
    },
    uv: {
      darwin: 'brew install uv   # or: curl -LsSf https://astral.sh/uv/install.sh | sh',
      linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
    },
    git: {
      darwin: 'brew install git   # or: xcode-select --install',
      linux: 'sudo apt-get install -y git',
      win32: 'winget install Git.Git',
    },
    'whisper-cli': {
      darwin: 'brew install whisper-cpp   # optional: only needed for the whisper word-time aligner',
      linux: 'build from source: https://github.com/ggml-org/whisper.cpp#quick-start   # optional aligner',
      win32: 'build from source: https://github.com/ggml-org/whisper.cpp#quick-start   # optional aligner',
    },
  };
  return (HINTS[tool] && (HINTS[tool][PLATFORM] || HINTS[tool].linux)) || `install ${tool} and make sure it is on PATH`;
}

function check(name, ok, { required = true, note = '' } = {}) {
  const mark = ok ? '[ok]' : required ? '[missing]' : '[missing, optional]';
  const line = `  ${mark.padEnd(20)} ${name}${note ? '  ' + note : ''}`;
  console.log(line);
  return ok || !required;
}

export async function run(argv, { root }) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('Usage: launch-video-kit doctor\n\nChecks every tool the free render path (and the optional');
    console.log('forced-alignment / whisper paths) need, and prints the install command for anything missing.');
    return;
  }

  console.log(`launch-video-kit doctor (${PLATFORM})\n`);
  let allRequiredOk = true;

  // Node: already running this CLI, so just report the version and the floor.
  const nodeOk = parseInt(process.versions.node.split('.')[0], 10) >= 18;
  allRequiredOk = check(`node >= 18 (found ${process.versions.node})`, nodeOk) && allRequiredOk;

  const ffmpegOk = has('ffmpeg', ['-version']);
  allRequiredOk = check('ffmpeg', ffmpegOk, { note: ffmpegOk ? '' : `-> ${installHint('ffmpeg')}` }) && allRequiredOk;
  const ffprobeOk = has('ffprobe', ['-version']);
  allRequiredOk = check('ffprobe (ships with ffmpeg)', ffprobeOk, { note: ffprobeOk ? '' : `-> ${installHint('ffmpeg')}` }) && allRequiredOk;

  const venvPy = path.join(root, '.venv', PLATFORM === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const venvOk = existsSync(venvPy);
  const python3Ok = has('python3', ['--version']);
  check('python3', python3Ok, { note: python3Ok ? '' : `-> ${installHint('python3')}` });
  check(`.venv (${path.relative(root, venvPy)})`, venvOk, {
    required: false,
    note: venvOk ? '' : '-> run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
  });
  if (!venvOk && !python3Ok) allRequiredOk = false;

  const gitOk = has('git', ['--version']);
  check('git (needed by `init`)', gitOk, { required: false, note: gitOk ? '' : `-> ${installHint('git')}` });

  const uvOk = has('uv', ['--version']);
  check('uv (force-align aligner, no local torch install needed)', uvOk, {
    required: false,
    note: uvOk ? '' : `-> ${installHint('uv')}   (or: pip install torch torchaudio inside .venv)`,
  });

  const whisperOk = has('whisper-cli', ['--help']) || has('whisper-cpp', ['--help']);
  check('whisper-cli (optional word-time aligner, fallback to force/estimate)', whisperOk, {
    required: false,
    note: whisperOk ? '' : `-> ${installHint('whisper-cli')}`,
  });

  console.log('');
  if (allRequiredOk) {
    console.log('All required tools are present. `launch-video-kit render <hook>` is ready to run.');
  } else {
    console.log('Missing required tools above will make `render` fail partway through (build.py and audio.py');
    console.log('both need python3+venv; the HyperFrames render and final mux both need ffmpeg). Install them,');
    console.log('then re-run `launch-video-kit doctor`.');
    process.exitCode = 1;
  }
}
