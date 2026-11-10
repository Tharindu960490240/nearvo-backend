// Branded HTML email layout for every Nearvo email: logo header, white card, big button, footer.
// Built with tables and inline styles so it looks right in Gmail, Outlook and Apple Mail.
// The logo is a PNG served by the website (nearvo-frontend/public/email-logo.png); set
// EMAIL_LOGO_URL to use a different one.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const site = () => (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
const logoUrl = () => process.env.EMAIL_LOGO_URL || `${site()}/email-logo.png`;

const C = { brand: '#0288d1', brandDark: '#01579b', ink: '#0d2b45', muted: '#5b7488', line: '#dceaf4', bg: '#eef6fc', soft: '#f2f9fe' };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** A "bulletproof" button (works in Outlook too). */
export function emailButton(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 18px"><tr>
    <td align="center" bgcolor="${C.brand}" style="border-radius:10px;background:${C.brand};background-image:linear-gradient(135deg,#29b6f6,${C.brand})">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a>
    </td></tr></table>`;
}

/**
 * Wraps content in the Nearvo layout.
 * renderEmail({ title, preheader, bodyHtml }) -> full HTML document
 *  - title: big heading in the card
 *  - preheader: grey preview text shown next to the subject in the inbox
 *  - bodyHtml: inner HTML (use emailButton() for buttons)
 */
export function renderEmail({ title, preheader = '', bodyHtml }) {
  const s = site();
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
<style>
  a { color: ${C.brand}; }
  @media (max-width: 620px) { .card { padding: 26px 20px !important; } .wrap { padding: 16px 10px !important; } h1 { font-size: 22px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}">
  <tr><td align="center" class="wrap" style="padding:28px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px">
      <tr><td align="left" style="padding:4px 6px 18px">
        <a href="${esc(s)}" target="_blank" style="text-decoration:none">
          <img src="${esc(logoUrl())}" width="150" height="47" alt="Nearvo" style="display:block;border:0;outline:none;width:150px;height:auto;font-family:${FONT};font-size:24px;font-weight:800;color:${C.ink}">
        </a>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${C.line};border-radius:16px;overflow:hidden">
        <div style="height:6px;line-height:6px;font-size:0;background:${C.brand};background-image:linear-gradient(90deg,#4fc3f7,${C.brand})">&nbsp;</div>
        <div class="card" style="padding:32px 34px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink}">
          <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;font-weight:800;color:${C.ink}">${esc(title)}</h1>
          ${bodyHtml}
        </div>
      </td></tr>
      <tr><td style="padding:22px 10px 8px;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${C.muted};text-align:center">
        <a href="${esc(s)}/tradies" style="color:${C.muted}">Find a tradie</a> &nbsp;·&nbsp;
        <a href="${esc(s)}/report" style="color:${C.muted}">Report a problem</a> &nbsp;·&nbsp;
        <a href="${esc(s)}/privacy" style="color:${C.muted}">Privacy</a> &nbsp;·&nbsp;
        <a href="${esc(s)}/terms" style="color:${C.muted}">Terms</a><br>
        You're getting this service email because of your Nearvo account or a request made on Nearvo.<br>
        Nearvo connects customers with independent tradies across Australia.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ---------- Plain text -> branded HTML ----------
// Lets every existing plain-text email get the new look without rewriting it:
//  - "Hi Sam," becomes the greeting, the closing "Nearvo" / "The Nearvo team" is dropped (the footer covers it)
//  - a line ending in a link becomes a button; the words before the link become the button label

const LABEL_BY_PATH = [
  [/\/verify-email/, 'Confirm email'], [/\/reset-password/, 'Choose a new password'], [/\/jobs\/\d+/, 'View the job'],
  [/\/tradie\/profile/, 'Open my profile'], [/\/dashboard/, 'Open Nearvo'], [/\/login/, 'Log in'],
];
const labelFor = (text, url) => {
  const t = text.replace(/[:\s]+$/, '').trim();
  if (t && t.length <= 30) return t.charAt(0).toUpperCase() + t.slice(1);
  return (LABEL_BY_PATH.find(([re]) => re.test(url)) || [null, 'Open Nearvo'])[1];
};
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${C.brand};word-break:break-all">$1</a>`);

export function htmlFromText(subject, text) {
  const paras = String(text || '').trim().split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length && /^(nearvo|the nearvo team)$/i.test(paras[paras.length - 1])) paras.pop();
  let preheader = '';
  const parts = paras.map((p, i) => {
    if (i === 0 && /^(hi|hello|congratulations)\b/i.test(p) && p.length < 80 && !p.includes('\n')) {
      return `<p style="margin:0 0 12px;font-weight:600">${esc(p)}</p>`;
    }
    if (!preheader) preheader = p.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
    const lines = p.split('\n');
    const out = [];
    let textLines = [];
    const flush = () => { if (textLines.length) { out.push(`<p style="margin:0 0 12px">${textLines.map(linkify).join('<br>')}</p>`); textLines = []; } };
    for (const line of lines) {
      const m = line.match(/^(.*?)(https?:\/\/\S+)\s*$/);
      if (m) {
        const label = labelFor(m[1], m[2]);
        if (m[1].trim() && m[1].replace(/[:\s]+$/, '').trim().length > 30) textLines.push(m[1].replace(/[:\s]+$/, '').trim() + '.');
        flush();
        out.push(emailButton(label, m[2]));
      } else if (/^- /.test(line)) {
        textLines.push(`• ${line.slice(2)}`);
      } else {
        textLines.push(line);
      }
    }
    flush();
    return out.join('');
  });
  return renderEmail({ title: subject, preheader, bodyHtml: parts.join('') });
}

export const emailColors = C;
export const escapeEmail = esc;
