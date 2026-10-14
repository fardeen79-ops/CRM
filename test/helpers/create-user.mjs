// Test fixtures: every user gets an HRMS code (the only username at sign-in) unless the test gives one,
// and loginId() turns a fixture's email into the code the sign-in helpers post.
import { createUser as realCreateUser } from '../../src/auth.js';

const codes = new Map();
/** A deterministic code from an email, so a fixture and its sign-in agree without sharing state. */
export const codeOf = (email) => `T${String(email).toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 40);
export function createUser(db, input) {
  const hrms_code = input.hrms_code || codeOf(input.email);
  codes.set(String(input.email).toLowerCase(), hrms_code);
  return realCreateUser(db, { ...input, hrms_code });
}
/** What a test posts as the username for a fixture: its HRMS code. */
export const loginId = (email) => (String(email).includes('@') ? codes.get(String(email).toLowerCase()) || codeOf(email) : email); // a code passed in is used as is
