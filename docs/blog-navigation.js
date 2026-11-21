function linkBlogBreadcrumb() {
  if (!window.location.pathname.startsWith("/blog/")) return;

  const eyebrow = document.querySelector("#header .eyebrow");
  if (!eyebrow || eyebrow.textContent.trim() !== "Blog" || eyebrow.querySelector("a")) return;

  const link = document.createElement("a");
  link.href = "/blog";
  link.className = "dbhub-blog-breadcrumb";
  link.textContent = "← Blog";
  eyebrow.replaceChildren(link);
}

linkBlogBreadcrumb();
new MutationObserver(linkBlogBreadcrumb).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
