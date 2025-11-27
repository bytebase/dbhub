export type { Request } from "./store.js";
export { RequestStore } from "./store.js";
import { RequestStore } from "./store.js";

/**
 * Singleton request store instance
 */
export const requestStore = new RequestStore();
