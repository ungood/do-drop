/** Limits shared by the Worker and its tests. The Worker's entry module may only export handlers. */
export const MAX_PAYLOAD_BYTES = 200_000;
export const MAX_MESSAGES_PER_KEY = 100;
export const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
