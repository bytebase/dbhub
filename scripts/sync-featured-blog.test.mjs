import assert from "node:assert/strict";
import test from "node:test";
import { renderFeaturedBlog, selectFeaturedPost } from "./sync-featured-blog.mjs";

const post = (slug, date, featured = true) => ({
  slug,
  content: `---\ntitle: "${slug}"\ndate: "${date}"\nfeatured: ${featured}\n---\n`,
});

test("selects the latest featured post regardless of file order", () => {
  const selected = selectFeaturedPost([
    post("old", "2026-01-01"),
    post("not-featured", "2026-12-01", false),
    post("latest", "2026-11-21"),
  ]);
  assert.equal(selected.slug, "latest");
  assert.match(renderFeaturedBlog(selected), /Nov 21, 2026/);
  assert.match(renderFeaturedBlog(selected), /\/blog\/latest/);
});

test("uses the slug to resolve equal dates consistently", () => {
  assert.equal(selectFeaturedPost([post("b", "2026-11-21"), post("a", "2026-11-21")]).slug, "a");
});

test("renders nothing when no post is featured", () => {
  assert.equal(selectFeaturedPost([post("regular", "2026-11-21", false)]), undefined);
  assert.match(renderFeaturedBlog(undefined), /\(\) => null/);
});

test("rejects quoted booleans and invalid publication dates", () => {
  assert.throws(() => selectFeaturedPost([post("bad", "2026-11-21", '"true"')]), /boolean/);
  assert.throws(() => selectFeaturedPost([post("bad", "2026-02-30")]), /valid date/);
});

test("keeps title punctuation inside a string expression", () => {
  const title = 'DBHub: "new" <release> {2.0}';
  assert.ok(renderFeaturedBlog({ slug: "release", title, date: "2026-11-21" }).includes(`{${JSON.stringify(title)}}`));
});
