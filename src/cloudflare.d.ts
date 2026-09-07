// Minimal typings for the Cloudflare runtime pieces worker.ts uses, kept local
// so the shared code keeps compiling against @types/node only.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: any, env: Env);
    readonly ctx: any;
    readonly env: Env;
  }
}
