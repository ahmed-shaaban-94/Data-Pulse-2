# Data Pulse Visual Assets

This directory contains GitHub-renderable SVG assets used by the README and
architecture documentation.

## Files

| Path | Purpose |
| --- | --- |
| `hero-data-pulse.svg` | Primary README hero for the Data Pulse platform story. |
| `pulse-signature.svg` | Platform identity waveform used as a subtle visual throughline in the README. |
| `architecture-isometric.svg` | Isometric architecture visual used in `docs/ARCHITECTURE.md`. |
| `icons/*.svg` | Small reusable icons for platform capabilities and package areas. |

## Brand assets

Product-vision and brand-identity imagery. These are raster PNGs representing
the Retail Tower OS external product brand — they are **not** architecture
diagrams or feature screenshots.

| Path | Purpose |
| --- | --- |
| `brand/retail-tower-os-hero-exterior.png` | Approved Retail Tower OS exterior hero — product-vision image. |
| `brand/retail-tower-os-command-room.png` | Approved Retail Tower OS interior command-room — operations-vision image. |

See [`docs/brand/retail-tower-os.md`](../brand/retail-tower-os.md) for the full brand identity record,
scope notes, and usage guidelines.

> **PNG exception**: Brand imagery may be raster PNG when it is approved
> product-vision artwork that cannot be represented as SVG. Architecture
> diagrams and capability icons should remain SVG where possible for
> lightweight, reviewable documentation. Brand imagery is not the same
> as implementation architecture diagrams.

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
