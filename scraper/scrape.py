#!/usr/bin/env python3
"""Scrape RNZ's Election 2026 electorate results into a JSON file.

The RNZ page is a Next.js app. Its server-rendered HTML embeds the page data
in `self.__next_f.push([1, "..."])` "flight" chunks, which contain a clean
`"electorates": [...]` array. We parse that first, and fall back to parsing
the rendered HTML table if RNZ changes the embedded format.

Standard library only, so it runs on a bare GitHub Actions runner.

Usage:
    python3 scraper/scrape.py [--out docs/data/electorates.json] [--html FILE]

Exit codes: 0 = data changed and was written, 3 = no change, 1 = error.
"""

from __future__ import annotations

import argparse
import html as htmllib
import json
import os
import re
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

SOURCE_URL = "https://www.rnz.co.nz/news/election-2026-results/electorates"
RNZ_BASE = "https://www.rnz.co.nz"
USER_AGENT = "Mozilla/5.0 (compatible; election-dashboard/1.0; +https://github.com/schnelle14/Election_dashboard)"
MIN_ELECTORATES = 60  # sanity floor: NZ has 71 electorates in 2026

EXIT_CHANGED, EXIT_UNCHANGED, EXIT_ERROR = 0, 3, 1


def fetch(url: str, retries: int = 3) -> str:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml",
                    "Cache-Control": "no-cache",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as err:  # noqa: BLE001 - retry on any network error
            last_err = err
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


# --------------------------------------------------------------------------
# Primary parser: Next.js flight payload
# --------------------------------------------------------------------------

def _flight_payload(page: str) -> str:
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', page)
    return "".join(json.loads('"' + c + '"') for c in chunks)


def _resolve_refs(node, root: list, depth: int = 0):
    """Resolve React Server Component back-references within the array.

    RSC dedupes repeated objects (e.g. the same party for many rows) into
    strings like "$28:props:children:props:electorates:2:leader:party",
    meaning "same value as electorates[2].leader.party". We resolve the part
    after the last ":electorates:" segment against the array itself.
    """
    if depth > 20:
        raise ValueError("RSC reference cycle")
    if isinstance(node, dict):
        return {k: _resolve_refs(v, root, depth) for k, v in node.items()}
    if isinstance(node, list):
        return [_resolve_refs(v, root, depth) for v in node]
    if isinstance(node, str) and node.startswith("$") and ":electorates:" in node:
        target = root
        for seg in node.rsplit(":electorates:", 1)[1].split(":"):
            target = target[int(seg)] if isinstance(target, list) else target[seg]
        return _resolve_refs(target, root, depth + 1)
    return node


def _norm_from_flight(e: dict) -> dict:
    leader = e.get("leader") or {}
    party = leader.get("party") or {}
    slug = e.get("slug") or ""
    return {
        "id": e.get("id"),
        "name": e["name"],
        "slug": slug,
        "url": f"{RNZ_BASE}/news/election-2026-results/electorate/{slug}" if slug else SOURCE_URL,
        "isKey": bool(e.get("isKey")),
        "isMaori": bool(e.get("isMaori")),
        "percentCounted": float(e.get("percentCounted") or 0),
        "status": e.get("status") or "",
        "candidate": leader.get("candidateDisplayName") or leader.get("candidateName") or "",
        "party": party.get("displayName") or ("Independent" if leader.get("isIndependent") else ""),
        "partyShort": party.get("shortDisplayName") or "",
        "colour": party.get("colour") or "#888888",
        "isIndependent": bool(leader.get("isIndependent")),
        "margin": int(e["margin"]) if e.get("margin") is not None else None,
    }


def parse_flight(page: str) -> tuple[list[dict], str | None]:
    flight = _flight_payload(page)
    if not flight:
        raise ValueError("no Next.js flight payload found")
    dec = json.JSONDecoder()
    best: list = []
    for m in re.finditer(r'"electorates":', flight):
        try:
            arr, _ = dec.raw_decode(flight, m.end())
        except ValueError:
            continue
        if isinstance(arr, list) and len(arr) > len(best):
            best = arr
    if not best:
        raise ValueError("no electorates array in flight payload")
    best = _resolve_refs(best, best)
    updated = re.search(r'"updatedAt":"([^"]+)"', flight)
    return [_norm_from_flight(e) for e in best], (updated.group(1) if updated else None)


# --------------------------------------------------------------------------
# Fallback parser: rendered HTML table ("All electorates")
# --------------------------------------------------------------------------

_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_TAG = re.compile(r"<[^>]+>")


def _text(fragment: str) -> str:
    return htmllib.unescape(_TAG.sub(" ", fragment)).split()


def _rgba_to_hex(style: str) -> str:
    m = re.search(r"rgba?\((\d+),\s*(\d+),\s*(\d+)", style or "")
    if not m:
        return "#888888"
    return "#{:02X}{:02X}{:02X}".format(*(int(x) for x in m.groups()))


def parse_html(page: str) -> tuple[list[dict], str | None]:
    start = page.find("All electorates")
    region = page[start:] if start >= 0 else page
    rows: dict[str, dict] = {}
    for row in _ROW.findall(region):
        link = re.search(r'href="(/news/election-2026-results/electorate/([^"]+))"[^>]*>(.*?)</a>', row, re.S)
        if not link:
            continue
        cells = re.findall(r"<td([^>]*)>(.*?)</td>", row, re.S)
        if len(cells) < 3:
            continue
        name = " ".join(_text(link.group(3)))
        pct = re.search(r"([\d.]+)%\s*counted", " ".join(_text(cells[0][1])))
        status_words = " ".join(_text(cells[1][1]))
        party_m = re.search(r"<span[^>]*>(.*?)</span>", cells[1][1], re.S)
        party = " ".join(_text(party_m.group(1))) if party_m else ""
        cand_m = re.search(r'class="text-xs">(.*?)</div>', cells[1][1], re.S)
        candidate = " ".join(_text(cand_m.group(1))) if cand_m else ""
        margin_txt = "".join(_text(cells[2][1])).replace(",", "")
        rows[link.group(2)] = {
            "id": None,
            "name": name,
            "slug": link.group(2),
            "url": RNZ_BASE + link.group(1),
            "isKey": False,
            "isMaori": False,
            "percentCounted": float(pct.group(1)) if pct else 0.0,
            "status": "counting" if "lead" in status_words else status_words,
            "candidate": candidate,
            "party": party,
            "partyShort": "",
            "colour": _rgba_to_hex(cells[1][0]),
            "isIndependent": party.lower().startswith("independent"),
            "margin": int(margin_txt) if margin_txt.isdigit() else None,
        }
    updated = re.search(r'<time[^>]*dateTime="([^"]+)"', page, re.I)
    return list(rows.values()), (updated.group(1) if updated else None)


# --------------------------------------------------------------------------

def scrape(page: str) -> dict:
    method = "flight"
    try:
        electorates, updated = parse_flight(page)
        if len(electorates) < MIN_ELECTORATES:
            raise ValueError(f"only {len(electorates)} electorates in flight payload")
    except Exception as err:  # noqa: BLE001
        print(f"warning: flight parse failed ({err}); falling back to HTML table", file=sys.stderr)
        method = "html"
        electorates, updated = parse_html(page)

    if len(electorates) < MIN_ELECTORATES:
        raise RuntimeError(f"parsed only {len(electorates)} electorates; refusing to overwrite data")
    for e in electorates:
        if not e["name"] or not (0 <= e["percentCounted"] <= 100):
            raise RuntimeError(f"implausible row: {e!r}")

    electorates.sort(key=lambda e: e["name"].lower())
    return {
        "source": SOURCE_URL,
        "sourceUpdatedAt": updated,
        "parser": method,
        "electorates": electorates,
    }


def _comparable(doc: dict) -> str:
    # Only the results themselves count as a change: RNZ's page timestamp
    # ticks over even when no numbers move, which would otherwise create a
    # commit every cycle and defeat the idle cut-off.
    return json.dumps(doc.get("electorates"), sort_keys=True, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="docs/data/electorates.json")
    ap.add_argument("--html", help="parse a saved HTML file instead of fetching (for testing)")
    args = ap.parse_args()

    try:
        page = open(args.html, encoding="utf-8").read() if args.html else fetch(SOURCE_URL)
        doc = scrape(page)
    except Exception as err:  # noqa: BLE001
        print(f"error: {err}", file=sys.stderr)
        return EXIT_ERROR

    old = None
    if os.path.exists(args.out):
        try:
            old = json.load(open(args.out, encoding="utf-8"))
        except ValueError:
            old = None
    if old is not None and _comparable(old) == _comparable(doc):
        print(f"no change ({len(doc['electorates'])} electorates, RNZ updated {doc['sourceUpdatedAt']})")
        return EXIT_UNCHANGED

    doc["scrapedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(args.out) or ".", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    os.replace(tmp, args.out)
    print(f"updated {args.out}: {len(doc['electorates'])} electorates via {doc['parser']}, "
          f"RNZ updated {doc['sourceUpdatedAt']}")
    return EXIT_CHANGED


if __name__ == "__main__":
    sys.exit(main())
