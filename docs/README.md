# WordLens landing page

The static marketing site for the WordLens Chrome extension. It lives in this `docs/` folder
so that GitHub Pages can publish it straight from the repository with no build step, no
dependency install and no CI.

```
docs/
  index.html    the whole page
  styles.css    design tokens, layout, components
  script.js     progressive enhancement (header state, menu, reveal, store gate)
  README.md     this file
```

There is nothing to compile. The three source files are the deliverable.

---

## Preview it locally

### Open the file directly

Double-click `docs/index.html`, or from the repository root:

```bash
xdg-open docs/index.html      # Linux
open docs/index.html          # macOS
start docs/index.html         # Windows
```

The page works from the `file://` protocol: the favicon is an inline SVG data URI and no
stylesheet, script, font or image is loaded from anywhere else.

### Serve it over HTTP (closer to the published site)

Opening the file directly is enough, but a local server matches how Pages serves it and lets
you check relative paths:

```bash
cd docs
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Any static server works; there is nothing to configure.

---

## Enable GitHub Pages

The site is published from the `/docs` folder on the default branch, which is why the files
sit here rather than in a separate repository.

1. Open the repository on GitHub and go to **Settings**.
2. In the left sidebar, click **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Set **Branch** to `main` and the folder to **`/docs`**, then click **Save**.
5. Wait for the deployment to finish (the **Actions** tab shows the run) and reload the
   Pages settings screen. The published address appears at the top.

The address has the form `https://<user>.github.io/<repository>/`, for example
`https://jsn-an.github.io/high-frequency-word-scanner/`.

### Before you publish, check two things

- **A private repository cannot use Pages on the free plan.** If Pages is greyed out in the
  settings, either make the repository public or move to a plan that includes Pages for
  private repositories.
- **`og-image.png` does not exist yet.** `index.html` points its Open Graph and Twitter tags
  at a relative `og-image.png`, so add a 1200 by 630 image with that exact name in this
  folder. Without it, link previews show no picture. Once the site is live, you can also
  change those tags to the absolute address, which some crawlers require:
  `https://jsn-an.github.io/high-frequency-word-scanner/og-image.png`.

---

## Editing

- **Colours, spacing, type scale and radii** are CSS custom properties at the top of
  `styles.css`, under "1. Design tokens". Dark mode overrides the same tokens inside a
  `prefers-color-scheme: dark` block, so changing `--accent` in the light block and the
  `--accent-text` value in the dark block re-skins the page.
- **The Chrome Web Store button** is gated by two variables at the top of `script.js`:
  `STORE_AVAILABLE` and `STORE_URL`. While `STORE_AVAILABLE` is `false` the button renders
  disabled with a "Coming soon" note, so nobody is sent to a listing that does not exist.
- **The product name** appears in `index.html` (title, meta tags, header, footer), in
  `script.js` (the example `STORE_URL`) and in this file. A find-and-replace across the four
  files is all it takes.

---

## Constraints this page keeps

- No frameworks, no build tools, no package manager, no CDN links.
- No external fonts, images or scripts. Zero network requests at runtime.
- Reads and navigates completely with JavaScript disabled.
- Light and dark themes both meet WCAG AA contrast for text.
- All motion is disabled under `prefers-reduced-motion: reduce`.
