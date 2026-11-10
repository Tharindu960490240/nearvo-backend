// Password rules, shared by sign-up, reset and change password.
// Same rules as the checklist in the website (nearvo-frontend/src/passwordRules.js).
export function passwordProblem(p) {
  p = String(p || '');
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 200) return 'Password is too long';
  if (!/[A-Z]/.test(p)) return 'Password needs a capital letter (A–Z)';
  if (!/[a-z]/.test(p)) return 'Password needs a small letter (a–z)';
  if (!/[0-9]/.test(p)) return 'Password needs a number (0–9)';
  if (!/[^A-Za-z0-9\s]/.test(p)) return 'Password needs a symbol such as @ $ ! % * ? &';
  return null;
}
