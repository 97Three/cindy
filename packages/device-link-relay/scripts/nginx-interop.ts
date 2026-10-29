/** 手动集成验证：pnpm --filter @cindy/device-link-relay run interop:nginx。
 * Docker 内运行真实 Nginx、CLI、中转、TLS/WS/媒体；不连接用户服务器，不读取本机凭证。
 * 容器与构建目录仅属于本次验证，结束时精确清理。证书只在容器的临时文件系统生成。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createRelaySigningKey, issueRelayDeviceCert } from '@cindy/device-link';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { createDeviceCredential, initializeRelay, startRelayServer } from '../src/index';
import { startChallengeServer } from '../src/certificates';

function command(file: string, args: string[]) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

async function retry<T>(check: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (accepted(value)) return value;
    } catch {
      /* Nginx graceful reload */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Nginx interop condition timed out');
}

async function inside() {
  const dataDir = '/var/lib/cindy-relay';
  const main = '/etc/nginx/nginx.conf';
  const site = '/etc/nginx/conf.d/website.conf';
  fs.mkdirSync('/tmp/website', { recursive: true });
  fs.mkdirSync('/tmp/acme/.well-known/acme-challenge', { recursive: true });
  fs.writeFileSync('/tmp/acme/.well-known/acme-challenge/other-client', 'other-client-proof');
  function certificate(name: string, san: string) {
    const dir = `/tmp/${name}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/openssl.cnf`, '[req]\ndistinguished_name = dn\n[dn]\n');
    command('openssl', [
      'req',
      '-config',
      `${dir}/openssl.cnf`,
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      `${dir}/key.pem`,
      '-out',
      `${dir}/cert.pem`,
      '-subj',
      '/CN=Cindy interop',
      '-addext',
      `subjectAltName=${san}`,
    ]);
    return {
      key: fs.readFileSync(`${dir}/key.pem`, 'utf8'),
      cert: fs.readFileSync(`${dir}/cert.pem`, 'utf8'),
    };
  }
  const websiteMaterial = certificate('website-tls', 'DNS:website.example.test');
  const initialMain =
    'user nobody nogroup; worker_processes 1; pid /tmp/nginx.pid; events { worker_connections 128; } http { access_log off; include /etc/nginx/conf.d/website.conf; }\n';
  const initialSite = `server { listen 80 default_server; server_name website.example.test;
    location / { return 200 "website-home"; }
    location ^~ /.well-known/acme-challenge/ { root /tmp/acme; try_files $uri =404; }
  }
  server { listen 443 ssl default_server; server_name _;
    ssl_certificate /tmp/website-tls/cert.pem; ssl_certificate_key /tmp/website-tls/key.pem;
    location / { return 200 "website-home"; }
  }\n`;
  fs.writeFileSync(main, initialMain);
  fs.writeFileSync(site, initialSite);
  const nginx = spawn('nginx', ['-c', main, '-g', 'daemon off;'], {
    stdio: 'ignore',
  });
  await retry(
    () => fetch('http://127.0.0.1').then((r) => r.text()),
    (value) => value === 'website-home',
  );
  const cli = (action: string, flags: string[] = []): Record<string, any> =>
    JSON.parse(command(process.execPath, ['/tmp/relay.mjs', 'nginx', '--action', action, ...flags]).trim());
  const prepare = (existing = false) => cli('prepare', ['--address', '127.0.0.1', ...(existing ? ['--existing-certificate'] : [])]);
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(nodeRelayAuthCrypto);
  const relayId = randomUUID();
  await initializeRelay({
    dataDir,
    name: 'Nginx interop',
    ownerUserId: 'interop-owner',
    ownerDeviceId: 'owner-pc',
    ownerDeviceName: 'PC',
    ownerCredentialHash: owner.credentialHash,
    relayId,
    ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(nodeRelayAuthCrypto, ownerKey.seed, {
      relayId,
      deviceId: 'owner-pc',
      publicKey: ownerKey.publicKey,
      role: 'owner',
      issuedAt: Date.now(),
    }),
  });
  let material = certificate('relay-one', 'IP:127.0.0.1');
  const saveMaterial = () => {
    fs.mkdirSync(`${dataDir}/tls`, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${dataDir}/tls/material.json`, JSON.stringify(material), {
      mode: 0o600,
    });
  };
  const get = (pathname: string, method = 'GET', body?: Buffer, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const req = https.request(`https://127.0.0.1${pathname}`, { method, ca: material.cert, agent: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  let relay: Awaited<ReturnType<typeof startRelayServer>> | undefined;
  let challenge: Awaited<ReturnType<typeof startChallengeServer>> | undefined;
  try {
    fs.writeFileSync(site, initialSite.slice(initialSite.indexOf('server { listen 443')));
    command('nginx', ['-t']);
    process.kill(nginx.pid!, 'SIGHUP');
    const httpsOnly = prepare();
    challenge = await startChallengeServer({
      host: '127.0.0.1',
      port: httpsOnly.challengePort,
      challenges: new Map([['https-only', 'https-only-proof']]),
    });
    await retry(
      () => fetch('http://127.0.0.1/.well-known/acme-challenge/https-only').then((r) => r.text()),
      (value) => value === 'https-only-proof',
    );
    cli('rollback');
    await challenge.close();
    challenge = undefined;
    fs.writeFileSync(site, initialSite);
    command('nginx', ['-t']);
    process.kill(nginx.pid!, 'SIGHUP');
    const plan = prepare();
    challenge = await startChallengeServer({
      host: '127.0.0.1',
      port: plan.challengePort,
      challenges: new Map([['cindy-token', 'cindy-proof']]),
    });
    await retry(
      () => fetch('http://127.0.0.1/.well-known/acme-challenge/cindy-token').then((r) => r.text()),
      (value) => value === 'cindy-proof',
    );
    await retry(
      () => fetch('http://127.0.0.1/.well-known/acme-challenge/other-client').then((r) => r.text()),
      (value) => value === 'other-client-proof',
    );
    saveMaterial();
    relay = await startRelayServer({
      dataDir,
      host: '127.0.0.1',
      port: plan.port,
      tls: material,
      publicUrl: 'https://127.0.0.1',
    });
    cli('activate');
    await retry(
      () => get('/api/device-link/relay/info'),
      (value) => value.status === 200,
    );
    assert.equal(JSON.parse((await get('/api/device-link/relay/info')).body.toString()).relayId, relayId);
    assert.equal((await get('/')).body.toString(), 'website-home');
    const originalWebsite = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        {
          hostname: '127.0.0.1',
          servername: 'website.example.test',
          headers: { Host: 'website.example.test' },
          ca: websiteMaterial.cert,
          agent: false,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        },
      );
      req.on('error', reject);
    });
    assert.equal(originalWebsite, 'website-home');
    cli('commit');
    const socket = new WebSocket('wss://127.0.0.1/api/device-link/ws', {
      ca: material.cert,
      headers: { Authorization: `CindyRelay ${owner.credential}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.close();
    const bytes = Buffer.alloc(1_100_000, 42);
    const auth = {
      Authorization: `CindyRelay ${owner.credential}`,
      'Content-Type': 'application/json',
    };
    const upload = await get(
      '/api/device-link/media/presign-put',
      'POST',
      Buffer.from(
        JSON.stringify({
          size: bytes.length,
          ext: 'bin',
          contentType: 'application/octet-stream',
        }),
      ),
      auth,
    );
    assert.equal(upload.status, 200);
    const { putUrl } = JSON.parse(upload.body.toString());
    assert.equal(
      (await get(new URL(putUrl).pathname + new URL(putUrl).search, 'PUT', bytes, { 'Content-Type': 'application/octet-stream' })).status,
      200,
    );
    console.log('[nginx-interop] IP TLS, REST, authenticated WebSocket, >1 MB upload, original website and other ACME client passed');
    material = certificate('relay-two', 'IP:127.0.0.1');
    saveMaterial();
    relay.updateTls(material);
    cli('renew');
    await retry(
      () => get('/api/device-link/relay/info'),
      (value) => value.status === 200,
    );
    prepare();
    cli('rollback');
    await retry(
      () => get('/api/device-link/relay/info'),
      (value) => value.status === 200,
    );
    cli('remove');
    assert.equal(fs.readFileSync(main, 'utf8'), initialMain);
    assert.equal(fs.readFileSync(site, 'utf8'), initialSite);
    await relay.close();
    relay = undefined;
    await challenge.close();
    challenge = undefined;
    // 已有可信 HTTPS 时：保留原证书管理，中转自动改为回环 HTTP。
    fs.writeFileSync('/tmp/website-tls/cert.pem', material.cert);
    fs.writeFileSync('/tmp/website-tls/key.pem', material.key);
    command('nginx', ['-t']);
    process.kill(nginx.pid!, 'SIGHUP');
    const existing = prepare(true);
    assert.equal(existing.existingCertificate, true);
    relay = await startRelayServer({
      dataDir,
      host: '127.0.0.1',
      port: existing.port,
      publicUrl: 'https://127.0.0.1',
    });
    cli('activate');
    cli('commit');
    await retry(
      () => get('/api/device-link/relay/info'),
      (value) => value.status === 200,
    );
    cli('remove');
    assert.equal(fs.readFileSync(site, 'utf8'), initialSite);
    await relay.close();
    relay = undefined;
    const httpOnlySite = initialSite.slice(0, initialSite.indexOf('server { listen 443'));
    fs.writeFileSync(site, httpOnlySite);
    command('nginx', ['-t']);
    process.kill(nginx.pid!, 'SIGHUP');
    const httpOnly = prepare();
    relay = await startRelayServer({ dataDir, host: '127.0.0.1', port: httpOnly.port, tls: material, publicUrl: 'https://127.0.0.1' });
    cli('activate');
    cli('commit');
    await retry(
      () => get('/api/device-link/relay/info'),
      (value) => value.status === 200,
    );
    assert.equal((await get('/')).body.toString(), 'website-home');
    cli('remove');
    assert.equal(fs.readFileSync(site, 'utf8'), httpOnlySite);
    console.log('[nginx-interop] HTTP-only and HTTPS-only installations passed');
    console.log('[nginx-interop] renewal, interrupted deployment rollback, existing HTTPS reuse and exact uninstall restoration passed');
  } finally {
    await relay?.close();
    await challenge?.close();
    nginx.kill('SIGQUIT');
  }
}

async function docker() {
  const esbuild = await import('esbuild');
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-nginx-interop-'));
  const container = `cindy-nginx-interop-${randomUUID()}`;
  const sources: string[] = [];
  let started = false;
  try {
    await esbuild.build({
      entryPoints: [fileURLToPath(import.meta.url)],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outfile: path.join(temp, 'nginx-interop.mjs'),
      external: ['esbuild', 'bufferutil', 'utf-8-validate'],
      banner: {
        js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
      },
    });
    fs.copyFileSync(path.join(packageRoot, 'dist', 'relay.mjs'), path.join(temp, 'relay.mjs'));
    command('docker', ['run', '-d', '--name', container, '--label', 'cindy-test=nginx-interop', 'node:22-slim', 'sleep', 'infinity']);
    started = true;
    console.log('[nginx-interop] isolated container started; loading tools from official images');
    command('docker', [
      'exec',
      container,
      'mkdir',
      '-p',
      '/etc/nginx/conf.d',
      '/var/log/nginx',
      '/var/cache/nginx',
      '/usr/sbin',
      '/opt/cindy-test',
    ]);
    // 不在测试中访问软件源或安装系统包；从官方镜像复制工具及其依赖，使用独立 musl 搜索路径。
    // 这些文件全部在本次容器内，不修改宿主环境；三个镜像缓存后可完全离线复跑。
    const stage = (image: string, binary: string, name: string) => {
      const source = command('docker', ['create', '--label', 'cindy-test=nginx-interop', image]).trim();
      sources.push(source);
      const listing = command('docker', ['run', '--rm', '--entrypoint', 'ldd', image, binary]);
      const loader = /^\s*(\/lib\/ld-musl-\S+)/m.exec(listing)?.[1];
      if (!loader) throw new Error('Expected an Alpine musl tool image');
      const libraries = [...new Set([...listing.matchAll(/=> (\/\S+)/g)].map((m) => m[1]))];
      const resolvedLibraries = command('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'for library do readlink -f "$library"; done',
        'libraries',
        ...libraries,
      ])
        .trim()
        .split('\n');
      const folder = path.join(temp, `${name}-libs`);
      fs.mkdirSync(folder);
      for (const [index, library] of libraries.entries())
        command('docker', ['cp', `${source}:${resolvedLibraries[index]}`, path.join(folder, path.posix.basename(library))]);
      command('docker', ['cp', '-L', `${source}:${binary}`, path.join(temp, name)]);
      command('docker', ['cp', folder, `${container}:/opt/cindy-test/`]);
      command('docker', ['cp', path.join(temp, name), `${container}:/opt/cindy-test/${name}`]);
      if (name === 'nginx') {
        command('docker', ['cp', '-L', `${source}:${loader}`, path.join(temp, 'musl-loader')]);
        command('docker', ['cp', path.join(temp, 'musl-loader'), `${container}:${loader}`]);
        const arch = path.posix.basename(loader).slice('ld-musl-'.length, -'.so.1'.length);
        command('docker', [
          'exec',
          container,
          'node',
          '-e',
          `require('node:fs').writeFileSync('/etc/ld-musl-${arch}.path','/opt/cindy-test/nginx-libs');require('node:fs').symlinkSync('/opt/cindy-test/nginx','/usr/sbin/nginx')`,
        ]);
      }
    };
    stage('nginx:alpine', '/usr/sbin/nginx', 'nginx');
    stage('certbot/certbot:latest', '/usr/bin/openssl', 'openssl');
    const opensslWrapper = path.join(temp, 'openssl-wrapper');
    fs.writeFileSync(opensslWrapper, '#!/bin/sh\nLD_LIBRARY_PATH=/opt/cindy-test/openssl-libs exec /opt/cindy-test/openssl "$@"\n');
    command('docker', ['cp', opensslWrapper, `${container}:/usr/local/bin/openssl`]);
    command('docker', ['exec', container, 'chmod', '755', '/usr/local/bin/openssl']);
    command('docker', ['cp', path.join(temp, 'relay.mjs'), `${container}:/tmp/relay.mjs`]);
    command('docker', ['cp', path.join(temp, 'nginx-interop.mjs'), `${container}:/tmp/nginx-interop.mjs`]);
    execFileSync('docker', ['exec', container, 'node', '/tmp/nginx-interop.mjs', '--inside'], { stdio: 'inherit', timeout: 120_000 });
  } finally {
    for (const source of sources) execFileSync('docker', ['rm', '-f', source], { stdio: 'ignore' });
    if (started) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('cindy-nginx-interop-'))
      fs.rmSync(resolved, { recursive: true, force: true });
  }
}

(process.argv.includes('--inside') ? inside() : docker()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
