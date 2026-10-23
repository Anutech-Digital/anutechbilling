/* Turbopack's stand-in for Node's `fs` in the browser bundle — the same job as webpack's
   `resolve.fallback = { fs: false }` in next.config.mjs. Used only by `next dev --turbopack`. */
module.exports = {};
