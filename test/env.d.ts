import type { Env as DropEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    // Declaration merging needs an interface, even an empty one.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends DropEnv {}
  }
}
