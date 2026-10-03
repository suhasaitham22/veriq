// landing.js — scroll reveals, counters, smooth nav. No framework.
(() => {
  // Reveal-on-scroll
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target); }
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  // Animated counters
  const cio = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      cio.unobserve(e.target);
      const end = parseInt(e.target.dataset.count || "0", 10);
      const t0 = performance.now(), dur = 1200;
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        e.target.textContent = String(Math.round(end * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }, { threshold: 0.6 });
  document.querySelectorAll("[data-count]").forEach((el) => cio.observe(el));

  // Subtle hero parallax
  const hero = document.querySelector(".hero-inner");
  if (hero && matchMedia("(pointer:fine)").matches) {
    addEventListener("scroll", () => {
      const y = Math.min(scrollY, 600);
      hero.style.transform = `translateY(${y * 0.12}px)`;
      hero.style.opacity = String(1 - y / 900);
    }, { passive: true });
  }
})();
