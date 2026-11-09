import nodemailer from 'nodemailer';

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

export function sendVerificationEmail(user, token) {
  const link = `${(process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0]}/verify-email?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Confirm your Nearvo email',
    text: `Hi ${user.name},\n\nPlease confirm your email address by opening this link:\n${link}\n\nThe link expires in 24 hours.\n\nThe Nearvo team`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Please confirm your email address:</p>
           <p><a href="${link}" style="background:#0288D1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Confirm email</a></p>
           <p style="color:#557086">The link expires in 24 hours.</p>`,
  });
}

export function notify(to, subject, text) {
  return sendMail({ to, subject, text }).catch((err) => console.error('Email failed:', err.message));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
