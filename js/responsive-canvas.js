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
  // hidden depending on data) directly above the tab bar, but the tab bar's
  // `top` in CSS assumes a fixed content height. When fewer slots are
  // visible than assumed, that leaves a big empty gap before the tab bar;
  // when more content grows past it, it would overlap instead. This measures
  // the actual bottom edge of whichever content is visible and repositions
  // the tab bar (and the page's min-height) right after it.
  function positionMobileTabbar(config) {
    var tabbar = document.querySelector(config.tabbarSelector || ".m-app-tabbar");
    var mobilePage = document.getElementById(config.mobilePageId);
    if (!tabbar || !mobilePage) return;

    var bottomPx = 0;
    (config.contentSelectors || []).forEach(function (selector) {
      var el = document.querySelector(selector);
      if (el && !el.hidden) {
        bottomPx = Math.max(bottomPx, el.offsetTop + el.offsetHeight);
      }
    });
    if (bottomPx === 0) return;

    var gapRem = config.gapRem || 1.2;
    var tabbarHeightRem = config.tabbarHeightRem || 9.4;
    var tabbarTopRem = bottomPx / 10 + gapRem;
    tabbar.style.top = tabbarTopRem + "rem";
    mobilePage.style.minHeight = tabbarTopRem + tabbarHeightRem + "rem";
  }

  window.initResponsiveCanvas = initResponsiveCanvas;
  window.positionMobileTabbar = positionMobileTabbar;
})();
