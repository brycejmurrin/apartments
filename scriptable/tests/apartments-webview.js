// Apartments.com via WebView — isolated test (read-only, pushes nothing)
// ---------------------------------------------------------------------------
// Loads the apartments.com SF 2-bed search in a real iOS WebView so Akamai's
// bot-manager JS runs and clears, then scrapes the rendered DOM. Reports how
// many listings it found + the page <title>, and copies a sample to clipboard.
//
// If this shows a count > 0, the WebView approach beats the Akamai 403 that
// raw HTTP requests hit. Tune WAIT_MS up if it returns 0 (page not done).
// ---------------------------------------------------------------------------

const WAIT_MS = 4500;
const URL = "https://www.apartments.com/san-francisco-ca/2-bedrooms/";

function sleep(ms) {
  return new Promise((r) => Timer.schedule(ms, false, r));
}

const extractor = `(function(){
  var out = [];
  var seen = {};
  function push(o){ if(o && o.url && !seen[o.url]){ seen[o.url]=1; out.push(o); } }
  try {
    var s = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i=0;i<s.length;i++){
      var d; try { d = JSON.parse(s[i].textContent); } catch(e){ continue; }
      var arr = Array.isArray(d) ? d : [d];
      for (var j=0;j<arr.length;j++){
        var e = arr[j]; if(!e||typeof e!=='object') continue;
        var items = [];
        if (e['@type']==='SearchResultsPage' && e.about && e.about.length) items = e.about;
        else if (e.itemListElement && e.itemListElement.length)
          items = e.itemListElement.map(function(x){ return (x&&x.item)||x; });
        for (var k=0;k<items.length;k++){
          var it = items[k]; if(!it||typeof it!=='object') continue;
          var u = it.url || it['@id']; if(!u) continue;
          var addr = it.address || {};
          push({ url:u, name: it.name||null,
            address: (typeof addr==='string')?addr:(addr.streetAddress||null) });
        }
      }
    }
  } catch(e){}
  try {
    var cards = document.querySelectorAll('article.placard, li.mortar-wrapper article, .placard');
    for (var c=0;c<cards.length;c++){
      var a = cards[c];
      var u = a.getAttribute('data-url');
      if(!u){ var ln=a.querySelector('a.property-link,a[href]'); u = ln && ln.href; }
      if(!u) continue;
      function tx(sel){ var el=a.querySelector(sel); return el?el.textContent.replace(/\\s+/g,' ').trim():null; }
      push({ url:u, name: tx('.js-placardTitle, .property-title'),
        price: tx('.property-pricing, .price-range'),
        beds: tx('.property-beds, .bed-range') });
    }
  } catch(e){}
  return JSON.stringify({ title: document.title || '', jsonld:
    document.querySelectorAll('script[type="application/ld+json"]').length,
    placards: document.querySelectorAll('.placard').length,
    count: out.length, sample: out.slice(0, 5) });
})();`;

async function main() {
  const wv = new WebView();
  await wv.loadURL(URL);
  await sleep(WAIT_MS);

  let report;
  try {
    const res = await wv.evaluateJavaScript(extractor);
    const d = JSON.parse(res);
    report =
      "apartments WebView test\n" +
      "url: " + URL + "\n" +
      "wait: " + WAIT_MS + "ms\n" +
      "page title: " + d.title + "\n" +
      "jsonld scripts: " + d.jsonld + "  placards: " + d.placards + "\n" +
      "LISTINGS FOUND: " + d.count + "\n\n" +
      "sample:\n" + JSON.stringify(d.sample, null, 2);
  } catch (e) {
    report = "WebView eval error: " + e.message;
  }

  console.log(report);
  Pasteboard.copy(report);
  const a = new Alert();
  a.title = "Apartments WebView test";
  a.message = report.slice(0, 1500);
  a.addAction("OK");
  await a.present();
  Script.complete();
}

main();
