/** Limits shared by the Worker and its tests. The Worker's entry module may only export handlers. */
export const MAX_PAYLOAD_BYTES = 200_000;
export const MAX_MESSAGES_PER_KEY = 100;
export const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
/** Sign-in locks after this many wrong passwords within the window. */
export const SIGN_IN_MAX_FAILURES = 10;
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
