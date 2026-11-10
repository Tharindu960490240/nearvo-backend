import nodemailer from 'nodemailer';
import { waitUntil } from '@vercel/functions';
import { emailButton, htmlFromText, renderEmail } from './emailTemplate.js';

// Uses SMTP when SMTP_HOST is set; otherwise prints emails to the console (handy for local development).
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const FROM = process.env.MAIL_FROM || 'Nearvo <no-reply@nearvo.local>';

/** Sends an email. Without `html`, the plain text is turned into the branded Nearvo layout. */
export async function sendMail({ to, subject, text, html }) {
  html = html || htmlFromText(subject, text);
  if (!transport) {
    console.log(`\n--- Email (SMTP not configured, printed instead) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---------------------------------------------------\n`);
    // Optional: save each email as an .html file to see the design in a browser (local development only).
    if (process.env.EMAIL_PREVIEW_DIR) {
      const fs = await import('node:fs');
      fs.mkdirSync(process.env.EMAIL_PREVIEW_DIR, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.html`;
      fs.writeFileSync(`${process.env.EMAIL_PREVIEW_DIR}/${name}`, html);
    }
    return;
  }
  await transport.sendMail({ from: FROM, to, subject, text, html });
}

/** The website's address (first entry of CLIENT_URL), used in email links. */
export const appUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');

export function sendPasswordResetEmail(user, token) {
  const link = `${appUrl()}/reset-password?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Reset your Nearvo password',
    text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your Nearvo password. Choose a new one here:\n${link}\n\nThe link expires in 1 hour. If you didn't ask for this, you can ignore this email - your password stays the same.\n\nThe Nearvo team`,
    html: renderEmail({
      title: 'Reset your password',
      preheader: 'Choose a new Nearvo password. The link works for 1 hour.',
      bodyHtml: `<p style="margin:0 0 12px;font-weight:600">Hi ${escapeHtml(user.name)},</p>
        <p style="margin:0 0 12px">Someone (hopefully you) asked to reset the password for your Nearvo account. Tap the button to choose a new one.</p>
        ${emailButton('Choose a new password', link)}
        <p style="margin:18px 0 0;font-size:14px;color:#5b7488">The link works for 1 hour. Didn't ask for this? You can ignore this email and your password stays the same.</p>`,
    }),
  });
}

export function sendVerificationEmail(user, token) {
  const link = `${appUrl()}/verify-email?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Confirm your Nearvo email',
    text: `Hi ${user.name},\n\nPlease confirm your email address by opening this link:\n${link}\n\nThe link expires in 24 hours.\n\nThe Nearvo team`,
    html: renderEmail({
      title: 'Welcome to Nearvo!',
      preheader: 'Confirm your email address to finish setting up your account.',
      bodyHtml: `<p style="margin:0 0 12px;font-weight:600">Hi ${escapeHtml(user.name)},</p>
        <p style="margin:0 0 12px">Thanks for joining Nearvo. Please confirm this is your email address so we can send you quotes, job alerts and updates.</p>
        ${emailButton('Confirm my email', link)}
        <p style="margin:18px 0 0;font-size:14px;color:#5b7488">The link works for 24 hours. If you didn't create a Nearvo account, you can ignore this email.</p>`,
    }),
  });
}

/**
 * Runs a task after the response is sent. On Vercel, waitUntil keeps the function alive until
 * the task finishes (otherwise the platform can stop it as soon as the response goes out).
 */
export function background(promise) {
  const p = Promise.resolve(promise).catch((err) => console.error('Background task failed:', err.message));
  waitUntil(p);
  return p;
}

/** Sends a notification email without making the user wait for it. */
export function notify(to, subject, text) {
  return background(sendMail({ to, subject, text }));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
