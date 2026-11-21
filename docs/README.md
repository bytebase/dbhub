# DBHub Documentation

See the [branding guide](../BRANDING.md) for the Aurora Bloom logo variants, the Zinc interface palette, and the asset update workflow.

Install the [Mintlify CLI](https://www.npmjs.com/package/mint) to preview documentation locally:

```bash
npm i -g mint
```

Run the following command at the root of your documentation (where `docs.json` is located):

```bash
cd docs
mint dev
```

## Featured blog post

The landing-page pill links to the newest post with `featured: true`, sorted by
its `date` in `YYYY-MM-DD` format. Omit `featured` or set it to `false` for other
posts. Older featured posts can stay marked; the newest date wins. If no posts
are featured, the pill is hidden.

```yaml
title: "DBHub 2.0.0"
date: "2026-11-21"
featured: true
```

After changing blog frontmatter, run `pnpm sync:featured-blog` from the repository
root and commit the generated `docs/snippets/featured-blog.jsx` with the post.
CI checks that the snippet matches the frontmatter. The link is rendered as
static HTML, with no browser requests to discover posts.
