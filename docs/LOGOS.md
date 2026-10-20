# Company logos

The site shows a logo only from a **verified** mapping in `web/data/logos.js`:

```js
window.SB_LOGOS = {
  'NSE:TCS': { url: 'https://www.tcs.com/.../logo.svg', source: 'tcs.com (official site)', verified: true }
};
```

Every other stock gets a neutral two-letter monogram. A logo is never guessed
from the company name or ticker, and a broken image falls back to the
monogram automatically.

Why the list starts empty: the sheet has no ISIN or official-website column,
and no licensed logo feed is configured. To add logos, take each one from the
company's official website (or a logo/data licence you hold), check that it
is the right company (NSE symbol + name), and add an entry as above.
