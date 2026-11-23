// The few Node.js names api/push.js, api/_lib/webpush.js and api/epstarget.js use (type-checking only - no @types/node in this repo).
declare var Buffer: any;
declare module 'crypto' { const crypto: any; export = crypto; }
declare module 'zlib' { const zlib: any; export = zlib; }
