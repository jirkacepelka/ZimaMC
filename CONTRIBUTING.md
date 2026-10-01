# Contributing to ZimaMC

Thanks for helping! Bug reports, translations and pull requests are all welcome.

## Add a language

Every language is one file in [`frontend/src/locales/`](frontend/src/locales). The app finds new files automatically.

1. Copy `en.json` to `<code>.json`, using the [ISO 639-1 code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) (for example `de.json` or `pl.json`).
2. Set `_meta.name` to the language's own name, e.g. `"Deutsch"`.
3. Translate the **values** only. Keep the keys and the `{{placeholders}}` as they are.
4. Plurals: keys ending in `_one`, `_other` (and `_few`, `_many` where your language has them) follow the [i18next plural rules](https://www.i18next.com/translation-function/plurals). Czech (`cs.json`) is an example with four forms.
5. Check that nothing is missing:

   ```bash
   npm install
   npm run check-locales -w frontend
   ```

6. Open a pull request. You can also edit the file directly on GitHub.

If a key is missing, English is shown instead, so a partial translation still works.

Optionally, translate Modrinth's category tags under `"tags"` (see `cs.json`). Tags without a translation are shown with their English name.

## Writing text for the UI

ZimaMC is for people who just want a server. Write short, plain sentences and name things the way players know them ("memory", "friends can join"), not technical terms ("heap", "port forwarding"), except in Expert settings. Error messages should say what went wrong and what to do next.

## Code

- `backend/`: Fastify API. Errors are thrown as `HttpError(status, "code")`, and each `code` has a translation under `errors.` in the locale files.
- `frontend/`: React. Shared pieces are in `src/ui.tsx`, and the styles in `src/styles.css`.

Before opening a pull request, run:

```bash
npm run typecheck && npm test && npm run build
```
