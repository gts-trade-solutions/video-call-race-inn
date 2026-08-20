# Navbar logos

Two files, dropped in this folder. No code change is needed — the navbar picks
them up, and hides the slot while a file is missing rather than showing a broken
image.

| File                          | Where it appears           |
| ----------------------------- | -------------------------- |
| `public/logo-bluderma.png`    | navbar, left               |
| `public/logo-madenkorea.png`  | navbar, right (from ~640px)|

Both are drawn on a white plate, so artwork on a white or transparent
background is what you want. They are sized by height (20px on phones, 28px
above), so any width works — wide wordmarks are fine.

PNG with transparency is ideal. SVG is not served here: uploads and brand art
share a route that blocks SVG, since an SVG can carry script.
