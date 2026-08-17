"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const contract = require("./index")
const { deadPickPaths, pickAtPath, pickRef, pictureState, queueDeadPickPaths, VENUE_IMAGE_PROVIDERS } = contract

const g = (ref, extra = {}) => ({ source: "google", photoName: `places/P/photos/${ref}/media`, ...extra })
const site = (u = "https://venue.example/hero.jpg") => ({ source: "site", url: u })
const manual = (u = "https://cdn.example/manual.jpg") => ({ source: "manual", url: u })
const wikipedia = (u = "https://upload.wikimedia.org/w/hero.jpg") => ({ source: "wikipedia", url: u })
const mark = (path, ref, reason = "no_fresh_match") => ({ path, photoName: `places/P/photos/${ref}/media`, reason })
const paths = (r) => [...deadPickPaths(r)].sort()
const queued = (r, shown) => [...queueDeadPickPaths(r, shown)].sort()

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
  // Both spellings of the one source resolve identically: the ops console writes `google`, the
  // live document and the wire write `google_places`.
  assert.equal(pickRef({ source: "google_places", photoName: "places/P/photos/A/media" }), "places/P/photos/A/media")
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
  assert.deepEqual(queued({ primary: g("A"), photoNamesUnmatched: [mark("primary", "A")] }, new Set([undefined])), [])
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

test("the export surface is the rule functions plus the provider list", () => {
  assert.deepEqual(Object.keys(contract).sort(), [
    "VENUE_IMAGE_PROVIDERS",
    "deadPickPaths",
    "pickAtPath",
    "pickRef",
    "pictureState",
    "queueDeadPickPaths",
  ])
  for (const fn of [deadPickPaths, pickAtPath, pickRef, pictureState, queueDeadPickPaths]) {
    assert.equal(typeof fn, "function")
  }
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
