/* Public site settings (no secrets - this file is published). Loaded before app.js.
   remoteApi: the Vercel deployment whose api/ (live sheet feed + quotes) the static
   copies of the site use - Firebase Hosting (*.web.app, *.firebaseapp.com) runs no
   functions of its own. Vercel hosts always use their own api/ (same origin);
   localhost and file:// stay static unless localStorage sb:api = true.
   Set remoteApi to '' to keep the Firebase copy static. */
window.SB_CONFIG = {
  remoteApi: 'https://stock-blueprint-sandy.vercel.app/'
};
