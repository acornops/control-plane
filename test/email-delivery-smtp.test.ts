import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import { config } from '../src/config.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../src/services/email-delivery.js';

/** Receive test mail on loopback only; deliberately offer neither TLS nor relay. */
async function localSmtp(t: TestContext, rejectRecipient = false) {
  const commands: string[] = [];
  const messages: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP test\r\n');
    let buffer = '';
    let receivingData = false;
    let message = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (receivingData) {
          if (line === '.') {
            messages.push(message);
            message = '';
            receivingData = false;
            socket.write('250 2.0.0 Accepted\r\n');
          } else {
            message += `${line.replace(/^\.\./, '.')}\r\n`;
          }
          continue;
        }
        commands.push(line);
        if (/^(EHLO|HELO) /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 2.7.0 Authenticated\r\n');
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 2.1.0 OK\r\n');
        else if (/^RCPT TO:/i.test(line)) socket.write(rejectRecipient ? '550 5.1.1 Rejected\r\n' : '250 2.1.5 OK\r\n');
        else if (line === 'DATA') { receivingData = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('502 5.5.1 Not supported\r\n');
      }
    });
  });
  const original = {
    EMAIL_DELIVERY_MODE: config.EMAIL_DELIVERY_MODE, EMAIL_FROM: config.EMAIL_FROM,
    EMAIL_PUBLIC_BASE_URL: config.EMAIL_PUBLIC_BASE_URL, SMTP_HOST: config.SMTP_HOST,
    SMTP_PORT: config.SMTP_PORT, SMTP_SECURE: config.SMTP_SECURE,
    SMTP_REQUIRE_TLS: config.SMTP_REQUIRE_TLS, SMTP_USERNAME: config.SMTP_USERNAME,
    SMTP_PASSWORD: config.SMTP_PASSWORD
  };
  t.after(async () => {
    Object.assign(config, original);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  Object.assign(config, {
    EMAIL_DELIVERY_MODE: 'smtp', EMAIL_FROM: 'AcornOps <sender@example.test>',
    EMAIL_PUBLIC_BASE_URL: 'https://console.example.test', SMTP_HOST: '127.0.0.1',
    SMTP_PORT: (server.address() as net.AddressInfo).port,
    SMTP_SECURE: false, SMTP_REQUIRE_TLS: false,
    SMTP_USERNAME: 'smtp-test-user', SMTP_PASSWORD: 'smtp-test-password'
  });
  return { commands, messages };
}

for (const { name, send, path, subject } of [
  { name: 'verification', send: sendVerificationEmail, path: '/verify-email', subject: 'Verify your AcornOps email' },
  { name: 'password reset', send: sendPasswordResetEmail, path: '/reset-password', subject: 'Reset your AcornOps password' }
]) {
  test(`SMTP delivers ${name} only to the intended recipient with the correct link`, { timeout: 5000 }, async (t) => {
    const smtp = await localSmtp(t);
    const result = await send({ email: 'recipient@example.test', token: 'synthetic-token', expiresAt: new Date('2026-11-01T00:00:00Z') });
    assert.equal(result.status, 'sent');
    assert.ok(result.messageId);
    assert.deepEqual(smtp.commands.filter((line) => /^AUTH /i.test(line)), [
      `AUTH PLAIN ${Buffer.from('\0smtp-test-user\0smtp-test-password').toString('base64')}`
    ]);
    assert.deepEqual(smtp.commands.filter((line) => /^RCPT TO:/i.test(line)), ['RCPT TO:<recipient@example.test>']);
    assert.deepEqual(smtp.commands.filter((line) => /^MAIL FROM:/i.test(line)), ['MAIL FROM:<sender@example.test>']);
    assert.equal(smtp.messages.length, 1);
    const message = smtp.messages[0].replace(/=\r\n/g, '').replace(/=3D/gi, '=');
    assert.ok(message.includes(`Subject: ${subject}\r\n`));
    assert.ok(message.includes(`https://console.example.test${path}?token=synthetic-token`));
    assert.ok(message.includes('2026-11-01T00:00:00.000Z'));
  });
}

test('SMTP recipient rejection is not reported as successful delivery', { timeout: 5000 }, async (t) => {
  const smtp = await localSmtp(t, true);
  await assert.rejects(sendVerificationEmail({ email: 'recipient@example.test', token: 'synthetic-token', expiresAt: new Date() }), { code: 'EENVELOPE', responseCode: 550 });
  assert.equal(smtp.messages.length, 0);
});

test('SMTP requires STARTTLS when configured and sends no message over plaintext', { timeout: 5000 }, async (t) => {
  const smtp = await localSmtp(t);
  config.SMTP_REQUIRE_TLS = true;
  await assert.rejects(sendPasswordResetEmail({ email: 'recipient@example.test', token: 'synthetic-token', expiresAt: new Date() }));
  assert.ok(smtp.commands.includes('STARTTLS'));
  assert.equal(smtp.commands.some((line) => /^AUTH |^MAIL FROM:|^RCPT TO:|^DATA$/i.test(line)), false);
  assert.equal(smtp.messages.length, 0);
});
