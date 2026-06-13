// Build-time deploy stamp, served as a static file at /version.txt by the nginx image.
//
// The CD app workflow passes PUBLIC_GIT_SHA (the short commit SHA) to `astro build`; Vite exposes
// PUBLIC_-prefixed env to import.meta.env, so this prerendered endpoint bakes it into dist/version.txt.
// coolify-deploy.sh then polls https://app.tasca.dev/version.txt AFTER Coolify reports a finished
// rollout and FAILS the job unless it matches the pushed tag — so an app rollout that silently
// re-served the OLD image (Coolify mutable-tag #5318) can't pass as success. "Merged" reliably means
// "the new app is actually serving." 'unknown' for a local/dev build (no PUBLIC_GIT_SHA). import.meta.env
// (not process.env) matches the app's idiomatic env access — no Node types in this static project.
import type { APIRoute } from 'astro';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(import.meta.env.PUBLIC_GIT_SHA ?? 'unknown', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
