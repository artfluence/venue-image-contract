"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const contract = require("./index")
const { deadPickPaths, pickAtPath, pictureState, VENUE_IMAGE_PROVIDERS } = contract

const g = (ref, extra = {}) => ({ source: "google", photoName: `places/P/photos/${ref}/media`, ...extra })
const site = (u = "https://venue.example/hero.jpg") => ({ source: "site", url: u })
const mark = (path, ref, reason = "no_fresh_match") => ({ path, photoName: `places/P/photos/${ref}/media`, reason })
const paths = (r) => [...deadPickPaths(r)].sort()

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

test("the export surface is the three rule functions plus the provider list, unchanged", () => {
  assert.deepEqual(Object.keys(contract).sort(), [
    "VENUE_IMAGE_PROVIDERS",
    "deadPickPaths",
    "pickAtPath",
    "pictureState",
  ])
  for (const fn of [deadPickPaths, pickAtPath, pictureState]) assert.equal(typeof fn, "function")
})
