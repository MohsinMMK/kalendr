/**
 * The Kalendr address this build talks to, fixed when the extension is built (`KALENDR_ORIGIN`) and also the only address
 * the manifest gives permission for. A build for the store names the real address; the placeholder is for checks.
 */
declare const __KALENDR_ORIGIN__: string;

export const ORIGIN: string = typeof __KALENDR_ORIGIN__ === "string" ? __KALENDR_ORIGIN__ : "http://localhost:3000";
