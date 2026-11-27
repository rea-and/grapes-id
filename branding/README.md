# Sign-in branding

What the GrapesID sign-in pages look like. Installed by `deploy/brand.sh` (it runs after every `./deploy.sh`, or alone with `./deploy.sh --brand`).

| File | What it is |
|---|---|
| `grapesid.css` | The style layer: aubergine atmosphere, glass card, Fraunces + Inter type, gradient buttons, light and dark. Linked into every sign-in page by Apache (`deploy/apache-brand.inc`) |
| `fonts/` | Self-hosted fonts. The sign-in pages only allow same-origin fonts and images |
| `logo-dark.png`, `logo-light.png` | Wordmark for dark and light backgrounds |
| `icon.png`, `icon-dark.png` | The grape mark alone |
| `grape-mark.svg` | The mark as vector, source of the PNGs |
| `build-assets.mjs` | Regenerates the PNGs (needs `puppeteer-core` and Chrome; only when the design changes) |

Zitadel's own branding (colours, logo, icon, which also reach the admin console and its e-mails) is applied by `scripts/brand.mjs`.

**Edit the look:** change `grapesid.css`, run `./deploy.sh --brand`, hard-refresh the sign-in page (cache is 5 minutes).
**Switch it off:** `deploy/brand.sh --remove`. The sign-in pages go back to Zitadel's default look.

The stylesheet relies on stable hooks (`form`, `input`, `button[type=submit]`, `h1`) plus a few structural selectors. After a Zitadel upgrade, check the sign-in page; if a selector stops matching, that part simply falls back to Zitadel's own styling.
