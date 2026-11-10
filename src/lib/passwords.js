// Password rules, shared by sign-up, reset and change password.
// Same checks as the website's checklist (nearvo-frontend/src/passwordRules.js).
const COMMON = new Set([
  'password', 'passwd', 'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'zxcvbn', 'letmein', 'welcome', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'soccer', 'sunshine', 'princess', 'trustno', 'master', 'shadow',
  'superman', 'batman', 'michael', 'jennifer', 'login', 'secret', 'changeme', 'default', 'abc', 'abcd', 'abcdef', 'test',
  'guest', 'user', 'hello', 'freedom', 'whatever', 'starwars', 'pokemon', 'summer', 'winter', 'spring', 'autumn',
  'nearvo', 'tradie', 'tradies', 'plumber', 'electrician', 'australia', 'aussie', 'sydney', 'melbourne', 'brisbane',
  'perth', 'adelaide', 'hobart', 'canberra', 'darwin',
]);
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
// Drop numbers/symbols stuck on the start or end ("Password123!"), undo look-alikes ("P@ssw0rd"), keep letters.
const baseWord = (p) => p.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '').replace(/[013457@$!]/g, (c) => LEET[c]).replace(/[^a-z]/g, '');

/** Words from someone's name/email that shouldn't be in their password. */
export function personalHints(...values) {
  return values.flatMap((v) => String(v || '').toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 3);
}

/** Returns a message explaining what's wrong, or null when the password is fine. */
export function passwordProblem(p, hints = []) {
  p = String(p || '');
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 200) return 'Password is too long';
  if (!/[A-Z]/.test(p)) return 'Password needs a capital letter (A–Z)';
  if (!/[a-z]/.test(p)) return 'Password needs a small letter (a–z)';
  if (!/[0-9]/.test(p)) return 'Password needs a number (0–9)';
  if (!/[^A-Za-z0-9\s]/.test(p)) return 'Password needs a symbol such as @ $ ! % * ? &';
  const base = baseWord(p);
  if (COMMON.has(base) || base.length < 3) return 'That password is too common and easy to guess. Please choose something less obvious.';
  const lower = p.toLowerCase();
  if (hints.some((h) => lower.includes(h) || base === h)) return "Please don't use your name or email address in your password";
  return null;
}
