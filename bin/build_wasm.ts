import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const OPTIMIZATION_LEVEL = 3;
const WASM_MEMORY_SIZE = 16 * 1024 * 1024;
const STACK_SIZE = 2 * 1024 * 1024;
const GLOBAL_BASE = 4 * 1024 * 1024;

interface BuildConfig {
  platform: string;
  wasmOut: string;
  wasmSrc: string;
  emflags: string;
}

const config: BuildConfig = {
  platform: process.env.WASM_PLATFORM ?? '',
  wasmOut: resolve(__dirname, '../build/wasm'),
  wasmSrc: resolve(__dirname, '../'),
  emflags: [
    '-O3',
    '-fno-rtti',
    '-fno-exceptions',
    '-flto',
    '-ffast-math',
    '-fomit-frame-pointer',
    '-finline-functions',
    '-finline-hint-functions',
    '-fno-stack-protector',
    '-fforce-emit-vtables',
    '--param=max-inline-insns-single=1000',
    '--param=max-inline-insns-auto=1000',
    '--param=early-inlining-insns=1000',
    '--param=max-early-inliner-iterations=10',
    '-Wl,--no-entry',
    '-Wl,-O3',
    '-Wl,--lto-O3',
    '-Wl,-z,stack-size=' + STACK_SIZE,
    '-Wl,--initial-memory=' + WASM_MEMORY_SIZE,
    '-Wl,--max-memory=' + WASM_MEMORY_SIZE,
  ].join(' '),
};

if (!config.platform && process.argv[2]) {
  config.platform = execSync('docker info -f "{{.OSType}}/{{.Architecture}}"').toString().trim();
}

function ensureDirectoryExists(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function runDockerBuild(platform: string, wasmSrc: string): void {
  const uid = process.platform === 'linux' ? process.getuid!() : 1000;
  const gid = process.platform === 'linux' ? process.getegid!() : 1000;

  const dockerCmd = [
    'docker run --rm',
    `--platform=${platform}`,
    `--user ${uid}:${gid}`,
    '--mount',
    `type=bind,source=${wasmSrc}/build,target=/home/node/llhttp/build`,
    'llhttp_wasm_builder npm run wasm',
  ].join(' ');

  execSync(dockerCmd, {
    cwd: wasmSrc,
    stdio: 'inherit',
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });
}

function buildWasm(config: BuildConfig): void {
  const clangCmd = `
    clang \
      --sysroot=/usr/share/wasi-sysroot \
      -target wasm32-unknown-wasi \
      -Ofast \
      -fno-exceptions \
      -fvisibility=hidden \
      -mexec-model=reactor \
      -msimd128 \
      -mbulk-memory \
      -mmultivalue \
      -mnontrapping-fptoint \
      -msign-ext \
      -mreference-types \
      -mtail-call \
      ${config.emflags} \
      -Wl,-error-limit=0 \
      -Wl,-O${OPTIMIZATION_LEVEL} \
      -Wl,--lto-O${OPTIMIZATION_LEVEL} \
      -Wl,--allow-undefined \
      -Wl,--export-dynamic \
      -Wl,--export-table \
      -Wl,--export=malloc \
      -Wl,--export=free \
      -Wl,--no-entry \
      -Wl,--import-memory \
      -Wl,--max-memory=${WASM_MEMORY_SIZE} \
      -Wl,--global-base=${GLOBAL_BASE} \
      -Wl,--stack-first \
      ${join(config.wasmSrc, 'build', 'c')}/*.c \
      ${join(config.wasmSrc, 'src', 'native')}/*.c \
      -I${join(config.wasmSrc, 'build')} \
      -o ${join(config.wasmOut, 'llhttp.wasm')}
  `.trim();

  execSync(clangCmd, { stdio: 'inherit' });
}

function copyAssets(config: BuildConfig): void {
  copyFileSync(join(config.wasmSrc, 'lib', 'llhttp', 'constants.js'), join(config.wasmOut, 'constants.js'));
  copyFileSync(join(config.wasmSrc, 'lib', 'llhttp', 'constants.js.map'), join(config.wasmOut, 'constants.js.map'));
  copyFileSync(join(config.wasmSrc, 'lib', 'llhttp', 'constants.d.ts'), join(config.wasmOut, 'constants.d.ts'));
  copyFileSync(join(config.wasmSrc, 'lib', 'llhttp', 'utils.js'), join(config.wasmOut, 'utils.js'));
  copyFileSync(join(config.wasmSrc, 'lib', 'llhttp', 'utils.js.map'), join(config.wasmOut, 'utils.js.map'));
  copyFileSync(join(config.wasmSrc, 'lib', 'llhttp', 'utils.d.ts'), join(config.wasmOut, 'utils.d.ts'));

  const packageJson = JSON.stringify({ type: 'commonjs' }, null, 2);
  writeFileSync(join(config.wasmOut, 'package.json'), packageJson);
}

const arg = process.argv[2];

switch (arg) {
  case '--prebuild': {
    const cmd = `docker build --platform=${config.platform} -t llhttp_wasm_builder .`;
    console.log(`> ${cmd}\n`);
    execSync(cmd, { stdio: 'inherit' });
    process.exit(0);
    break;
  }

  case '--setup': {
    try {
      ensureDirectoryExists(join(config.wasmSrc, 'build'));
      process.exit(0);
    } catch (error: unknown) {
      if (isErrorWithCode(error) && error.code !== 'EEXIST') {
        throw error;
      }
      process.exit(0);
    }
    break;
  }

  case '--docker': {
    runDockerBuild(config.platform, config.wasmSrc);
    process.exit(0);
    break;
  }

  default: {
    ensureDirectoryExists(config.wasmOut);
    execSync('npm run build', { cwd: config.wasmSrc, stdio: 'inherit' });
    buildWasm(config);
    copyAssets(config);
    break;
  }
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}
