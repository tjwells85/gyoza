/**
 * Stands in for a project's `server/env.ts`: the `ServerEnv` Zod output type and
 * the template's `Bun.Env` augmentation. A plain type, so no zod dependency.
 */
export type ServerEnv = {
  PORT: number;
  DEV_MODE: boolean;
  STORAGE_ROOT: string;
  SYNCTHING_URL?: string;
};

declare module 'bun' {
  interface Env extends ServerEnv {
    [key: string]: string | undefined;
  }
}
