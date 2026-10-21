// Stop-and-retarget handling for arrow draw-in/draw-out fragment animations.
//
// The CSS emitted by arrows.lua gives each arrow a `.fragment.visible .X-path`
// keyframe animation that draws the path via `stroke-dashoffset`, plus a
// `.X-marker` fade-in. There is no CSS-only reverse (undraw) animation, and
// removing `visible` mid-draw snaps the path to fully-hidden instead of
// continuing smoothly, because the `.fragment.visible ...` rule (and the
// CSSAnimation it drives) stops matching synchronously, before any JS
// listener gets a chance to read the live interpolated value.
//
// So the live value is sampled continuously (once per frame, like a
// hand-rolled tween) while a draw animation is running, and that last good
// sample - not a read taken after the class flip - is what every retarget
// starts from.
(function () {
  if (window.__quartoArrowsFragmentFix) return;
  window.__quartoArrowsFragmentFix = true;

  var liveSamples = new WeakMap(); // el -> { dashoffset, opacity, t }
  var watched = new Set();
  var rafId = null;

  // Any running Animation on these elements - CSSAnimation (the draw/fade
  // keyframes) or CSSTransition (our own JS-driven retarget) - counts as
  // "live". Unlike reveal.js's own default `.fragment{transition:...}`, which
  // lives on the wrapping `.fragment` span, nothing else ever animates these
  // inner `path` elements, so there is no default-fade false positive to
  // filter out here.
  function isLive(el) {
    if (!el) return false;
    return el.getAnimations().some(function (a) {
      return a.playState === "running" || a.playState === "paused";
    });
  }

  function sample(el, prop) {
    var cs = getComputedStyle(el);
    return prop === "opacity" ? parseFloat(cs.opacity) : parseFloat(cs.strokeDashoffset);
  }

  function tick() {
    watched.forEach(function (entry) {
      var el = entry.el;
      if (isLive(el)) {
        liveSamples.set(el, { value: sample(el, entry.prop), t: performance.now() });
      } else {
        watched.delete(entry);
      }
    });
    rafId = watched.size ? requestAnimationFrame(tick) : null;
  }

  function watch(el, prop) {
    if (!el) return;
    for (var entry of watched) {
      if (entry.el === el) return;
    }
    watched.add({ el: el, prop: prop });
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function lastLiveValue(el, maxAgeMs) {
    var entry = liveSamples.get(el);
    if (!entry) return null;
    if (performance.now() - entry.t > maxAgeMs) return null;
    return entry.value;
  }

  function cancelKeyframe(el) {
    el.getAnimations().forEach(function (a) {
      if (a.animationName) a.cancel();
    });
  }

  // `transition-property` wants the CSS (hyphenated) name, not the JS/CSSOM
  // camelCase accessor - `el.style.transition = "strokeDashoffset 1s ease"` is
  // silently treated as an unrecognized custom-ident and produces no
  // transition at all (confirmed empirically: getAnimations() stayed empty
  // and the property snapped instantly, with no error).
  var cssPropName = { opacity: "opacity", strokeDashoffset: "stroke-dashoffset" };

  function retarget(el, prop, from, to, durationS) {
    if (!el) return;
    cancelKeyframe(el);
    var cssProp = cssPropName[prop];
    el.style.transition = "none";
    if (prop === "opacity") {
      el.style.opacity = from;
    } else {
      el.style.strokeDashoffset = from;
    }
    void el.getBoundingClientRect(); // force reflow so the frozen "from" value commits
    el.style.transition = cssProp + " " + durationS + "s ease";
    if (prop === "opacity") {
      el.style.opacity = to;
    } else {
      el.style.strokeDashoffset = to;
    }
    // Seed the sample immediately: deferring this value change to the next
    // requestAnimationFrame (as an earlier version of this function did)
    // leaves a one-frame gap where a transition is declared but nothing has
    // started yet, so getAnimations() reports nothing running. If the
    // sampling loop's own tick() happens to run during that exact gap, it
    // sees "not live", stops sampling, and silently never restarts - a real,
    // observed bug (a second interrupt redirected from a stale/missing
    // sample instead of the true live value). Setting `to` synchronously,
    // right after the forced reflow, starts the transition in the same tick
    // instead, closing that gap.
    liveSamples.set(el, { value: parseFloat(from), t: performance.now() });
    el.addEventListener("transitionend", function handler(e) {
      if (e.propertyName !== cssProp) return;
      // Only clear `transition` itself (so a later, unrelated style write
      // doesn't unexpectedly animate). Do NOT blank the opacity/dashoffset
      // value back to "" here: with the real keyframe animation cancelled,
      // the base (non-animated) stylesheet rule is the *hidden* rest state
      // regardless of which direction just finished, so clearing the inline
      // override after a forward retarget snapped the fully-drawn arrow
      // straight back to invisible - a real, confirmed regression. The
      // inline value must stay pinned at `to` for however long this
      // CSS-driven retarget scheme is in control of the element.
      el.style.transition = "";
      el.removeEventListener("transitionend", handler);
    });
  }

  function parts(fragment) {
    return {
      path: fragment.querySelector('path[class*="-path"]'),
      marker: fragment.querySelector('path[class*="-marker"]'),
    };
  }

  function dashMax(path) {
    var d = parseFloat(getComputedStyle(path).strokeDasharray);
    return isNaN(d) ? 2000 : d;
  }

  // Under reduced motion, arrows.lua's own CSS keeps the path fully drawn and
  // the marker permanently opaque via plain (non-`.visible`-scoped) class
  // rules. Retargeting here would apply an inline opacity/dashoffset that
  // outranks those rules and forces a fade in/out the user asked to avoid -
  // so skip the whole mechanism and leave that CSS in control.
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function handle(fragment, showing) {
    if (reduceMotion) return;
    if (!fragment.classList || !fragment.classList.contains("custom")) return;
    var found = parts(fragment);
    var path = found.path;
    var marker = found.marker;
    if (!path) return;

    var duration = parseFloat(fragment.dataset.arrowFragmentDuration || "0.5");
    var markerDuration = Math.min(duration, 0.15);
    var dash = dashMax(path);

    var wasShown = fragment.dataset.arrowState === "shown";

    if (showing) {
      var livePath = lastLiveValue(path, 100);
      var liveMarker = lastLiveValue(marker, 100);
      if (livePath === null && liveMarker === null) {
        // Fresh start from fully hidden: let the CSS keyframe fast path run.
        fragment.dataset.arrowState = "shown";
        watch(path, "strokeDashoffset");
        watch(marker, "opacity");
        return;
      }
      retarget(path, "strokeDashoffset", livePath === null ? dash : livePath, 0, duration);
      retarget(marker, "opacity", liveMarker === null ? 0 : liveMarker, 1, markerDuration);
      fragment.dataset.arrowState = "shown";
      watch(path, "strokeDashoffset");
      watch(marker, "opacity");
    } else {
      if (!wasShown) return; // never shown (or already hidden): nothing to undo
      var livePath2 = lastLiveValue(path, 100);
      var liveMarker2 = lastLiveValue(marker, 100);
      retarget(path, "strokeDashoffset", livePath2 === null ? 0 : livePath2, dash, duration);
      retarget(marker, "opacity", liveMarker2 === null ? 1 : liveMarker2, 0, markerDuration);
      fragment.dataset.arrowState = "hidden";
      watch(path, "strokeDashoffset");
      watch(marker, "opacity");
    }
  }

  function wire(deck) {
    deck.on("fragmentshown", function (e) {
      handle(e.fragment, true);
    });
    deck.on("fragmenthidden", function (e) {
      handle(e.fragment, false);
    });
  }

  // This script loads in <head>, well before reveal.js itself is loaded and
  // `Reveal.initialize()` runs, so `window.Reveal` does not exist yet - poll
  // for it rather than assuming it is already there.
  function waitForReveal() {
    if (window.Reveal) {
      if (window.Reveal.isReady && window.Reveal.isReady()) {
        wire(window.Reveal);
      } else {
        window.Reveal.on("ready", function () {
          wire(window.Reveal);
        });
      }
    } else {
      setTimeout(waitForReveal, 20);
    }
  }
  waitForReveal();
})();
