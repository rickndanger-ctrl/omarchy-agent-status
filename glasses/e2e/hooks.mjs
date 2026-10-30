// Node module hooks: the SDK becomes sdkshim.mjs for glasses.ts, CSS imports are empty, import.meta.env.VITE_HUBS comes from E2E_HUBS.
import { registerHooks } from 'node:module';
const shim = new URL('./sdkshim.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, context, next) {
    if (spec === '@evenrealities/even_hub_sdk' && context.parentURL?.includes('/src/glasses.ts')) return { url: shim, shortCircuit: true };
    return next(spec, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true };
    const r = next(url, context);
    if (r.source && url.includes('/src/')) {
      const text = Buffer.from(r.source).toString('utf8').replaceAll('import.meta.env', `({VITE_HUBS:${JSON.stringify(process.env.E2E_HUBS ?? '')}})`);
      return { ...r, source: text };
    }
    return r;
  },
});
