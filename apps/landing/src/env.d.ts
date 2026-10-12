/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Portal origin used by `astro dev`; production images substitute it at container start. */
  readonly PUBLIC_PORTAL_URL?: string;
}
