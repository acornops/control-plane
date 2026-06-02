import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface VerificationEmailInput {
  email: string;
  token: string;
  expiresAt: Date;
}

export interface PasswordResetEmailInput {
  email: string;
  token: string;
  expiresAt: Date;
}

export interface EmailDeliveryResult {
  status: 'sent' | 'skipped';
  messageId?: string;
}

function verificationUrl(token: string): string {
  const url = new URL('/verify-email', config.EMAIL_PUBLIC_BASE_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

function passwordResetUrl(token: string): string {
  const url = new URL('/reset-password', config.EMAIL_PUBLIC_BASE_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

function renderVerificationEmail(input: VerificationEmailInput): { subject: string; text: string; html: string; url: string } {
  const url = verificationUrl(input.token);
  const expiresAt = input.expiresAt.toISOString();
  const subject = 'Verify your AcornOps email';
  const text = [
    'Verify your AcornOps email',
    '',
    `Use this link to finish creating your AcornOps password account: ${url}`,
    `This link expires at ${expiresAt}.`,
    '',
    'If you did not request this account, ignore this email.'
  ].join('\n');
  const html = [
    '<p>Use this link to finish creating your AcornOps password account:</p>',
    `<p><a href="${url}">Verify your email</a></p>`,
    `<p>This link expires at ${expiresAt}.</p>`,
    '<p>If you did not request this account, ignore this email.</p>'
  ].join('');
  return { subject, text, html, url };
}

function renderPasswordResetEmail(input: PasswordResetEmailInput): { subject: string; text: string; html: string; url: string } {
  const url = passwordResetUrl(input.token);
  const expiresAt = input.expiresAt.toISOString();
  const subject = 'Reset your AcornOps password';
  const text = [
    'Reset your AcornOps password',
    '',
    `Use this link to set a new AcornOps password: ${url}`,
    `This link expires at ${expiresAt}.`,
    '',
    'If you did not request this reset, ignore this email.'
  ].join('\n');
  const html = [
    '<p>Use this link to set a new AcornOps password:</p>',
    `<p><a href="${url}">Reset your password</a></p>`,
    `<p>This link expires at ${expiresAt}.</p>`,
    '<p>If you did not request this reset, ignore this email.</p>'
  ].join('');
  return { subject, text, html, url };
}

async function sendAuthEmail(input: {
  email: string;
  expiresAt: Date;
  rendered: { subject: string; text: string; html: string; url: string };
  kind: 'verification' | 'password reset';
  logUrlKey: 'verificationUrl' | 'passwordResetUrl';
}): Promise<EmailDeliveryResult> {
  if (config.EMAIL_DELIVERY_MODE === 'disabled') {
    logger.warn({ email: input.email }, `Email ${input.kind} delivery skipped because email delivery is disabled`);
    return { status: 'skipped' };
  }

  if (config.EMAIL_DELIVERY_MODE === 'log') {
    const includeLink = config.NODE_ENV !== 'production' || config.EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION;
    const payload = !includeLink
      ? { email: input.email, expiresAt: input.expiresAt.toISOString() }
      : { email: input.email, expiresAt: input.expiresAt.toISOString(), [input.logUrlKey]: input.rendered.url };
    logger.info(payload, `Email ${input.kind} link generated`);
    return { status: 'sent', messageId: 'log' };
  }

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: config.SMTP_REQUIRE_TLS,
    auth: config.SMTP_USERNAME || config.SMTP_PASSWORD
      ? { user: config.SMTP_USERNAME, pass: config.SMTP_PASSWORD }
      : undefined
  });

  const result = await transport.sendMail({
    from: config.EMAIL_FROM,
    to: input.email,
    subject: input.rendered.subject,
    text: input.rendered.text,
    html: input.rendered.html
  });
  logger.info({ email: input.email, messageId: result.messageId }, `Email ${input.kind} message sent`);
  return { status: 'sent', messageId: result.messageId };
}

export async function sendVerificationEmail(input: VerificationEmailInput): Promise<EmailDeliveryResult> {
  return sendAuthEmail({
    email: input.email,
    expiresAt: input.expiresAt,
    rendered: renderVerificationEmail(input),
    kind: 'verification',
    logUrlKey: 'verificationUrl'
  });
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<EmailDeliveryResult> {
  return sendAuthEmail({
    email: input.email,
    expiresAt: input.expiresAt,
    rendered: renderPasswordResetEmail(input),
    kind: 'password reset',
    logUrlKey: 'passwordResetUrl'
  });
}
