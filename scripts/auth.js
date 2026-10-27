#!/usr/bin/env node
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ALL_SCOPES, OPTIONAL_SCOPES, REQUIRED_SCOPES, loadConfig, loadDotenv } from '../src/config.js';
import { buildAuthorizeUrl, describeToken, exchangeCode, saveTokenFile } from '../src/auth/flow.js';

loadDotenv();
const config = loadConfig({ cwd: process.cwd() });
const { clientId, clientSecret, redirectUri } = config.twitch;

if (!clientId || !clientSecret) {
  console.error(
    [
      '',
      'Missing Twitch app credentials.',
      '',
      '  1. Open https://dev.twitch.tv/console/apps and create an app.',
      '  2. OAuth Redirect URL must be exactly:',
      `       ${redirectUri}`,
      '     (register http://localhost:8917/callback for local development)',
      '  3. Copy the Client ID and Client Secret into .env:',
      '       TWITCH_CLIENT_ID=...',
      '       TWITCH_CLIENT_SECRET=...',
      '',
      'Then run: npm run auth',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const redirect = new URL(redirectUri);
if (!['localhost', '127.0.0.1'].includes(redirect.hostname)) {
  console.error(`Refusing to run OAuth on non-local redirect host "${redirect.hostname}".`);
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const port = Number(redirect.port || 80);
const listenHost = redirect.hostname === 'localhost' ? '127.0.0.1' : redirect.hostname;
const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end('not found');
    return;
  }
  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Twitch returned: ${error}`);
    console.error(`Authorization failed: ${error} ${url.searchParams.get('error_description') || ''}`);
    shutdown(1);
    return;
  }
  if (returnedState !== state) {
    res.writeHead(400).end('state mismatch');
    shutdown(1);
    return;
  }
  if (!code) {
    res.writeHead(400).end('missing code');
    return;
  }

  try {
    const tokenResponse = await exchangeCode({ clientId, clientSecret, code, redirectUri });
    const token = await describeToken(tokenResponse);
    token.file = config.twitch.tokenFile;
    saveTokenFile(config.twitch.tokenFile, token);

    const missing = REQUIRED_SCOPES.filter((scope) => !token.scopes.includes(scope));
    const optionalMissing = OPTIONAL_SCOPES.filter((scope) => !token.scopes.includes(scope));

    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><meta charset="utf-8"><title>Acclamation connected</title>
       <body style="font:16px system-ui;background:#0b0d12;color:#e7e9ee;padding:48px">
       <h1 style="font-size:20px">Connected as ${escapeHtml(token.login)}</h1>
       <p style="color:#9aa3b2">You can close this tab and return to the terminal.</p></body>`,
    );

    console.log('');
    console.log(`  Connected as @${token.login} (user id ${token.user_id})`);
    console.log(`  Scopes: ${token.scopes.length ? token.scopes.join(', ') : 'none returned'}`);
    console.log(`  Token file: ${config.twitch.tokenFile} (mode 600, gitignored)`);
    if (missing.length) {
      console.log('');
      console.log(`  WARNING missing required scopes: ${missing.join(', ')}`);
      console.log(`  Re-run npm run auth and approve everything: ${ALL_SCOPES.join(' ')}`);
    }
    if (optionalMissing.length) {
      console.log(`  Note: missing optional scopes: ${optionalMissing.join(', ')} (sub hype moments disabled)`);
    }
    console.log('');
    console.log('  Next:');
    console.log('    npm run doctor          # prove a real chat message arrives');
    console.log('    npm start               # dashboard + overlay');
    console.log('');
    shutdown(missing.length ? 1 : 0);
  } catch (err) {
    res.writeHead(500).end('token exchange failed');
    console.error(`Token exchange failed: ${err.message}`);
    shutdown(1);
  }
});

server.listen(port, listenHost, () => {
  console.log('');
  console.log('  Acclamation needs one Twitch account to speak for the chat.');
  console.log(`  Opening the authorization page for scopes: ${ALL_SCOPES.join(' ')}`);
  console.log('');
  console.log(`  If the browser does not open, paste this URL:`);
  console.log(`  ${authorizeUrl}`);
  console.log('');
  console.log(`  Waiting for the callback on ${redirectUri} ...`);
  openBrowser(authorizeUrl);
});

const timeout = setTimeout(() => {
  console.error('\n  Timed out after 5 minutes waiting for authorization.');
  shutdown(1);
}, 5 * 60 * 1000);

function shutdown(code) {
  clearTimeout(timeout);
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
}

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
