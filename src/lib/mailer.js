import nodemailer from 'nodemailer';
import { waitUntil } from '@vercel/functions';

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

export async function sendMail({ to, subject, text, html }) {
  if (!transport) {
    console.log(`\n--- Email (SMTP not configured, printed instead) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---------------------------------------------------\n`);
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
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Someone (hopefully you) asked to reset your Nearvo password.</p>
           <p><a href="${link}" style="background:#0288D1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
           <p style="color:#557086">The link expires in 1 hour. If you didn't ask for this, ignore this email and your password stays the same.</p>`,
  });
}

export function sendVerificationEmail(user, token) {
  const link = `${appUrl()}/verify-email?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Confirm your Nearvo email',
    text: `Hi ${user.name},\n\nPlease confirm your email address by opening this link:\n${link}\n\nThe link expires in 24 hours.\n\nThe Nearvo team`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Please confirm your email address:</p>
           <p><a href="${link}" style="background:#0288D1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Confirm email</a></p>
           <p style="color:#557086">The link expires in 24 hours.</p>`,
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
