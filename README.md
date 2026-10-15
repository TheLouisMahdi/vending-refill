# Vending Refill

Minimal mobile-first Persian/RTL vending machine shortage and refill tracker for three operators. The static frontend runs on GitHub Pages; a small Cloudflare Worker reads and updates one JSON file through the GitHub Contents API. The public repository and read API expose shortage quantities; only writes require the shared access key.

Features: 44 fixed slots, editable persistent product names, numeric Enter-to-next entry (Western/Persian/Arabic digits), shared coffee-machine statistics/notes, one Save for changed fields, nonzero refill list, individual refill completion, draft preservation and field-level conflict detection. No build or frontend dependencies.

```text
docs/       index.html, styles.css, app.js
worker/     index.js, wrangler.jsonc
data/       shortages.json
.gitignore
README.md
```

## Local development

Serve `docs/` with `python -m http.server 8080 --directory docs`. For a local API, put `GITHUB_TOKEN` and `ACCESS_KEY` in ignored `worker/.dev.vars`, then run:

```sh
npx wrangler dev --config worker/wrangler.jsonc --var DEV_ORIGIN:http://localhost:8080
```

Set the single `API_URL` constant at the top of `docs/app.js` to `http://localhost:8787` for local work. Local writes use the real repository. Restore the production URL before pushing. No shortage data is stored in the browser.

## GitHub Pages

Repository: `TheLouisMahdi/vending-refill` (public), default branch `main`. In Settings → Pages, choose **Deploy from a branch**, `main`, `/docs`. The site URL is `https://thelouismahdi.github.io/vending-refill/`.

## Cloudflare Worker

Use Node.js and Wrangler. Create a **fine-grained GitHub personal access token** restricted to this repository with **Contents: Read and write**. The GitHub CLI OAuth login is sufficient for repository setup but is not the required restricted Worker token.

```sh
npx wrangler login
npx wrangler deploy --config worker/wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put ACCESS_KEY --config worker/wrangler.jsonc
```

Paste secrets only into Wrangler's secret prompt. Generate `ACCESS_KEY` with a password manager (at least 32 random characters), keep it there, and share it privately with the three operators. Never commit either secret. The Worker stores no application data. Production CORS permits only `https://thelouismahdi.github.io`; localhost is enabled only by the development command above.

Production Worker: `https://vending-refill-api.poimu80.workers.dev`. The `API_URL` constant in `docs/app.js` points to this deployed service. Configure both secrets above, then confirm `GET /state` works before using the website. Dashboard setup is also available under Workers & Pages → vending-refill-api → Settings → Variables and Secrets; both values must use the Secret type.

## Operation and shared storage

Enter quantities in **ثبت کسری**, press Enter/Next to continue, then **ذخیره آمار**. Empty and zero both mean no shortage. The first write asks for **کد دسترسی**; the browser remembers the key only after a successful write. A rejected key is cleared and requested again. Blocked browser storage simply requires entering the key again on later visits.

Edit **نام محصول** beside each slot whenever its product changes. Saved names remain through every refill until explicitly edited or cleared. The **آمار دستگاه قهوه و یادداشت‌ها** text area below the table is saved with the same button. Product names are limited to 120 characters; notes to 5,000 characters. Existing quantities are preserved when these fields are first introduced.

In **تأمین و شارژ**, press **✓ تأمین و شارژ شد** to clear only that slot after persistence succeeds. Reads occur on load, after writes, on returning to the page and when entering the refill tab; the refill tab refreshes every 30 seconds.

`data/shortages.json` is authoritative: `slots` holds quantities, `labels` holds product names keyed by slot, and `notes` holds the coffee-machine text. Old files gain empty names/notes on read without rewriting quantities. Each PATCH sends only changed fields and their original values in `changes`/`expected`; quantity keys are slot numbers, product-name keys are `label:11` etc., and the text key is `notes`. The Worker merges with the latest GitHub state and commits with its SHA, retrying SHA races up to three times. Conflicts preserve the draft and identify the field. Review it, then press Save again to intentionally submit against the latest value. Failed writes preserve entered values; successful identical retries create no extra commit.
