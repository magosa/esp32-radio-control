export type IdFactory = () => string;

export const defaultId: IdFactory = () => globalThis.crypto.randomUUID();
