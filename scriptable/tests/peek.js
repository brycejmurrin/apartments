// SF Rentals — body PEEK (diagnostic, read-only)
// ---------------------------------------------------------------------------
// Dumps the first ~1200 chars of the response body for the two sources that
// tend to fail (Redfin autocomplete + Apartments.com), so we can see WHAT the
// 403 / empty page actually contains (Cloudflare wall, redirect, captcha, …).
// Copies everything to your clipboard. Pushes nothing.
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function H(extra) {
  return Object.assign(
    { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
    extra || {}
  );
}

async function get(url, extra) {
  const req = new Request(url);
  req.headers = H(extra);
  let text = "",
    err = null;
  try {
    text = await req.loadString();
  } catch (e) {
    err = e.message;
  }
  const resp = req.response || {};
  return { code: resp.statusCode || 0, headers: resp.headers || {}, text, err };
}

function section(title, r) {
  const hdr = r.headers || {};
  const interesting = ["Server", "server", "cf-ray", "CF-RAY", "Set-Cookie", "set-cookie", "Location", "location", "Content-Type", "content-type"];
  const picked = interesting
    .filter((k) => hdr[k])
    .map((k) => `  ${k}: ${String(hdr[k]).slice(0, 120)}`)
    .join("\n");
  return (
    `=== ${title} ===\n` +
    `code: ${r.err ? "ERR " + r.err : r.code}   bytes: ${(r.text || "").length}\n` +
    (picked ? picked + "\n" : "") +
    `body[0:1200]:\n${(r.text || "").slice(0, 1200)}\n`
  );
}

async function main() {
  const parts = ["PEEK @ " + new Date().toISOString(), ""];

  // Redfin: prime, then autocomplete
  await get("https://www.redfin.com/");
  parts.push(
    section(
      "redfin.autocomplete",
      await get(
        "https://www.redfin.com/stingray/do/location-autocomplete?location=San%20Francisco%2C%20CA&v=2&al=1",
        { Accept: "application/json,text/plain,*/*", Referer: "https://www.redfin.com/" }
      )
    )
  );

  // Redfin: rentals via hardcoded region 17151
  parts.push(
    section(
      "redfin.rentals(17151)",
      await get(
        "https://www.redfin.com/stingray/api/v1/search/rentals?al=1&region_id=17151&region_type=6&num_homes=350&ord=redfin-recommended-asc&page_number=1&uipt=1,2,3,4,7,8&v=8&min_beds=2&max_beds=2",
        { Accept: "application/json,text/plain,*/*", Referer: "https://www.redfin.com/" }
      )
    )
  );

  // Apartments.com: prime, then search
  await get("https://www.apartments.com/");
  parts.push(
    section(
      "apartments.search",
      await get("https://www.apartments.com/san-francisco-ca/2-bedrooms/", {
        Accept: "text/html,*/*",
        Referer: "https://www.apartments.com/",
      })
    )
  );

  const report = parts.join("\n");
  console.log(report);
  Pasteboard.copy(report);

  const a = new Alert();
  a.title = "Peek done — copied to clipboard";
  a.message = report.slice(0, 1500);
  a.addAction("OK");
  await a.present();
  Script.complete();
}

main();
