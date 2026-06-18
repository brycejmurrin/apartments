"""Unit tests for the pure parsing helpers and the embedded-JSON extractor.

These run without network, so CI can verify the parsing logic even when the
live sites are unreachable.
"""
from scraper.models import parse_beds, parse_neighborhood, parse_price, parse_sqft
from scraper.adapters._embedded import extract_next_data, extract_script_json
from scraper.adapters.craigslist import parse_feed

SAMPLE_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item rdf:about="https://sfbay.craigslist.org/sfc/apa/12345.html">
    <title>$3,500 / 2br - 1100ft2 - Sunny flat (noe valley)</title>
    <link>https://sfbay.craigslist.org/sfc/apa/12345.html</link>
    <dc:date>2026-06-17T10:00:00-07:00</dc:date>
  </item>
  <item rdf:about="https://sfbay.craigslist.org/sfc/apa/67890.html">
    <title>Charming 2br near park</title>
    <link>https://sfbay.craigslist.org/sfc/apa/67890.html</link>
    <dc:date>2026-06-16T09:00:00-07:00</dc:date>
  </item>
</rdf:RDF>"""


def test_parse_price():
    assert parse_price("$3,500 / 2br - 1000ft2 (mission)") == 3500
    assert parse_price("$950") == 950
    assert parse_price("no price here") is None
    assert parse_price("$5") is None          # below floor -> noise
    assert parse_price("$2,500,000") is None  # sale price -> noise


def test_parse_beds():
    assert parse_beds("nice 2br flat") == 2.0
    assert parse_beds("studio") is None


def test_parse_sqft():
    assert parse_sqft("2br - 1,200ft2") == 1200
    assert parse_sqft("no size") is None


def test_parse_neighborhood():
    assert parse_neighborhood("$3500 / 2br (noe valley)") == "noe valley"
    assert parse_neighborhood("no parens") is None


def test_extract_next_data():
    html = (
        '<html><body>'
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props":{"x":1}}</script></body></html>'
    )
    assert extract_next_data(html) == {"props": {"x": 1}}
    assert extract_next_data("<html></html>") is None


def test_extract_script_json():
    html = 'var pageData = {"listings": [1, 2, 3]}; more();'
    assert extract_script_json(html, "pageData") == {"listings": [1, 2, 3]}


def test_craigslist_parse_feed():
    listings = parse_feed(SAMPLE_RSS)
    assert len(listings) == 2
    first = listings[0]
    assert first.source == "craigslist"
    assert first.source_id == "12345"
    assert first.price == 3500
    assert first.beds == 2.0
    assert first.sqft == 1100
    assert first.neighborhood == "noe valley"
    assert first.posted_at.startswith("2026-06-17")
    # Second item has no price/sqft in the title -> None, but beds parsed.
    assert listings[1].price is None
    assert listings[1].beds == 2.0
