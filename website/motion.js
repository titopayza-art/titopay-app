// Scroll-triggered motion for the public pages.
// Content is fully visible without this file; it only hides elements that start
// below the fold, and reveals them as they scroll into view.
(function titoMotion() {
  "use strict";
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const root = document.documentElement;
  const fold = window.innerHeight * 0.92;
  const below = (el) => el.getBoundingClientRect().top > fold;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("tm-in");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });

  // The payment section runs its own staggered sequence (see motion.css).
  document.querySelectorAll(".pay-methods, .speed-story, .chat-story").forEach((section) => {
    if (below(section)) observer.observe(section);
    else section.classList.add("tm-in");
  });

  // Groups whose children reveal one after another.
  const groups = [
    ".info-grid", ".support-faqs", ".support-socials", ".editorial-actions",
    ".fee-table tbody", ".start-actions"
  ];
  groups.forEach((selector) => {
    document.querySelectorAll(selector).forEach((group) => {
      Array.from(group.children).forEach((child, index) => {
        if (!below(child)) return;
        child.classList.add("tm-reveal");
        child.style.setProperty("--tm-delay", Math.min(index, 8) * 0.07 + "s");
        observer.observe(child);
      });
    });
  });

  // Single blocks, with a direction where it reads well.
  const singles = [
    [".editorial-heading, .section-head, .page-hero .container, .start-today .container > h2, .start-today .container > p, .security-story h2", ""],
    [".personal-app-screen, .product-phone--personal", "tm-reveal-left"],
    [".business-app-screen, .product-phone--business", "tm-reveal-right"],
    [".real-payments-photo, .business-layout figure, .about-photo, .split-media", "tm-reveal-zoom"],
    [".policy-section, .careers-role, .newsroom-item, .contact-card", ""]
  ];
  singles.forEach(([selector, variant]) => {
    document.querySelectorAll(selector).forEach((el) => {
      if (el.classList.contains("tm-reveal") || !below(el)) return;
      el.classList.add("tm-reveal");
      if (variant) el.classList.add(variant);
      observer.observe(el);
    });
  });

  // Content at the very end of a page can be too close to the bottom edge to
  // cross the observer threshold. Once the visitor reaches the bottom, show it all.
  function revealRest() {
    if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 4) return;
    document.querySelectorAll(".tm-reveal:not(.tm-in), .pay-methods:not(.tm-in), .speed-story:not(.tm-in), .chat-story:not(.tm-in)").forEach((el) => {
      el.classList.add("tm-in");
      observer.unobserve(el);
    });
  }
  window.addEventListener("scroll", revealRest, { passive: true });

  root.classList.add("tm-ready");
})();
