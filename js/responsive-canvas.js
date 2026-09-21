(function () {
  "use strict";

  // The app-*.html screens are built as two fixed-size Figma canvases: a
  // 1440px desktop layout and a 412px (Google Pixel width) mobile layout,
  // switched via a CSS media query at 900px. Neither canvas reflows on its
  // own (everything is absolutely positioned in rem), so outside each
  // canvas's own design width the content either overflows or clips.
  // This scales whichever canvas is visible to fit the real viewport: the
  // desktop canvas grows/shrinks to match anything >= 900px (so it also
  // fills wide monitors or a < 100% browser zoom instead of sitting tiny
  // at a fixed 1440px with empty space around it — same fix as
  // js/game.js), and the mobile canvas scales below 412px (real phones,
  // almost all narrower than that).
  var DESIGN_WIDTH = 1440;
  var MOBILE_DESIGN_WIDTH = 412;
  var BREAKPOINT = 900;

  function scaleCanvas(page, wrapper, designWidth, width) {
    var scale = width / designWidth;
    page.style.transform = "scale(" + scale + ")";
    wrapper.style.height = Math.round(page.scrollHeight * scale) + "px";
  }

  function resetCanvas(page, wrapper) {
    page.style.transform = "";
    wrapper.style.height = "";
  }

  function initResponsiveCanvas(config) {
    var desktopPage = document.getElementById(config.desktopPageId);
    var desktopWrapper = document.querySelector(config.desktopWrapperSelector);
    var mobilePage = document.getElementById(config.mobilePageId);
    var mobileWrapper = document.querySelector(config.mobileWrapperSelector);

    function applyScale() {
      var width = window.innerWidth;

      if (width >= BREAKPOINT) {
        resetCanvas(mobilePage, mobileWrapper);
        scaleCanvas(desktopPage, desktopWrapper, DESIGN_WIDTH, width);
      } else {
        resetCanvas(desktopPage, desktopWrapper);
        if (width >= MOBILE_DESIGN_WIDTH) {
          resetCanvas(mobilePage, mobileWrapper);
        } else {
          scaleCanvas(mobilePage, mobileWrapper, MOBILE_DESIGN_WIDTH, width);
        }
      }
    }

    window.addEventListener("resize", applyScale);
    applyScale();
    return applyScale;
  }

  // Several mobile screens render a variable number of cards/slots (some
  // hidden depending on data); the page's static min-height in CSS assumes
  // a fixed content height, which would leave a gap when fewer slots are
  // visible than assumed, or overlap when more content grows past it. This
  // measures the actual bottom edge of whichever content is visible and
  // sets the page's min-height right after it. The mobile tab bar itself is
  // `position:fixed` (css/app-shell.css), pinned to the real viewport, not
  // to this content — each .m-app-* page's own `padding-bottom` reserves
  // its footprint instead, so it's untouched here.
  function positionMobileTabbar(config) {
    var mobilePage = document.getElementById(config.mobilePageId);
    if (!mobilePage) return;

    var bottomPx = 0;
    (config.contentSelectors || []).forEach(function (selector) {
      var el = document.querySelector(selector);
      if (el && !el.hidden) {
        bottomPx = Math.max(bottomPx, el.offsetTop + el.offsetHeight);
      }
    });
    if (bottomPx === 0) return;

    var gapRem = config.gapRem || 1.2;
    mobilePage.style.minHeight = bottomPx / 10 + gapRem + "rem";
  }

  window.initResponsiveCanvas = initResponsiveCanvas;
  window.positionMobileTabbar = positionMobileTabbar;
})();
