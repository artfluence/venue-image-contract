"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const contract = require("./index")
const {
  deadPickPaths, deadPickPathsByKind, liveImageRef, pickAtPath, pickRef, pictureState, queueDeadPickPaths,
  VENUE_IMAGE_PROVIDERS, GOOGLE_UNMATCHED_REASONS, GOOGLE_FETCH_ERROR_REASON_PREFIX,
  URL_DEAD_REASONS, URL_DEAD_REASON_PREFIX,
} = contract

const g = (ref, extra = {}) => ({ source: "google", photoName: `places/P/photos/${ref}/media`, ...extra })
const site = (u = "https://venue.example/hero.jpg") => ({ source: "site", url: u })
const manual = (u = "https://cdn.example/manual.jpg") => ({ source: "manual", url: u })
const wikipedia = (u = "https://upload.wikimedia.org/w/hero.jpg") => ({ source: "wikipedia", url: u })
const mark = (path, ref, reason = "no_fresh_match") => ({ path, photoName: `places/P/photos/${ref}/media`, reason })
const urlMark = (path, url, extra = {}) => ({ path, url, reason: "url_gone", ...extra })
const paths = (r) => [...deadPickPaths(r)].sort()
const queued = (r, shown) => [...queueDeadPickPaths(r, shown)].sort()
const kinds = (r) => {
  const k = deadPickPathsByKind(r)
  return { google: [...k.google].sort(), url: [...k.url].sort() }
}

// ————————————————————————— pickAtPath —————————————————————————

test("pickAtPath: resolves primary and gallery.<i> by ARRAY POSITION", () => {
  const r = { primary: g("A"), gallery: [g("B"), g("C")] }
  assert.equal(pickAtPath(r, "primary"), r.primary)
  assert.equal(pickAtPath(r, "gallery.1"), r.gallery[1])
})

test("pickAtPath: `order` is NOT an address — position wins", () => {
  const r = { primary: g("A"), gallery: [g("B", { order: 9 }), g("C", { order: 0 })] }
  assert.equal(pickAtPath(r, "gallery.0").photoName, g("B").photoName)
})

test("pickAtPath: anything that addresses nothing → null", () => {
  const r = { primary: g("A"), gallery: [] }
  for (const p of ["gallery.4", "gallery", "primary.photoName", "", "GALLERY.0", "gallery.-1", "gallery.01x"]) {
    assert.equal(pickAtPath(r, p), null, `expected null for ${JSON.stringify(p)}`)
  }
  assert.equal(pickAtPath(null, "primary"), null)
})

// ————————————————————————— deadPickPaths —————————————————————————

test("deadPickPaths: no marker, or an empty one → nothing dead", () => {
  assert.deepEqual(paths({ primary: g("A"), gallery: [] }), [])
  assert.deepEqual(paths({ primary: g("A"), gallery: [], photoNamesUnmatched: [] }), [])
  assert.deepEqual(paths({ primary: g("A"), photoNamesUnmatched: null }), [])
  assert.deepEqual(paths(null), [])
})

test("deadPickPaths: a marked primary and a marked slide are both dead", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  assert.deepEqual(paths(r), ["gallery.0", "primary"])
})

test("deadPickPaths: THE PIN — a marker whose photoName no longer matches is ignored", () => {
  // The CC does not clear photoNamesUnmatched on a re-pick, so this is what stops a stale marker
  // from suppressing a brand-new image.
  const r = { primary: g("FRESH"), gallery: [], photoNamesUnmatched: [mark("primary", "OLD")] }
  assert.deepEqual(paths(r), [])
})

test("deadPickPaths: a site pick is never dead — it carries a url, not a rotting reference", () => {
  const r = { primary: site(), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(paths(r), [])
})

test("deadPickPaths: malformed entries contribute nothing", () => {
  const r = {
    primary: g("A"),
    gallery: [],
    photoNamesUnmatched: [
      null, {}, { reason: "x" }, { path: "primary" }, { photoName: g("A").photoName },
      { path: "gallery.9", photoName: g("Z").photoName }, { path: 7, photoName: g("A").photoName },
    ],
  }
  assert.deepEqual(paths(r), [])
})

test("deadPickPaths: duplicate markers for one path collapse", () => {
  const r = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A"), mark("primary", "A")] }
  assert.deepEqual(paths(r), ["primary"])
})

// ————————————————————————— pictureState —————————————————————————

test("pictureState: nothing dead → ok", () => {
  const s = pictureState({ primary: g("A"), gallery: [g("B")] })
  assert.equal(s.state, "ok")
  assert.equal(s.primaryDead, false)
  assert.deepEqual(s.dead, [])
})

test("pictureState: dead primary with a survivor → stale (re-pick), NOT none", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A")] }
  const s = pictureState(r)
  assert.equal(s.state, "stale")
  assert.equal(s.primaryDead, true)
  assert.deepEqual(s.survivingGalleryPaths, ["gallery.0"])
})

test("pictureState: dead SLIDE beside a healthy primary → stale, and the primary is untouched", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("gallery.0", "B")] }
  const s = pictureState(r)
  assert.equal(s.state, "stale", "the venue still shows an image — it just lost a slide")
  assert.equal(s.primaryDead, false)
})

test("pictureState: every pick dead → none (sourcing, not a re-pick)", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  const s = pictureState(r)
  assert.equal(s.state, "none")
  assert.deepEqual(s.survivingGalleryPaths, [])
})

test("pictureState: a surviving SITE pick keeps an all-google-dead review out of `none`", () => {
  const r = { primary: g("A"), gallery: [site()], photoNamesUnmatched: [mark("primary", "A")] }
  assert.equal(pictureState(r).state, "stale")
})

test("pictureState: dead primary, no gallery at all → none", () => {
  assert.equal(pictureState({ primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }).state, "none")
})

test("pictureState: the three states are exhaustive and never overlap", () => {
  const cases = [
    { primary: g("A"), gallery: [] },
    { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A")] },
    { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] },
  ]
  assert.deepEqual(cases.map((c) => pictureState(c).state), ["ok", "stale", "none"])
})

// ————————————————————————— pickRef —————————————————————————

test("pickRef: a google pick is addressed by its photoName", () => {
  assert.equal(pickRef(g("A")), "places/P/photos/A/media")
})

test("pickRef: reads the PICK vocabulary — `google_places` is a provider, not a pick source", () => {
  // The two vocabularies never unify. `pickRef` reads picks, so it knows `google`; `liveImageRef`
  // reads live documents, so it knows `google_places`. A pick tagged with the wire spelling is not
  // a google pick, and is not silently treated as one.
  assert.equal(pickRef({ source: "google_places", photoName: "places/P/photos/A/media" }), null)
  assert.equal(liveImageRef({ provider: "google", photoName: "places/P/photos/A/media" }), null)
})

test("pickRef: site / manual / wikipedia picks are addressed by their url", () => {
  assert.equal(pickRef(site()), "https://venue.example/hero.jpg")
  assert.equal(pickRef(manual()), "https://cdn.example/manual.jpg")
  assert.equal(pickRef(wikipedia()), "https://upload.wikimedia.org/w/hero.jpg")
})

test("pickRef: a google pick carrying a url is STILL addressed by photoName", () => {
  assert.equal(pickRef(g("A", { url: "https://proxy.example/thumb.jpg" })), "places/P/photos/A/media")
})

test("pickRef: a pick with no recorded source falls back on whichever reference it carries", () => {
  assert.equal(pickRef({ photoName: "places/P/photos/A/media" }), "places/P/photos/A/media")
  assert.equal(pickRef({ url: "https://venue.example/hero.jpg" }), "https://venue.example/hero.jpg")
})

test("pickRef: a pick with no usable reference → null", () => {
  const nothing = [
    null, undefined, 7, "primary", [], {},
    { source: "google" }, { source: "google", photoName: null }, { source: "google", photoName: "" },
    { source: "site" }, { source: "site", url: "" }, { source: "wikipedia", url: null },
    { source: "google", url: "https://venue.example/hero.jpg" },
  ]
  for (const p of nothing) assert.equal(pickRef(p), null, `expected null for ${JSON.stringify(p)}`)
})

// ————————————————————————— liveImageRef —————————————————————————

const liveG = (ref, extra = {}) => ({ provider: "google_places", photoName: `places/P/photos/${ref}/media`, ...extra })
const liveSite = (u = "https://venue.example/hero.jpg") => ({ provider: "site", url: u })

test("liveImageRef: a google_places entry is addressed by its photoName", () => {
  assert.equal(liveImageRef(liveG("A")), "places/P/photos/A/media")
  assert.equal(liveImageRef(liveG("A", { url: "https://proxy.example/thumb.jpg" })), "places/P/photos/A/media")
})

test("liveImageRef: site / manual / wikipedia entries are addressed by their url", () => {
  assert.equal(liveImageRef(liveSite()), "https://venue.example/hero.jpg")
  assert.equal(liveImageRef({ provider: "manual", url: "https://cdn.example/manual.jpg" }), "https://cdn.example/manual.jpg")
  assert.equal(liveImageRef({ provider: "wikipedia", url: "https://upload.wikimedia.org/w/hero.jpg" }), "https://upload.wikimedia.org/w/hero.jpg")
  // A non-google entry is addressed by its url even when a photoName lingers beside it.
  assert.equal(liveImageRef({ provider: "site", url: "https://venue.example/hero.jpg", photoName: "places/P/photos/A/media" }), "https://venue.example/hero.jpg")
})

test("liveImageRef: an entry with no recorded provider falls back on whichever ref it carries", () => {
  assert.equal(liveImageRef({ photoName: "places/P/photos/A/media" }), "places/P/photos/A/media")
  assert.equal(liveImageRef({ url: "https://venue.example/hero.jpg" }), "https://venue.example/hero.jpg")
})

test("liveImageRef: junk or an entry with no usable ref → null", () => {
  const nothing = [
    null, undefined, 7, "https://venue.example/hero.jpg", [], {},
    { provider: "google_places" }, { provider: "google_places", photoName: "" },
    { provider: "google_places", url: "https://venue.example/hero.jpg" },
    { provider: "site" }, { provider: "site", url: null },
  ]
  for (const img of nothing) assert.equal(liveImageRef(img), null, `expected null for ${JSON.stringify(img)}`)
})

test("liveImageRef mirrors pickRef: the same photo keys identically on both sides", () => {
  // The fold copies photoName and url onto a live entry verbatim, so the pick-side and the
  // live-side rule must produce the same string — that identity is what makes shownRefs sound.
  assert.equal(liveImageRef(liveG("A")), pickRef(g("A")))
  assert.equal(liveImageRef(liveSite()), pickRef(site()))
  const bothSite = { url: "https://venue.example/hero.jpg", photoName: g("A").photoName }
  assert.equal(liveImageRef({ provider: "site", ...bothSite }), pickRef({ source: "site", ...bothSite }))
})

// ————————————————————————— queueDeadPickPaths —————————————————————————

test("queueDeadPickPaths: a venue that is NOT promoted queues every dead path", () => {
  // No live document to compare against → fail OPEN, identical to the unfiltered rule.
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  assert.deepEqual(queued(r, null), ["gallery.0", "primary"])
  assert.deepEqual(queued(r, undefined), ["gallery.0", "primary"])
  assert.deepEqual(queued(r), ["gallery.0", "primary"])
  assert.deepEqual(queued(r, null), paths(r))
})

test("queueDeadPickPaths: PROMOTED and tombstoned — a live venue showing nothing queues nothing", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  assert.deepEqual(paths(r), ["gallery.0", "primary"], "precondition: both picks are dead")
  assert.deepEqual(queued(r, new Set()), [], "a live doc with no image cannot be showing a dead one")
})

test("queueDeadPickPaths: only the dead picks the live venue still SHOWS are queued", () => {
  const r = {
    primary: g("A"),
    gallery: [g("B"), g("C")],
    photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B"), mark("gallery.1", "C")],
  }
  const shown = new Set([g("A").photoName, g("C").photoName])
  assert.deepEqual(queued(r, shown), ["gallery.1", "primary"])
})

test("queueDeadPickPaths: a live venue showing only images this review never picked queues nothing", () => {
  const r = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(queued(r, new Set(["places/P/photos/SOMETHING-ELSE/media"])), [])
})

test("queueDeadPickPaths: a non-google dead pick is matched by URL, not by photoName", () => {
  // The forward note: "dead" broadens past google. A non-google pick that still carries a marked
  // photoName is addressed in the live document by its url, so that is what must match.
  const hybrid = { source: "site", url: "https://venue.example/hero.jpg", photoName: g("A").photoName }
  const r = { primary: hybrid, gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(paths(r), ["primary"], "precondition: the pick is dead")
  assert.deepEqual(queued(r, new Set(["https://venue.example/hero.jpg"])), ["primary"])
  assert.deepEqual(queued(r, new Set([g("A").photoName])), [], "photoName is not how the live doc addresses it")
})

test("queueDeadPickPaths: it only ever narrows — never a path the unfiltered rule did not return", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A")] }
  const shown = new Set([g("A").photoName, g("B").photoName])
  assert.deepEqual(queued(r, shown), ["primary"], "gallery.0 is shown but not dead — still not queued")
})

test("queueDeadPickPaths: malformed reviews, picks and markers are tolerated", () => {
  assert.deepEqual(queued(null, new Set(["x"])), [])
  assert.deepEqual(queued({}, new Set()), [])
  assert.deepEqual(queued({ primary: 7, gallery: "nope", photoNamesUnmatched: [null, {}] }, new Set()), [])
  // A dead pick with no usable reference cannot be shown by anything, so it cannot be matched.
  const unaddressable = { source: "site", photoName: g("A").photoName }
  const r = { primary: unaddressable, gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(paths(r), ["primary"], "precondition: it is dead")
  assert.deepEqual(queued(r, new Set([g("A").photoName])), [])
  assert.deepEqual(queued(r, null), ["primary"], "and it is still queued when there is no live doc")
})

test("queueDeadPickPaths: a shownRefs that is not a set of refs is read as NOT promoted", () => {
  // Fail open in both directions: an array of refs is honoured, junk queues everything rather
  // than silently suppressing a live venue's re-review.
  const r = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(queued(r, [g("A").photoName]), ["primary"], "an array of refs is honoured")
  assert.deepEqual(queued(r, []), [], "an empty array is still a promoted venue showing nothing")
  for (const junk of [7, true, "places/P/photos/A/media", {}]) {
    assert.deepEqual(queued(r, junk), ["primary"], `expected fail-open for ${JSON.stringify(junk)}`)
  }
})

test("queueDeadPickPaths: an iterable that does not yield REFS is junk, and fails open", () => {
  // The whole failure this guards: a caller who reaches for the wrong container hands over
  // something iterable that yields anything but refs. Reading that as "shows nothing" would wipe
  // the venue's entire queue in silence — the exact outcome suppression must never reach by
  // accident. Only positive evidence of what is shown may suppress.
  const r = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  const ref = g("A").photoName
  const junkIterables = [
    new Map([[ref, ref]]), // yields [k, v] pairs, never a ref
    [{ provider: "google_places", photoName: ref }], // live image entries, not keyed
    [ref, 7], // mixed
    [ref, null],
    [ref, ""], // an empty string is not a reference
    [["a"], ["b"]],
  ]
  for (const junk of junkIterables) {
    assert.deepEqual(queued(r, junk), ["primary"], `expected fail-open for ${JSON.stringify([...junk])}`)
  }
  assert.deepEqual(queued(r, new Set([ref, 7])), ["primary"], "a Set is content-checked too")
  assert.deepEqual(queued(r, new Set([undefined])), ["primary"], "a Set of junk is not an empty set")
})

test("queueDeadPickPaths: any iterable of refs is honoured — Set, array, map keys, generator", () => {
  const r = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  const ref = g("A").photoName
  const gen = function* () {
    yield ref
  }
  for (const shown of [new Set([ref]), [ref], new Map([[ref, {}]]).keys(), gen()]) {
    assert.deepEqual(queued(r, shown), ["primary"])
  }
  for (const empty of [new Set(), [], new Map().keys()]) {
    assert.deepEqual(queued(r, empty), [], "an empty iterable is a promoted venue showing nothing")
  }
})

test("queueDeadPickPaths: the caller's set is never mutated, and neither is the review", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A")] }
  const before = JSON.stringify(r)
  const shown = new Set([g("A").photoName])
  queueDeadPickPaths(r, shown)
  assert.deepEqual([...shown], [g("A").photoName])
  assert.equal(JSON.stringify(r), before)
})

test("queueDeadPickPaths: returns a Set, and a fresh one each call", () => {
  const r = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  const a = queueDeadPickPaths(r, null)
  const b = queueDeadPickPaths(r, null)
  assert.ok(a instanceof Set)
  assert.notEqual(a, b)
  assert.notEqual(a, deadPickPaths(r))
})

// ————————————————————————— VENUE_IMAGE_PROVIDERS —————————————————————————

test("VENUE_IMAGE_PROVIDERS: exactly these four, in this order", () => {
  // Order is part of the contract: consumers echo the list in enums and validation messages.
  assert.deepEqual(VENUE_IMAGE_PROVIDERS, ["google_places", "site", "manual", "wikipedia"])
})

test("VENUE_IMAGE_PROVIDERS: the ops-console SOURCE spelling `google` is NOT a provider", () => {
  // The console picker says "google"; the wire says "google_places". Consumers must map, not assume.
  assert.ok(!VENUE_IMAGE_PROVIDERS.includes("google"))
  assert.ok(VENUE_IMAGE_PROVIDERS.includes("google_places"))
})

test("VENUE_IMAGE_PROVIDERS: frozen — a consumer cannot mutate the shared list", () => {
  assert.equal(Object.isFrozen(VENUE_IMAGE_PROVIDERS), true)
  assert.throws(() => VENUE_IMAGE_PROVIDERS.push("stray"), TypeError)
  assert.throws(() => (VENUE_IMAGE_PROVIDERS[0] = "stray"), TypeError)
  assert.deepEqual(VENUE_IMAGE_PROVIDERS, ["google_places", "site", "manual", "wikipedia"])
})

// ————————————————————————— the export surface —————————————————————————

test("the export surface is the rule functions, the provider list and the reason vocabularies", () => {
  assert.deepEqual(Object.keys(contract).sort(), [
    "GOOGLE_FETCH_ERROR_REASON_PREFIX",
    "GOOGLE_UNMATCHED_REASONS",
    "URL_DEAD_REASONS",
    "URL_DEAD_REASON_PREFIX",
    "VENUE_IMAGE_PROVIDERS",
    "deadPickPaths",
    "deadPickPathsByKind",
    "liveImageRef",
    "pickAtPath",
    "pickRef",
    "pictureState",
    "queueDeadPickPaths",
  ])
  const fns = [deadPickPaths, deadPickPathsByKind, liveImageRef, pickAtPath, pickRef, pictureState, queueDeadPickPaths]
  for (const fn of fns) assert.equal(typeof fn, "function")
})

test("the v1.2.0 export surface survives the bump — every old export is still there, same kind", () => {
  // An additive version must never move a consumer's cheese: the seven exports pinned at v1.2.0
  // keep their names and their kinds, and the four the fold calls keep answering the same.
  for (const name of ["deadPickPaths", "liveImageRef", "pickAtPath", "pickRef", "pictureState", "queueDeadPickPaths"]) {
    assert.equal(typeof contract[name], "function", `${name} must still be a function`)
  }
  assert.deepEqual(contract.VENUE_IMAGE_PROVIDERS, ["google_places", "site", "manual", "wikipedia"])
})

test("the queue filter does NOT reach the fold: pictureState answers the same as before", () => {
  // The suppression is a QUEUE predicate. Feeding it back into the fold would make the fold's
  // input depend on its own output, and a promoted venue would re-serve the dead reference.
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  const s = pictureState(r)
  queueDeadPickPaths(r, new Set())
  assert.deepEqual(pictureState(r), s)
  assert.equal(s.state, "none", "a tombstoned venue still folds to `none`, whatever the queue suppresses")
  assert.deepEqual(s.dead.sort(), ["gallery.0", "primary"])
})

// ————————————————————————— urlPicksUnmatched: the url-dead branch —————————————————————————

const SITE_URL = "https://venue.example/hero.jpg"
const MANUAL_URL = "https://cdn.example/manual.jpg"
const WIKI_URL = "https://upload.wikimedia.org/w/hero.jpg"

test("deadPickPaths: a url-marked site pick is dead while it still carries the marked url", () => {
  const r = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(paths(r), ["primary"])
})

test("deadPickPaths: manual and wikipedia picks go dead by url the same way", () => {
  const r = {
    primary: manual(),
    gallery: [wikipedia()],
    urlPicksUnmatched: [urlMark("primary", MANUAL_URL), urlMark("gallery.0", WIKI_URL)],
  }
  assert.deepEqual(paths(r), ["gallery.0", "primary"])
})

test("deadPickPaths: THE PIN, url side — a re-picked pick stops matching its own marker", () => {
  // Same doctrine as photoNamesUnmatched: nothing clears the marker when an operator re-picks in
  // the grid, so the entry pins the url it died on and self-invalidates the moment the pick moves.
  const r = { primary: site("https://venue.example/NEW.jpg"), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(paths(r), [], "a healed pick is not dead, marker or no marker")
})

test("deadPickPaths: a url marker does not match a google pick carrying that url BESIDE its photoName", () => {
  // pickRef on a google pick is its photoName, so a marker naming the url next to it cannot pin it.
  const withUrl = g("A", { url: SITE_URL })
  const r = { primary: withUrl, gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(paths(r), [], "the url beside a google pick is a rendering, not its identity")
})

test("deadPickPaths: a photoName SMUGGLED into the url field cannot pin a google pick", () => {
  // The hole the shape gate closes. `pickRef` of a google pick IS its photoName, so a marker that
  // puts that photoName in its `url` compares equal and would kill a perfectly healthy google pick —
  // and file it under `url`, where triage offers no repick proposal. The pin only accepts a
  // protocol-shaped url, which a photoName is not.
  const r = { primary: g("A"), gallery: [], urlPicksUnmatched: [urlMark("primary", g("A").photoName)] }
  assert.deepEqual(paths(r), [], "a photoName is not a url, whatever field it is written in")
  assert.deepEqual(kinds(r), { google: [], url: [] })
})

test("deadPickPaths: the url pin accepts only http(s) — anything else is not a url and never pins", () => {
  // Fail-SAFE by design: an unrecognised shape leaves the pick alive. A marker is a claim that a
  // fetchable asset is gone, and only an http(s) url is a fetchable asset here.
  const notUrls = [
    g("A").photoName, // a google reference
    "places/P/photos/A/media",
    "//cdn.example/hero.jpg", // protocol-relative
    "venue.example/hero.jpg", // no scheme
    "ftp://venue.example/hero.jpg",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "https:/venue.example/hero.jpg", // one slash short
    " https://venue.example/hero.jpg", // leading space
  ]
  for (const ref of notUrls) {
    // The pick carries EXACTLY the marked string, so only the shape gate can be what saves it.
    const r = { primary: { source: "site", url: ref }, gallery: [], urlPicksUnmatched: [urlMark("primary", ref)] }
    assert.deepEqual(paths(r), [], `expected no pin for ${JSON.stringify(ref)}`)
  }
  for (const ref of ["http://venue.example/hero.jpg", "https://venue.example/hero.jpg"]) {
    const r = { primary: { source: "site", url: ref }, gallery: [], urlPicksUnmatched: [urlMark("primary", ref)] }
    assert.deepEqual(paths(r), ["primary"], `expected a pin for ${JSON.stringify(ref)}`)
  }
})

test("deadPickPaths: a pick with no recorded source is matched on whichever ref it carries", () => {
  const r = { primary: { url: SITE_URL }, gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(paths(r), ["primary"])
})

test("deadPickPaths: `source` on a url entry is a triage hint, not part of the match", () => {
  // The match rule is pickRef(pickAtPath(review, path)) === entry.url, and nothing else. A wrong,
  // missing or stale source tag must not resurrect a dead pick, nor kill a live one.
  const r = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL, { source: "manual" })] }
  assert.deepEqual(paths(r), ["primary"], "a disagreeing source tag does not unmatch")
  const noSource = { primary: site(), gallery: [], urlPicksUnmatched: [{ path: "primary", url: SITE_URL }] }
  assert.deepEqual(paths(noSource), ["primary"], "no source tag, no reason — still matched on the url")
})

test("deadPickPaths: an unrecognised reason still marks dead — the vocabulary is documentation", () => {
  const r = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL, { reason: "totally_made_up" })] }
  assert.deepEqual(paths(r), ["primary"])
})

test("deadPickPaths: no url marker, or an empty one → nothing dead", () => {
  assert.deepEqual(paths({ primary: site(), gallery: [] }), [])
  assert.deepEqual(paths({ primary: site(), gallery: [], urlPicksUnmatched: [] }), [])
  assert.deepEqual(paths({ primary: site(), urlPicksUnmatched: null }), [])
  assert.deepEqual(paths({ primary: site(), urlPicksUnmatched: "nope" }), [])
})

test("deadPickPaths: malformed url entries contribute nothing", () => {
  const r = {
    primary: site(),
    gallery: [],
    urlPicksUnmatched: [
      null, undefined, 7, {}, { reason: "url_gone" },
      { path: "primary" }, // url is REQUIRED
      { path: "primary", url: "" }, // and non-empty
      { path: "primary", url: null },
      { path: "primary", url: 7 },
      { url: SITE_URL }, // no path
      { path: 7, url: SITE_URL },
      { path: "gallery.9", url: SITE_URL }, // addresses nothing
      { path: "GALLERY.0", url: SITE_URL },
    ],
  }
  assert.deepEqual(paths(r), [])
})

test("deadPickPaths: duplicate url markers for one path collapse", () => {
  const r = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL), urlMark("primary", SITE_URL)] }
  assert.deepEqual(paths(r), ["primary"])
})

test("deadPickPaths: a dead pick with no usable ref cannot be url-matched", () => {
  const r = { primary: { source: "site" }, gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(paths(r), [], "pickRef is null, and null is never a url")
})

// ————————————————————————— the union —————————————————————————

test("deadPickPaths: the two markers UNION — google-dead and url-dead both count", () => {
  const r = {
    primary: g("A"),
    gallery: [site()],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("gallery.0", SITE_URL)],
  }
  assert.deepEqual(paths(r), ["gallery.0", "primary"])
})

test("deadPickPaths: a path dead BOTH ways appears once", () => {
  // A hybrid pick carries a photoName the renewal marked AND a url the liveness detector marked.
  const hybrid = { source: "site", url: SITE_URL, photoName: g("A").photoName }
  const r = {
    primary: hybrid,
    gallery: [],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("primary", SITE_URL)],
  }
  assert.deepEqual(paths(r), ["primary"])
  assert.equal(deadPickPaths(r).size, 1)
})

test("deadPickPaths: the two marker fields are INDEPENDENT — neither replaces the other", () => {
  // renew-photo-names rewrites photoNamesUnmatched wholesale; it never sees urlPicksUnmatched.
  // Wiping one field must leave the other's verdict untouched.
  const both = {
    primary: g("A"),
    gallery: [site()],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("gallery.0", SITE_URL)],
  }
  assert.deepEqual(paths({ ...both, photoNamesUnmatched: [] }), ["gallery.0"], "url marks survive a renewal wipe")
  assert.deepEqual(paths({ ...both, urlPicksUnmatched: [] }), ["primary"], "google marks survive a detector wipe")
})

// ————————————————————————— the google branch is byte-unchanged —————————————————————————

const GOOGLE_ONLY_PINS = [
  { name: "no marker", review: { primary: g("A"), gallery: [g("B")] }, dead: [] },
  { name: "empty marker", review: { primary: g("A"), gallery: [], photoNamesUnmatched: [] }, dead: [] },
  {
    name: "marked primary + marked slide",
    review: { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] },
    dead: ["gallery.0", "primary"],
  },
  {
    name: "the pin: re-picked primary",
    review: { primary: g("FRESH"), gallery: [], photoNamesUnmatched: [mark("primary", "OLD")] },
    dead: [],
  },
  {
    name: "a site pick carrying a marked photoName is still google-dead",
    review: { primary: { source: "site", url: SITE_URL, photoName: g("A").photoName }, gallery: [], photoNamesUnmatched: [mark("primary", "A")] },
    dead: ["primary"],
  },
  {
    name: "dead slide beside a healthy primary",
    review: { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("gallery.0", "B")] },
    dead: ["gallery.0"],
  },
]

test("deadPickPaths: a document with NO urlPicksUnmatched answers exactly as v1.2.0 did", () => {
  // The whole additive claim in one assertion: the google half is untouched, verdict for verdict.
  for (const pin of GOOGLE_ONLY_PINS) {
    assert.deepEqual(paths(pin.review), pin.dead, `google pin drifted: ${pin.name}`)
  }
})

test("deadPickPaths: insertion ORDER of a google-only verdict is unchanged", () => {
  // pictureState hands `dead` out as an array, so the Set's order is observable to consumers.
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("gallery.0", "B"), mark("primary", "A")] }
  assert.deepEqual([...deadPickPaths(r)], ["gallery.0", "primary"], "marker order, not path order")
  assert.deepEqual(pictureState(r).dead, ["gallery.0", "primary"])
})

test("deadPickPaths: on a MIXED document the google marks come first, url marks after", () => {
  // Order is observable — pictureState hands `dead` out as an array — so the union's composition is
  // part of the contract, not an implementation detail. Google first is what keeps a google-only
  // document's order identical to v1.2.0; a document carrying both inherits that same ordering.
  // Composing the other way round (url first) makes this test fail, which is the point of pinning it.
  const r = {
    primary: site(),
    gallery: [g("B")],
    photoNamesUnmatched: [mark("gallery.0", "B")],
    urlPicksUnmatched: [urlMark("primary", SITE_URL)],
  }
  assert.deepEqual([...deadPickPaths(r)], ["gallery.0", "primary"], "google mark first, url mark second")
  assert.deepEqual(pictureState(r).dead, ["gallery.0", "primary"])
})

test("pictureState: a google-only document is byte-identical to the v1.2.0 answer", () => {
  const r = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(pictureState(r), {
    state: "stale",
    dead: ["primary"],
    survivingGalleryPaths: ["gallery.0"],
    primaryDead: true,
  })
  const allDead = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  assert.deepEqual(pictureState(allDead), {
    state: "none",
    dead: ["primary", "gallery.0"],
    survivingGalleryPaths: [],
    primaryDead: true,
  })
})

// ————————————————————————— deadPickPathsByKind —————————————————————————

test("deadPickPathsByKind: two Sets, and their union is deadPickPaths", () => {
  const r = {
    primary: g("A"),
    gallery: [site()],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("gallery.0", SITE_URL)],
  }
  const k = deadPickPathsByKind(r)
  assert.ok(k.google instanceof Set)
  assert.ok(k.url instanceof Set)
  assert.deepEqual(kinds(r), { google: ["primary"], url: ["gallery.0"] })
  assert.deepEqual([...new Set([...k.google, ...k.url])].sort(), paths(r))
})

test("deadPickPathsByKind: the split is exactly two keys", () => {
  assert.deepEqual(Object.keys(deadPickPathsByKind({})).sort(), ["google", "url"])
})

test("deadPickPathsByKind: a google-only review leaves the url set empty, and the other way round", () => {
  const googleOnly = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(kinds(googleOnly), { google: ["primary"], url: [] })
  const urlOnly = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(kinds(urlOnly), { google: [], url: ["primary"] })
})

test("deadPickPathsByKind: a path dead BOTH ways lands in BOTH sets", () => {
  // Triage routing depends on this: google-dead can be answered with a repick proposal, url-dead
  // only with a grid re-pick, and a path that is both must appear to both consumers.
  const hybrid = { source: "site", url: SITE_URL, photoName: g("A").photoName }
  const r = {
    primary: hybrid,
    gallery: [],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("primary", SITE_URL)],
  }
  assert.deepEqual(kinds(r), { google: ["primary"], url: ["primary"] })
  assert.deepEqual(paths(r), ["primary"], "and the union still counts it once")
})

test("deadPickPathsByKind: junk reviews answer with two empty sets", () => {
  for (const junk of [null, undefined, {}, { primary: 7, gallery: "nope" }, 7]) {
    assert.deepEqual(kinds(junk), { google: [], url: [] }, `expected empty split for ${JSON.stringify(junk)}`)
  }
})

test("deadPickPathsByKind: fresh sets each call, and the review is not mutated", () => {
  const r = {
    primary: g("A"),
    gallery: [site()],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("gallery.0", SITE_URL)],
  }
  const before = JSON.stringify(r)
  const a = deadPickPathsByKind(r)
  const b = deadPickPathsByKind(r)
  assert.notEqual(a.google, b.google)
  assert.notEqual(a.url, b.url)
  assert.notEqual(a.google, deadPickPaths(r))
  a.google.add("stray")
  assert.deepEqual(paths(r), ["gallery.0", "primary"], "mutating the caller's copy cannot poison the rule")
  assert.equal(JSON.stringify(r), before)
})

// ————————————————————————— url-dead inherits pictureState —————————————————————————

test("pictureState: a url-dead primary with a survivor → stale, exactly like a google-dead one", () => {
  const urlDead = { primary: site(), gallery: [manual()], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  const googleDead = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A")] }
  assert.deepEqual(pictureState(urlDead), pictureState(googleDead))
  assert.equal(pictureState(urlDead).state, "stale")
  assert.equal(pictureState(urlDead).primaryDead, true)
})

test("pictureState: every pick url-dead → none, exactly like a google-dead one", () => {
  const urlDead = {
    primary: site(),
    gallery: [manual()],
    urlPicksUnmatched: [urlMark("primary", SITE_URL), urlMark("gallery.0", MANUAL_URL)],
  }
  const googleDead = { primary: g("A"), gallery: [g("B")], photoNamesUnmatched: [mark("primary", "A"), mark("gallery.0", "B")] }
  assert.deepEqual(pictureState(urlDead), pictureState(googleDead))
  assert.equal(pictureState(urlDead).state, "none")
})

test("pictureState: a url-dead SLIDE beside a healthy primary → stale, primary untouched", () => {
  const r = { primary: site(), gallery: [manual()], urlPicksUnmatched: [urlMark("gallery.0", MANUAL_URL)] }
  const s = pictureState(r)
  assert.equal(s.state, "stale")
  assert.equal(s.primaryDead, false)
  assert.deepEqual(s.survivingGalleryPaths, [])
})

test("pictureState: mixed google-dead primary and url-dead slide → none", () => {
  const r = {
    primary: g("A"),
    gallery: [site()],
    photoNamesUnmatched: [mark("primary", "A")],
    urlPicksUnmatched: [urlMark("gallery.0", SITE_URL)],
  }
  const s = pictureState(r)
  assert.equal(s.state, "none")
  assert.deepEqual(s.dead.sort(), ["gallery.0", "primary"])
  assert.deepEqual(s.survivingGalleryPaths, [])
})

test("pictureState: a surviving google pick keeps an all-url-dead review out of `none`", () => {
  const r = { primary: site(), gallery: [g("B")], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.equal(pictureState(r).state, "stale")
})

// ————————————————————————— url-dead inherits queueDeadPickPaths —————————————————————————

test("queueDeadPickPaths: a url-dead path is queued only when the live venue shows that url", () => {
  const r = {
    primary: site(),
    gallery: [manual()],
    urlPicksUnmatched: [urlMark("primary", SITE_URL), urlMark("gallery.0", MANUAL_URL)],
  }
  assert.deepEqual(queued(r, new Set([SITE_URL])), ["primary"])
  assert.deepEqual(queued(r, new Set([MANUAL_URL])), ["gallery.0"])
  assert.deepEqual(queued(r, new Set([SITE_URL, MANUAL_URL])), ["gallery.0", "primary"])
})

test("queueDeadPickPaths: url-dead fails open when there is no live document, and suppresses on a tombstone", () => {
  const r = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  assert.deepEqual(queued(r, null), ["primary"], "not promoted → queue it")
  assert.deepEqual(queued(r, new Set()), [], "promoted, showing nothing → nothing to repair")
})

test("queueDeadPickPaths: a live doc keyed with liveImageRef matches a url-dead pick", () => {
  // The whole point of one keying rule per side: the detector marks the pick's url, and the live
  // document's `site` entry is addressed by the same string.
  const r = { primary: site(), gallery: [], urlPicksUnmatched: [urlMark("primary", SITE_URL)] }
  const shown = new Set([{ provider: "site", url: SITE_URL }].map(liveImageRef).filter(Boolean))
  assert.deepEqual(queued(r, shown), ["primary"])
})

// ————————————————————————— the reason vocabularies —————————————————————————

test("GOOGLE_UNMATCHED_REASONS: the reasons renew-photo-names mints, in this order", () => {
  assert.deepEqual(GOOGLE_UNMATCHED_REASONS, [
    "ambiguous_old",
    "ambiguous_fresh",
    "no_fresh_match",
    "no_fingerprint",
    "divergent_duplicates",
    "invalid_fresh_target",
  ])
})

test("GOOGLE_UNMATCHED_REASONS: the list is NOT exhaustive — `fetch_error:` carries a suffix", () => {
  // A consumer switching on the list alone drops every transport failure on the floor, so the
  // prefix is part of the vocabulary and is exported beside it.
  assert.equal(GOOGLE_FETCH_ERROR_REASON_PREFIX, "fetch_error:")
  assert.ok(!GOOGLE_UNMATCHED_REASONS.some((r) => r.startsWith(GOOGLE_FETCH_ERROR_REASON_PREFIX)))
  assert.ok("fetch_error:ETIMEDOUT".startsWith(GOOGLE_FETCH_ERROR_REASON_PREFIX))
})

test("URL_DEAD_REASONS: the reasons the url-liveness detector mints, in this order", () => {
  assert.deepEqual(URL_DEAD_REASONS, ["url_gone", "url_moved", "url_host_dead", "url_forbidden"])
})

test("URL_DEAD_REASONS: every url reason carries the url_ prefix, and no google reason does", () => {
  assert.equal(URL_DEAD_REASON_PREFIX, "url_")
  for (const reason of URL_DEAD_REASONS) assert.ok(reason.startsWith(URL_DEAD_REASON_PREFIX), reason)
  for (const reason of GOOGLE_UNMATCHED_REASONS) assert.ok(!reason.startsWith(URL_DEAD_REASON_PREFIX), reason)
  assert.equal(GOOGLE_UNMATCHED_REASONS.filter((r) => URL_DEAD_REASONS.includes(r)).length, 0)
})

test("URL_DEAD_REASONS: no open-ended transport member — an INCONCLUSIVE probe is not a death", () => {
  // The asymmetry with the google side is deliberate and worth pinning. A google `fetch_error:` is a
  // renewal that could not be completed — a real outcome. A url probe that could not be completed is
  // no outcome at all, and writing it as a mark would pull a live image off a venue because a CDN
  // had a bad minute. Inconclusive results stay in the detector's suspect machinery until they
  // harden into one of these four verdicts.
  for (const reason of URL_DEAD_REASONS) {
    assert.ok(!reason.includes(":"), `${reason} must be a closed verdict, not an open-ended prefix`)
  }
  assert.ok(!URL_DEAD_REASONS.some((r) => r.startsWith("url_fetch_error")))
  assert.ok(!URL_DEAD_REASONS.some((r) => r.includes("timeout") || r.includes("unreachable")))
  assert.equal(URL_DEAD_REASONS.length, 4, "four verdicts — adding a fifth is a doctrine decision")
})

test("the reason vocabularies are frozen — a consumer cannot mutate a shared list", () => {
  for (const list of [GOOGLE_UNMATCHED_REASONS, URL_DEAD_REASONS]) {
    assert.equal(Object.isFrozen(list), true)
    assert.throws(() => list.push("stray"), TypeError)
    assert.throws(() => (list[0] = "stray"), TypeError)
  }
  assert.deepEqual(URL_DEAD_REASONS, ["url_gone", "url_moved", "url_host_dead", "url_forbidden"])
})

test("the reason vocabularies are DOCUMENTATION — the rule never validates a reason", () => {
  // No validation logic ships here on purpose: a marker with an unknown, empty or missing reason
  // still counts, on both sides. The vocabulary tells a triage UI what to say, nothing more.
  const google = { primary: g("A"), gallery: [], photoNamesUnmatched: [mark("primary", "A", "brand_new_reason")] }
  assert.deepEqual(paths(google), ["primary"])
  const url = { primary: site(), gallery: [], urlPicksUnmatched: [{ path: "primary", url: SITE_URL, reason: "" }] }
  assert.deepEqual(paths(url), ["primary"])
})
