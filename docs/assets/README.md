# Data Pulse Visual Assets

This directory contains GitHub-renderable SVG assets used by the README and
architecture documentation.

## Files

| Path | Purpose |
| --- | --- |
| `hero-data-pulse.svg` | Primary README hero for the Data Pulse platform story. |
| `architecture-isometric.svg` | Isometric architecture visual used in `docs/ARCHITECTURE.md`. |
| `icons/*.svg` | Small reusable icons for platform capabilities and package areas. |

## Style

- Use restrained enterprise SaaS colors: deep navy, slate, blue, teal, amber,
  and white.
- Prefer simple geometric shapes that remain legible in GitHub Markdown.
- Keep SVG text short and accessible with `title` and `desc` elements.
- Avoid raster-only assets for diagrams so the docs remain lightweight and easy
  to review.

## Naming

- Use lowercase kebab-case.
- Use capability names for icons, for example `tenant-isolation.svg`.
- Add new assets only when they support a documented section or diagram.
