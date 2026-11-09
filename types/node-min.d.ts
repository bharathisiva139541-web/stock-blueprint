// The few Node.js names api/push.js and api/_lib/webpush.js use (type-checking only - no @types/node in this repo).
declare var Buffer: any;
declare module 'crypto' { const crypto: any; export = crypto; }
