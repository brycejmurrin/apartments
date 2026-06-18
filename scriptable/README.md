# Scrape from your iPhone with Scriptable

This runs the crawler **on your phone** (residential IP, native HTTP — no CORS and
no datacenter-IP block) and pushes the results to this repo via the GitHub API, so
the GitHub Pages dashboard shows them. Tap a widget to refresh — no terminal, no
computer.

It currently scrapes **Craigslist** and **Redfin**, which work reliably from a
residential IP. (Zillow/Trulia/Apartments.com use PerimeterX/Cloudflare JS
challenges and may still resist even from a phone; you can add them later in
`sf-rentals.js`.)

## One-time setup (~5 minutes, all on the phone)

1. **Install Scriptable** (free) from the App Store.

2. **Create a GitHub token** so the script can write the data file:
   - On github.com (mobile browser) → your avatar → **Settings** → **Developer
     settings** → **Personal access tokens** → **Fine-grained tokens** →
     **Generate new token**.
   - **Repository access**: Only select repositories → `brycejmurrin/apartments`.
   - **Permissions**: Repository permissions → **Contents** → **Read and write**.
   - Generate it and copy the `github_pat_…` string.

3. **Add the script to Scriptable**:
   - Open `scriptable/sf-rentals.js` in this repo on your phone, tap **Raw**, and
     copy everything.
   - In Scriptable tap **＋**, paste it, and name the script **SF Rentals**.

4. **Run it** (tap the ▶ in Scriptable). The first run asks for your token and
   stores it in the iOS keychain (only on your device). It fetches listings,
   pushes `docs/data/listings.json`, and shows a summary like
   `42 listings · 2/2 sources OK`.

5. **Enable the dashboard** (one-time, on github.com): repo **Settings → Pages →
   Build and deployment → Source: Deploy from a branch → branch `main`, folder
   `/docs`**. Your site is at `https://brycejmurrin.github.io/apartments/`.

## Run it with one tap

- **Home-screen widget**: long-press the home screen → ＋ → Scriptable → add a
  widget → tap it → choose **SF Rentals** as the script. Tapping the widget runs it.
- **Or a Shortcut**: Shortcuts app → ＋ → add action **Run Script** (Scriptable) →
  pick **SF Rentals** → add the Shortcut to your home screen for a one-tap icon.
- **Or schedule it**: Shortcuts → Automation → create a time-based automation that
  runs the Shortcut (e.g. every morning).

## Notes

- The dashboard shows this data on load. If you've also used the page's in-browser
  **⚡ Fetch live** API button, that cached API result takes precedence in your
  browser — tap the API source off, or it's fine, they're just different sources.
- Change the search (city, bedrooms) at the top of `sf-rentals.js` (`CRITERIA`).
- Keep runs occasional and reasonable — this is for personal apartment hunting.
