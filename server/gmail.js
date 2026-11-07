import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const TOKEN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'google-oauth-tokens.json'
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email'
];

const oauthStates = new Map();

export function isGoogleOAuthConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

function createOAuthClient() {
  if (!isGoogleOAuthConfigured()) {
    throw new Error(
      'Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env.'
    );
  }

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function readTokens() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read the saved Gmail authorization. Reconnect Gmail.');
  }
}

async function saveTokens(tokens) {
  const directory = path.dirname(TOKEN_FILE);
  const tempFile = `${TOKEN_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(tempFile, JSON.stringify(tokens), { mode: 0o600 });
  await fs.chmod(tempFile, 0o600);
  await fs.rename(tempFile, TOKEN_FILE);
  await fs.chmod(TOKEN_FILE, 0o600);
}

async function deleteTokens() {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function addTokenRefreshPersistence(client, initialTokens) {
  let persistedTokens = { ...initialTokens };

  client.on('tokens', tokens => {
    persistedTokens = { ...persistedTokens, ...tokens };
    saveTokens(persistedTokens).catch(() => {
      console.error('Could not persist refreshed Gmail authorization.');
    });
  });
}

export function createGmailAuthorizationUrl() {
  const client = createOAuthClient();
  const state = crypto.randomBytes(32).toString('hex');

  for (const [savedState, expiry] of oauthStates) {
    if (expiry < Date.now()) oauthStates.delete(savedState);
  }

  oauthStates.set(state, Date.now() + 10 * 60 * 1000);

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state
  });
}

export async function finishGmailAuthorization({ code, state, providerError }) {
  const expiry = oauthStates.get(state);
  oauthStates.delete(state);

  if (!expiry || expiry < Date.now()) {
    throw new Error('Gmail authorization expired or the state was invalid. Start the connection again.');
  }

  if (providerError) {
    throw new Error(`Google authorization was not completed (${providerError}).`);
  }

  if (!code) {
    throw new Error('Google did not return an authorization code. Try connecting Gmail again.');
  }

  const client = createOAuthClient();
  let tokens;

  try {
    ({ tokens } = await client.getToken(code));
  } catch {
    throw new Error('Google could not exchange the authorization code. Check the OAuth client settings and redirect URI.');
  }

  const previous = await readTokens();
  const combined = { ...previous, ...tokens };

  if (!combined.refresh_token) {
    throw new Error('Google did not issue a refresh token. Reconnect and approve access again.');
  }

  await saveTokens(combined);
  client.setCredentials(combined);

  const userInfo = google.oauth2({ version: 'v2', auth: client });
  let identity;

  try {
    identity = await userInfo.userinfo.get();
  } catch {
    throw new Error('Google authorization was received, but the account could not be verified. Reconnect Gmail.');
  }

  if (!identity.data.email) {
    throw new Error('Google authorization succeeded, but the Gmail account could not be verified.');
  }

  addTokenRefreshPersistence(client, combined);
  return { email: identity.data.email };
}

export async function getGmailConnectionStatus() {
  if (!isGoogleOAuthConfigured()) {
    return {
      configured: false,
      connected: false,
      email: '',
      error: 'Set the Google OAuth client ID, secret, and redirect URI in .env.'
    };
  }

  const tokens = await readTokens();

  if (!tokens?.refresh_token) {
    return { configured: true, connected: false, email: '', error: '' };
  }

  try {
    const client = createOAuthClient();
    client.setCredentials(tokens);
    addTokenRefreshPersistence(client, tokens);
    await client.getAccessToken();

    const userInfo = google.oauth2({ version: 'v2', auth: client });
    const identity = await userInfo.userinfo.get();

    return {
      configured: true,
      connected: true,
      email: identity.data.email || ''
    };
  } catch (error) {
    const status = error.code || error.response?.status;

    if (status === 401 || error.message?.includes('invalid_grant')) {
      await deleteTokens();
      return {
        configured: true,
        connected: false,
        email: '',
        error: 'Gmail access expired or was revoked. Reconnect Gmail.'
      };
    }

    return {
      configured: true,
      connected: false,
      email: '',
      error: 'Could not verify the Gmail connection. Check your internet connection and reconnect if needed.'
    };
  }
}

export async function sendGmailMessage({ recipients, subject, text, html }) {
  if (
    !Array.isArray(recipients) ||
    recipients.length === 0 ||
    recipients.some(
      recipient =>
        typeof recipient !== 'string' ||
        recipient.length > 254 ||
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)
    )
  ) {
    throw new Error('Add at least one valid email recipient before sending.');
  }

  const tokens = await readTokens();

  if (!tokens?.refresh_token) {
    throw new Error('Connect Gmail before sending email notifications.');
  }

  try {
    const client = createOAuthClient();
    client.setCredentials(tokens);
    addTokenRefreshPersistence(client, tokens);
    await client.getAccessToken();

    const safeSubject = String(subject).replace(/[\r\n]+/g, ' ').trim();
    const encodedSubject = `=?UTF-8?B?${Buffer.from(safeSubject, 'utf8').toString('base64')}?=`;

    let contentType = 'Content-Type: text/plain; charset="UTF-8"';
    let body;

    if (html) {
      const boundary = `pricedrop-${crypto.randomBytes(12).toString('hex')}`;
      contentType = `Content-Type: multipart/alternative; boundary="${boundary}"`;

      body = [
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        String(text),
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        String(html),
        `--${boundary}--`
      ].join('\r\n');
    } else {
      body = [
        'Content-Transfer-Encoding: 8bit',
        '',
        String(text)
      ].join('\r\n');
    }

    const mimeMessage = [
      `To: ${recipients.join(', ')}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      contentType,
      '',
      body
    ].join('\r\n');

    const raw = Buffer.from(mimeMessage, 'utf8').toString('base64url');
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw }
    });
  } catch (error) {
    const status = error.code || error.response?.status;

    if (status === 401 || error.message?.includes('invalid_grant')) {
      await deleteTokens();
      throw new Error('Gmail authorization expired or was revoked. Reconnect Gmail and try again.');
    }

    if (status === 403) {
      throw new Error('Google denied Gmail sending access. Reconnect Gmail and approve the Gmail send permission.');
    }

    throw new Error(
      'Gmail could not send the message. Check the Google connection, Gmail API setup, and recipient addresses.'
    );
  }
}

export function gmailCallbackRedirect({ success, message = '' }) {
  const target = new URL(process.env.FRONTEND_URL || 'http://localhost:5173');
  target.searchParams.set('gmail', success ? 'connected' : 'error');

  if (!success) {
    target.searchParams.set('gmail_message', message.slice(0, 300));
  }

  return target.toString();
}
